/**
 * #2245 barrier tests for `cloneAgent` (amendments 3 and 4b). Ordering is forced by holding an authority
 * anchor from a second connection, never by sleeping: the clone pre-reads its plan, queues on the anchor,
 * the holder changes the world and commits, and the clone must then re-decide on what it finds.
 */
import { Client } from 'pg';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Prisma } from '../../generated/prisma/index.js';
import { db } from '../../integrations/db/client.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { cleanDb } from '../../test/helpers.js';
import { waitForLockWaitersOfType } from '../../test/lockWait.js';
import { generateId } from '../id.js';
import { cloneAgent } from './cloneAgent.js';

let orgA: { id: string; urn: string };
let orgB: { id: string; urn: string };
let adminA: string;
let adminB: string;

const ctxFor = (userId: string): Context => ({ db, userId, roles: ['READER'] }) as Context;
const M = resolvers.Mutation as Record<string, (...a: unknown[]) => Promise<any>>;
const outcome = <T>(p: Promise<T>) => p.then((value) => ({ value, code: undefined as string | undefined }), (e: { extensions?: { code?: string; reason?: string }; message?: string }) => ({ value: undefined, code: e.extensions?.reason ?? e.extensions?.code ?? e.message }));

async function user(tag: string) {
  const id = generateId();
  await db.user.create({ data: { id, email: `${tag}-${id}@x.test`, handle: `${tag}${id.slice(-6)}`.toLowerCase() } });
  return id;
}
const org = async (urn: string) => {
  const id = generateId();
  await db.organization.create({ data: { id, name: urn, urn } });
  return { id, urn };
};

async function sourceAgent(o: { id: string; urn: string }, visibility: 'PUBLIC' | 'ORGANIZATION', slug = 'src') {
  const memId = generateId();
  await db.memory.create({ data: { id: memId, organizationId: o.id, urn: `${o.urn}:${slug}-system`, name: `${slug} System`, class: 'system', acceptsUploads: false } as never });
  const id = generateId();
  await db.agent.create({ data: { id, organizationId: o.id, urn: `${o.urn}:${slug}`, name: slug, description: 'old', systemMemoryId: memId, visibility } });
  const nodes = [] as Array<{ id: string }>;
  for (const loc of ['a', 'b']) nodes.push(await db.node.create({ data: { id: generateId(), memoryId: memId, loc, name: loc, nodeType: 'page', content: 'v1' } as never }));
  const edge = await db.edge.create({ data: { id: generateId(), memoryId: memId, sourceId: nodes[0].id, targetId: nodes[1].id, loc: 'a/e-b', name: 'e' } as never });
  return { id, memId, urn: `${o.urn}:${slug}`, nodes, edge };
}

const counts = async () => [await db.agent.count(), await db.memory.count(), await db.node.count(), await db.agentCloneAudit.count()];

/**
 * Hold `anchor` exclusively from another connection, start `start()` so it queues on it, run `change` in the
 * holder's transaction and commit it, then let the queued operation proceed.
 */
async function racing<T>(anchor: { kind: string; id: string }, change: (tx: Prisma.TransactionClient) => Promise<void>, start: () => Promise<T>) {
  let release!: () => void;
  let held!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const heldP = new Promise<void>((r) => { held = r; });
  const holder = db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'authorization:' + anchor.kind}), hashtext(${anchor.id}))`;
    held();
    await gate;
    await change(tx);
  }, { timeout: 30_000 });
  await heldP;
  const op = outcome(start());
  try {
    await waitForLockWaitersOfType(db, 'advisory', 1);
    release();
    await holder;
  } finally {
    release();
    await Promise.allSettled([holder]);
  }
  return op;
}

beforeEach(async () => {
  await cleanDb(db);
  orgA = await org('rc-a');
  orgB = await org('rc-b');
  adminA = await user('adma');
  adminB = await user('admb');
  await db.orgMember.create({ data: { organizationId: orgA.id, userId: adminA, role: 'ADMIN' } });
  await db.orgMember.create({ data: { organizationId: orgB.id, userId: adminB, role: 'ADMIN' } });
});

const run = (userId: string, src: { urn: string }, target: { urn: string }, extra: Record<string, unknown> = {}) =>
  () => M.cloneAgent(null, { source: src.urn, target: target.urn, ...extra }, ctxFor(userId));

describe('authority changes while the clone is queued on its anchors', () => {
  it('a cloner demoted before the anchors are granted is refused and nothing is written', async () => {
    const src = await sourceAgent(orgA, 'PUBLIC');
    const before = await counts();
    const res = await racing({ kind: 'org', id: orgB.id },
      (tx) => tx.$executeRaw`UPDATE org_members SET role = 'READER' WHERE user_id = ${adminB}`.then(() => undefined),
      run(adminB, src, orgB));
    expect(res.code).toBe('FORBIDDEN');
    expect(await counts()).toEqual(before);
  });

  it('a source retired meanwhile is refused and nothing is written', async () => {
    const src = await sourceAgent(orgA, 'PUBLIC');
    const before = await counts();
    const res = await racing({ kind: 'agent', id: src.id },
      (tx) => tx.$executeRaw`UPDATE agents SET deleted_at = now() WHERE id = ${src.id}`.then(() => undefined),
      run(adminB, src, orgB));
    expect(res.value).toBeUndefined();
    expect(await counts()).toEqual(before);
  });

  it('a source transferred to another owner meanwhile is decided on its new owner', async () => {
    const src = await sourceAgent(orgA, 'ORGANIZATION');
    const before = await counts();
    const res = await racing({ kind: 'agent', id: src.id },
      (tx) => tx.$executeRaw`UPDATE agents SET organization_id = ${orgB.id} WHERE id = ${src.id}`.then(() => undefined),
      run(adminA, src, orgA));
    expect(res.value).toBeUndefined();
    expect(await counts()).toEqual(before);
  });

  it('a base changed meanwhile is cloned as it now stands', async () => {
    const src = await sourceAgent(orgA, 'PUBLIC');
    const newBase = await sourceAgent(orgA, 'PUBLIC', 'newbase');
    await db.agentOrgGrant.create({ data: { orgId: orgB.id, agentId: newBase.id, activatedAt: new Date(Date.now() - 1000) } });
    const res = await racing({ kind: 'agent', id: src.id },
      (tx) => tx.$executeRaw`UPDATE agents SET extends_agent_id = ${newBase.id} WHERE id = ${src.id}`.then(() => undefined),
      run(adminB, src, orgB));
    expect(res.code).toBeUndefined();
    expect(res.value.extendsAgentId).toBe(newBase.id);
  });

  it('an import removed meanwhile is not recreated', async () => {
    const src = await sourceAgent(orgA, 'PUBLIC');
    const dep = await sourceAgent(orgA, 'PUBLIC', 'dep');
    await db.agentOrgGrant.create({ data: { orgId: orgA.id, agentId: dep.id, activatedAt: new Date(Date.now() - 1000) } });
    await db.agentImport.create({ data: { parentAgentId: src.id, importedAgentId: dep.id, position: 100, agentOrgGrantOrgId: orgA.id, agentOrgGrantAgentId: dep.id } });
    const res = await racing({ kind: 'agent', id: src.id },
      (tx) => tx.$executeRaw`DELETE FROM agent_imports WHERE parent_agent_id = ${src.id}`.then(() => undefined),
      run(adminB, src, orgB));
    expect(res.code).toBeUndefined();
    expect(await db.agentImport.count({ where: { parentAgentId: res.value.id } })).toBe(0);
  });
});

describe('revoke versus subscribe, both orders', () => {
  async function fixture() {
    const src = await sourceAgent(orgA, 'PUBLIC');
    const dep = await sourceAgent(orgA, 'PUBLIC', 'dep');
    await db.agentOrgGrant.create({ data: { orgId: orgA.id, agentId: dep.id, activatedAt: new Date(Date.now() - 1000) } });
    await db.agentImport.create({ data: { parentAgentId: src.id, importedAgentId: dep.id, position: 100, agentOrgGrantOrgId: orgA.id, agentOrgGrantAgentId: dep.id } });
    return { src, dep };
  }
  const revoke = (agentRef: string) => M.revokeAgentOrgGrant(null, { agentRef, orgRef: orgB.urn }, ctxFor(adminB));

  it('the clone first: the clone holds a licensed import, the revoke then lands', async () => {
    const { src, dep } = await fixture();
    const out = await M.cloneAgent(null, { source: src.urn, target: orgB.urn }, ctxFor(adminB));
    await revoke(dep.urn);
    expect(await db.agentImport.count({ where: { parentAgentId: out.id } })).toBe(1);
    expect((await db.agentOrgGrant.findUniqueOrThrow({ where: { orgId_agentId: { orgId: orgB.id, agentId: dep.id } } })).revokedAt).not.toBeNull();
  });

  it('the revoke first: the clone refuses an inactive grant and writes nothing', async () => {
    const { src, dep } = await fixture();
    await db.agentOrgGrant.create({ data: { orgId: orgB.id, agentId: dep.id, activatedAt: new Date(Date.now() - 2000) } });
    await revoke(dep.urn);
    const before = await counts();
    const res = await outcome(M.cloneAgent(null, { source: src.urn, target: orgB.urn }, ctxFor(adminB)));
    expect(res.code).toBe('CLONE_IMPORT_UNUSABLE');
    expect(await counts()).toEqual(before);
  });

  it('queued together behind one anchor, the outcome is one of the two serial ones', async () => {
    const { src, dep } = await fixture();
    await db.agentOrgGrant.create({ data: { orgId: orgB.id, agentId: dep.id, activatedAt: new Date(Date.now() - 2000) } });
    const [cloneRes, revokeRes] = await racing({ kind: 'org', id: orgB.id }, async () => undefined, async () => {
      const c = outcome(M.cloneAgent(null, { source: src.urn, target: orgB.urn }, ctxFor(adminB)));
      const r = outcome(revoke(dep.urn));
      return Promise.all([c, r]);
    }).then((r) => (r as { value: any }).value);
    expect(revokeRes.code).toBeUndefined();
    if (cloneRes.code === undefined) expect(await db.agentImport.count({ where: { parentAgentId: cloneRes.value.id } })).toBe(1);
    else { expect(cloneRes.code).toBe('CLONE_IMPORT_UNUSABLE'); expect(await db.agentCloneAudit.count()).toBe(0); }
    expect((await db.agentOrgGrant.findUniqueOrThrow({ where: { orgId_agentId: { orgId: orgB.id, agentId: dep.id } } })).revokedAt).not.toBeNull();
  });
});

describe('a write that commits between the copy and the validation read', () => {
  const hooked = (src: { urn: string }, hook: (attempt: number) => Promise<void>) =>
    cloneAgent(ctxFor(adminB), { source: src.urn, target: orgB.urn }, { afterCopy: hook });

  it('a node edited once: the clone retries and copies the new revision', async () => {
    const src = await sourceAgent(orgA, 'PUBLIC');
    const out = await hooked(src, async (attempt) => {
      if (attempt === 0) await db.$executeRaw`UPDATE nodes SET content = 'v2', rev_seq = rev_seq + 1, revision_content_hash = 'refresh' WHERE id = ${src.nodes[0].id}`;
    });
    expect((await db.node.findFirstOrThrow({ where: { memoryId: out.systemMemoryId!, loc: 'a' } })).content).toBe('v2');
    expect(await db.agentCloneAudit.count()).toBe(1);
    expect(await db.agent.count({ where: { clonedFromAgentRef: src.urn } })).toBe(1);
  });

  it('an edge renamed once: the clone retries', async () => {
    const src = await sourceAgent(orgA, 'PUBLIC');
    const out = await hooked(src, async (attempt) => {
      if (attempt === 0) await db.$executeRaw`UPDATE edges SET description = 'new' WHERE id = ${src.edge.id}`;
    });
    expect((await db.edge.findFirstOrThrow({ where: { memoryId: out.systemMemoryId! } })).description).toBe('new');
  });

  it('an import re-positioned once: the clone retries and keeps the new position', async () => {
    const src = await sourceAgent(orgA, 'PUBLIC');
    const dep = await sourceAgent(orgA, 'PUBLIC', 'dep');
    await db.agentOrgGrant.create({ data: { orgId: orgA.id, agentId: dep.id, activatedAt: new Date(Date.now() - 1000) } });
    await db.agentImport.create({ data: { parentAgentId: src.id, importedAgentId: dep.id, position: 100, agentOrgGrantOrgId: orgA.id, agentOrgGrantAgentId: dep.id } });
    const out = await hooked(src, async (attempt) => {
      if (attempt === 0) await db.$executeRaw`UPDATE agent_imports SET position = 200 WHERE parent_agent_id = ${src.id}`;
    });
    expect((await db.agentImport.findFirstOrThrow({ where: { parentAgentId: out.id } })).position).toBe(200);
  });

  it('retry exhaustion: typed retryable conflict and zero rows', async () => {
    const src = await sourceAgent(orgA, 'PUBLIC');
    const before = await counts();
    let n = 0;
    const res = await outcome(hooked(src, async () => {
      await db.$executeRaw`UPDATE nodes SET content = ${'x' + ++n} WHERE id = ${src.nodes[0].id}`;
    }));
    expect(res.code).toBe('AGENT_CLONE_SOURCE_CHANGED');
    expect(n).toBe(3);
    expect(await counts()).toEqual(before);
  });

  it('an UPDATE of the source agent row waits for the clone and the clone keeps the old row', async () => {
    const src = await sourceAgent(orgA, 'PUBLIC');
    const writer = new Client({ connectionString: process.env.DATABASE_URL });
    await writer.connect();
    let update: Promise<unknown> | undefined;
    try {
      const out = await hooked(src, async () => {
        update = writer.query('UPDATE agents SET description = $1 WHERE id = $2', ['edited', src.id]);
        for (let i = 0; i < 300; i++) {
          const [{ n }] = await db.$queryRaw<Array<{ n: number }>>`
            SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE 'UPDATE agents%'`;
          if (n > 0) return;
          await new Promise((r) => setTimeout(r, 10));
        }
        throw new Error('the agent UPDATE never queued behind the clone');
      });
      await update;
      expect(out.description).toBe('old');
      expect((await db.agent.findUniqueOrThrow({ where: { id: src.id } })).description).toBe('edited');
    } finally {
      await writer.end();
    }
  });
});

describe('writers that hold the channel-host key, racing the clone (amendment 4b)', () => {
  it('edge writes and the clone never deadlock, in either start order', async () => {
    for (let round = 0; round < 4; round++) {
      const src = await sourceAgent(orgA, 'PUBLIC', `r${round}`);
      const writes = Array.from({ length: 3 }, (_, i) =>
        outcome(M.createEdge(null, { sourceRef: src.nodes[1].id, targetRef: src.nodes[0].id, name: `w${round}${i}` }, ctxFor(adminA))));
      const cloneP = outcome(M.cloneAgent(null, { source: src.urn, target: orgB.urn, slug: `c${round}` }, ctxFor(adminB)));
      if (round % 2) await Promise.all(writes);
      const all = await Promise.all([cloneP, ...writes]);
      for (const r of all) expect(String(r.code ?? '')).not.toMatch(/deadlock|40P01/i);
    }
  });
});

describe('review of 00e3a4c9 (Andi, Cloe, Dara): the lock inversion, the stale target URN, the transient edit', () => {
  it('a setAgentBase-ordered writer (graph lock, then the source row FOR UPDATE) and the clone do not deadlock', async () => {
    const src = await sourceAgent(orgA, 'PUBLIC');
    const writer = new Client({ connectionString: process.env.DATABASE_URL });
    await writer.connect();
    let cloneP: Promise<{ value: any; code: string | undefined }> | undefined;
    try {
      await writer.query('BEGIN');
      await writer.query(`SELECT pg_advisory_xact_lock(hashtext('agent-extends-base'))`);
      cloneP = outcome(M.cloneAgent(null, { source: src.urn, target: orgB.urn }, ctxFor(adminB)));
      // The clone is queued on the graph lock. Before the fix it already held the source row FOR SHARE here,
      // so this FOR UPDATE closed a cycle (40P01); now it holds no row yet and the writer gets through.
      await waitForLockWaitersOfType(db, 'advisory', 1);
      await writer.query('SELECT id FROM agents WHERE id = $1 FOR UPDATE', [src.id]);
      await writer.query('COMMIT');
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined);
      await writer.end();
    }
    const r = await cloneP!;
    expect(r.code).toBeUndefined();
    expect(await db.agentCloneAudit.count()).toBe(1);
  });

  it('a target organization renamed while the clone is queued: the new Agent takes the new URN', async () => {
    const src = await sourceAgent(orgA, 'PUBLIC');
    const r = await racing({ kind: 'org', id: orgB.id },
      async (tx) => { await tx.$executeRaw`UPDATE organizations SET urn = 'rc-b-renamed' WHERE id = ${orgB.id}`; },
      run(adminB, src, orgB, { slug: 'moved' }));
    expect(r.code).toBeUndefined();
    expect(r.value.urn).toBe('rc-b-renamed:moved');
  });

  it('a node edited and put back between the reads still differs: the clone retries', async () => {
    const src = await sourceAgent(orgA, 'PUBLIC');
    const attempts: number[] = [];
    const out = await cloneAgent(ctxFor(adminB), { source: src.urn, target: orgB.urn }, {
      afterCopy: async (attempt) => {
        attempts.push(attempt);
        if (attempt === 0) {
          await db.$executeRaw`UPDATE nodes SET name = 'transient' WHERE id = ${src.nodes[0].id}`;
          await db.$executeRaw`UPDATE nodes SET name = 'a' WHERE id = ${src.nodes[0].id}`;
        }
      },
    });
    expect(attempts).toEqual([0, 1]);
    expect(await db.agent.count({ where: { id: out.id } })).toBe(1);
  });
});
