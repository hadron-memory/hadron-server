/**
 * #1885 (cor:dmo:050:14) — an Agent may extend one base Agent: the field, the
 * set/change/clear mutation, and its refusals. The read through the child
 * (S1–S3, S7) is the follow-up slice; retiring a base with a live child (S8)
 * lands on #1886's shared predicate.
 *
 * Pinned here: the base is set, changed and cleared only by whoever manages
 * the child; one base; no cycle (S4); at most 4 Agents in a chain, for the
 * child and for every Agent that already extends it (S5, Vera's build note);
 * the grant a cross-organisation include needs (S6); and the database
 * backstop, which refuses the same shapes for a write that bypasses the
 * resolver, and serializes two changes that would together close a cycle.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAgentOrgGrant, createDbAgentSubscription } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { writeAgentBase } from '../../../lib/agentBase.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const setBase = (ref: string, baseRef: string | null, c: Context) =>
  resolvers.Mutation.setAgentBase({}, { ref, baseRef }, c);

/** A typed refusal: a GraphQLError's extensions.code, or an entity-not-found error's own code. */
async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  const err = await p.then(() => null, (e: { code?: string; extensions?: { code?: string } }) => e);
  expect(err, `expected a ${code} refusal`).not.toBeNull();
  expect(err!.extensions?.code ?? err!.code).toBe(code);
}

const ctxOf = (userId: string): Context => ({ db, userId, roles: ['READER'] });

let n: number;
let orgA: { id: string; urn: string };
let orgB: { id: string; urn: string };
let adminA: string;
let memberA: string;
let adminB: string;
let ana: string;
let ben: string;

async function user(handle: string): Promise<string> {
  const u = await db.user.create({ data: { id: generateId(), name: handle, handle: `${handle}-${n}`, roles: ['READER'] } });
  return u.id;
}

async function orgAgent(
  org: { id: string; urn: string },
  slug: string,
  visibility: 'PUBLIC' | 'ORGANIZATION' | 'PERSONAL' = 'ORGANIZATION',
): Promise<string> {
  const a = await db.agent.create({ data: { organizationId: org.id, name: slug, urn: `${org.urn}:${slug}`, visibility } });
  return a.id;
}

async function userAgent(ownerUserId: string, slug: string): Promise<string> {
  const a = await db.agent.create({ data: { ownerUserId, name: slug, urn: `u${n}-${slug}:${slug}`, visibility: 'PERSONAL' } });
  return a.id;
}

const baseOf = async (id: string) => (await db.agent.findUniqueOrThrow({ where: { id } })).extendsAgentId;

/** Link without the resolver, for building a fixture chain quickly (the trigger still checks it). */
const link = (childId: string, baseId: string | null) => db.agent.update({ where: { id: childId }, data: { extendsAgentId: baseId } });

beforeEach(async () => {
  await cleanDb(db);
  n = Math.floor(Math.random() * 1_000_000);
  orgA = await db.organization.create({ data: { name: 'A', urn: `base-a-${n}.example` }, select: { id: true, urn: true } });
  orgB = await db.organization.create({ data: { name: 'B', urn: `base-b-${n}.example` }, select: { id: true, urn: true } });
  adminA = await user('admin-a');
  memberA = await user('member-a');
  adminB = await user('admin-b');
  ana = await user('ana');
  ben = await user('ben');
  await db.orgMember.create({ data: { organizationId: orgA.id, userId: adminA, role: 'ADMIN' } });
  await db.orgMember.create({ data: { organizationId: orgA.id, userId: memberA, role: 'READER' } });
  await db.orgMember.create({ data: { organizationId: orgB.id, userId: adminB, role: 'ADMIN' } });
});

describe('set, change and clear a base (cor:dmo:050:14)', () => {
  it('sets a same-org base, exposes it on the Agent, and provisions the org grant', async () => {
    const engineer = await orgAgent(orgA, 'engineer');
    const backend = await orgAgent(orgA, 'backend-engineer');
    const out = await setBase(backend, engineer, ctxOf(adminA));
    expect(out.extendsAgentId).toBe(engineer);
    expect(await baseOf(backend)).toBe(engineer);
    const grant = await db.agentOrgGrant.findUnique({ where: { orgId_agentId: { orgId: orgA.id, agentId: engineer } } });
    expect(grant?.activatedAt).not.toBeNull();
  });

  it('accepts URNs, changes the base, and clears it with a null baseRef', async () => {
    const engineer = await orgAgent(orgA, 'engineer');
    const writer = await orgAgent(orgA, 'writer');
    const backend = await orgAgent(orgA, 'backend-engineer');
    await setBase(`hrn:agent:${orgA.urn}:backend-engineer`, `hrn:agent:${orgA.urn}:engineer`, ctxOf(adminA));
    expect(await baseOf(backend)).toBe(engineer);
    await setBase(backend, writer, ctxOf(adminA));
    expect(await baseOf(backend)).toBe(writer);
    const cleared = await setBase(backend, null, ctxOf(adminA));
    expect(cleared.extendsAgentId).toBeNull();
    expect(await baseOf(backend)).toBeNull();
  });

  it('only whoever manages the child may change its base, and managing the base is not enough', async () => {
    const engineer = await orgAgent(orgA, 'engineer', 'PUBLIC');
    const backend = await orgAgent(orgA, 'backend-engineer');
    await expect(setBase(backend, engineer, ctxOf(memberA))).rejects.toThrow();
    await expect(setBase(backend, engineer, ctxOf(adminB))).rejects.toThrow();
    expect(await baseOf(backend)).toBeNull();
    // adminB manages nothing in A; B's own Agent extending A's is B's call (below).
  });

  it('a retired base is not found, and nothing changes', async () => {
    const engineer = await orgAgent(orgA, 'engineer');
    const backend = await orgAgent(orgA, 'backend-engineer');
    await db.agent.update({ where: { id: engineer }, data: { deletedAt: new Date() } });
    await expectCode(setBase(backend, engineer, ctxOf(adminA)), 'AGENT_NOT_FOUND');
    expect(await baseOf(backend)).toBeNull();
  });
});

describe('the writer, under its locks', () => {
  it('refuses a base retired after the caller resolved it, with the typed refusal rather than the backstop\'s', async () => {
    // The resolver's ref lookup already skips retired Agents; this is the
    // window between that lookup and the locked write (a retirement racing it).
    const engineer = await orgAgent(orgA, 'engineer');
    const backend = await orgAgent(orgA, 'backend-engineer');
    await db.agent.update({ where: { id: engineer }, data: { deletedAt: new Date() } });
    await expectCode(
      db.$transaction((tx) => writeAgentBase(tx, { childId: backend, childRef: backend, baseId: engineer, baseRef: engineer, createdBy: adminA })),
      'AGENT_NOT_FOUND',
    );
    expect(await baseOf(backend)).toBeNull();
    // A user-owned child extending its owner's own Agent needs no grant, so
    // only the writer's own live check stands between it and a retired base.
    const mine = await userAgent(ana, 'helper');
    const myBase = await userAgent(ana, 'base');
    await db.agent.update({ where: { id: myBase }, data: { deletedAt: new Date() } });
    await expectCode(
      db.$transaction((tx) => writeAgentBase(tx, { childId: mine, childRef: mine, baseId: myBase, baseRef: myBase, createdBy: ana })),
      'AGENT_NOT_FOUND',
    );
    expect(await baseOf(mine)).toBeNull();
  });

  it('refuses a child retired after the caller resolved it', async () => {
    const engineer = await orgAgent(orgA, 'engineer');
    const backend = await orgAgent(orgA, 'backend-engineer');
    await db.agent.update({ where: { id: backend }, data: { deletedAt: new Date() } });
    await expectCode(
      db.$transaction((tx) => writeAgentBase(tx, { childId: backend, childRef: backend, baseId: engineer, baseRef: engineer, createdBy: adminA })),
      'AGENT_NOT_FOUND',
    );
    expect(await baseOf(backend)).toBeNull();
  });

  it('a no-op writes nothing and says so', async () => {
    const engineer = await orgAgent(orgA, 'engineer');
    const backend = await orgAgent(orgA, 'backend-engineer');
    await link(backend, engineer);
    const before = (await db.agent.findUniqueOrThrow({ where: { id: backend } })).updatedAt;
    const out = await db.$transaction((tx) => writeAgentBase(tx, { childId: backend, childRef: backend, baseId: engineer, baseRef: engineer, createdBy: adminA }));
    expect(out).toEqual({ agentId: backend, from: engineer, to: engineer, changed: false });
    expect((await db.agent.findUniqueOrThrow({ where: { id: backend } })).updatedAt).toEqual(before);
  });
});

describe('S4 — no cycles', () => {
  it('refuses an Agent extending itself', async () => {
    const engineer = await orgAgent(orgA, 'engineer');
    await expectCode(setBase(engineer, engineer, ctxOf(adminA)), 'AGENT_BASE_CYCLE');
    expect(await baseOf(engineer)).toBeNull();
  });

  it('refuses engineer extending go-engineer, which extends it through backend-engineer', async () => {
    const engineer = await orgAgent(orgA, 'engineer');
    const backend = await orgAgent(orgA, 'backend-engineer');
    const go = await orgAgent(orgA, 'go-engineer');
    await setBase(backend, engineer, ctxOf(adminA));
    await setBase(go, backend, ctxOf(adminA));
    await expectCode(setBase(engineer, go, ctxOf(adminA)), 'AGENT_BASE_CYCLE');
    expect(await baseOf(engineer)).toBeNull();
  });
});

describe('S5 — at most 4 Agents in a chain, counting every Agent that already extends the child', () => {
  let a: string, b: string, c: string, d: string;
  beforeEach(async () => {
    // A → B → C → D: A extends B, and so on.
    [a, b, c, d] = await Promise.all(['a', 'b', 'c', 'd'].map((s) => orgAgent(orgA, s)));
    await link(c, d);
    await link(b, c);
    await link(a, b);
  });

  it('refuses a base for D, the top of a full chain', async () => {
    const e = await orgAgent(orgA, 'e');
    await expectCode(setBase(d, e, ctxOf(adminA)), 'AGENT_BASE_CHAIN_TOO_LONG');
    expect(await baseOf(d)).toBeNull();
  });

  it('refuses a new Agent E extending A, the bottom of a full chain', async () => {
    const e = await orgAgent(orgA, 'e');
    await expectCode(setBase(e, a, ctxOf(adminA)), 'AGENT_BASE_CHAIN_TOO_LONG');
    expect(await baseOf(e)).toBeNull();
  });

  it('refuses giving a middle Agent a base when a descendant\'s chain would exceed 4, though its own would not', async () => {
    // K → L → M already; M gaining N → O makes K's chain K, L, M, N, O: 5.
    const [k, l, m, nn, o] = await Promise.all(['k', 'l', 'm', 'n', 'o'].map((s) => orgAgent(orgA, s)));
    await link(nn, o);
    await link(l, m);
    await link(k, l);
    await expectCode(setBase(m, nn, ctxOf(adminA)), 'AGENT_BASE_CHAIN_TOO_LONG');
    expect(await baseOf(m)).toBeNull();
    // A retired descendant no longer counts: with K retired, L, M, N, O is 4.
    await db.agent.update({ where: { id: k }, data: { deletedAt: new Date() } });
    await setBase(m, nn, ctxOf(adminA));
    expect(await baseOf(m)).toBe(nn);
  });

  it('allows exactly 4, and moving within the cap', async () => {
    const e = await orgAgent(orgA, 'e');
    // Re-basing B from C onto E shortens A's chain to A, B, E: allowed.
    await setBase(b, e, ctxOf(adminA));
    expect(await baseOf(b)).toBe(e);
  });
});

describe('S6 — extending needs the grant a cross-organisation include needs', () => {
  it('conceals another org\'s non-public Agent from an org with no grant', async () => {
    const engineer = await orgAgent(orgA, 'engineer', 'ORGANIZATION');
    const bAgent = await orgAgent(orgB, 'b-engineer');
    await expectCode(setBase(bAgent, engineer, ctxOf(adminB)), 'AGENT_NOT_FOUND');
    expect(await baseOf(bAgent)).toBeNull();
    expect(await db.agentOrgGrant.count({ where: { orgId: orgB.id } })).toBe(0);
  });

  it('asks for a subscription to another org\'s PUBLIC Agent, and never provisions one', async () => {
    const engineer = await orgAgent(orgA, 'engineer', 'PUBLIC');
    const bAgent = await orgAgent(orgB, 'b-engineer');
    await expectCode(setBase(bAgent, engineer, ctxOf(adminB)), 'AGENT_ORG_GRANT_REQUIRED');
    expect(await baseOf(bAgent)).toBeNull();
    expect(await db.agentOrgGrant.count({ where: { orgId: orgB.id } })).toBe(0);
  });

  it('allows it under the org\'s active grant, and refuses under a revoked one', async () => {
    const engineer = await orgAgent(orgA, 'engineer', 'PUBLIC');
    const bAgent = await orgAgent(orgB, 'b-engineer');
    const other = await orgAgent(orgB, 'b-other');
    await createDbAgentOrgGrant(db, orgB.id, engineer);
    await setBase(bAgent, engineer, ctxOf(adminB));
    expect(await baseOf(bAgent)).toBe(engineer);
    await db.agentOrgGrant.update({ where: { orgId_agentId: { orgId: orgB.id, agentId: engineer } }, data: { revokedAt: new Date() } });
    await expectCode(setBase(other, engineer, ctxOf(adminB)), 'AGENT_ORG_GRANT_INACTIVE');
    expect(await baseOf(other)).toBeNull();
  });

  it('a revoked same-org grant still refuses: provisioning never reactivates it', async () => {
    const engineer = await orgAgent(orgA, 'engineer');
    const backend = await orgAgent(orgA, 'backend-engineer');
    await createDbAgentOrgGrant(db, orgA.id, engineer, { revokedAt: new Date() });
    await expectCode(setBase(backend, engineer, ctxOf(adminA)), 'AGENT_ORG_GRANT_INACTIVE');
    expect(await baseOf(backend)).toBeNull();
    const grant = await db.agentOrgGrant.findUniqueOrThrow({ where: { orgId_agentId: { orgId: orgA.id, agentId: engineer } } });
    expect(grant.revokedAt).not.toBeNull();
  });

  it('a grant check comes before the chain: a concealed base never answers with a cycle or cap refusal', async () => {
    const engineer = await orgAgent(orgA, 'engineer', 'ORGANIZATION');
    const bAgent = await orgAgent(orgB, 'b-engineer');
    // Make a cycle refusal true too: A's engineer already extends B's Agent.
    await createDbAgentOrgGrant(db, orgA.id, bAgent);
    await setBase(engineer, bAgent, ctxOf(adminA));
    await expectCode(setBase(bAgent, engineer, ctxOf(adminB)), 'AGENT_NOT_FOUND');
  });
});

describe('a user-owned child', () => {
  it('extends its own owner\'s Agent with no subscription', async () => {
    const mine = await userAgent(ana, 'helper');
    const myBase = await userAgent(ana, 'base');
    await setBase(mine, myBase, ctxOf(ana));
    expect(await baseOf(mine)).toBe(myBase);
  });

  it('never finds another user\'s Agent', async () => {
    const mine = await userAgent(ana, 'helper');
    const bens = await userAgent(ben, 'base');
    await expectCode(setBase(mine, bens, ctxOf(ana)), 'AGENT_NOT_FOUND');
    expect(await baseOf(mine)).toBeNull();
  });

  it('needs its owner\'s active subscription to an organisation\'s PUBLIC Agent', async () => {
    const mine = await userAgent(ana, 'helper');
    const engineer = await orgAgent(orgA, 'engineer', 'PUBLIC');
    await expectCode(setBase(mine, engineer, ctxOf(ana)), 'AGENT_SUBSCRIPTION_REQUIRED');
    expect(await baseOf(mine)).toBeNull();
    await createDbAgentSubscription(db, ana, engineer);
    await setBase(mine, engineer, ctxOf(ana));
    expect(await baseOf(mine)).toBe(engineer);
  });

  it('an organisation\'s non-public Agent stays concealed from a user', async () => {
    const mine = await userAgent(ana, 'helper');
    const engineer = await orgAgent(orgA, 'engineer', 'ORGANIZATION');
    await expectCode(setBase(mine, engineer, ctxOf(ana)), 'AGENT_NOT_FOUND');
  });

  it('only its owner may change its base', async () => {
    const mine = await userAgent(ana, 'helper');
    const myBase = await userAgent(ana, 'base');
    await expect(setBase(mine, myBase, ctxOf(ben))).rejects.toThrow();
    expect(await baseOf(mine)).toBeNull();
  });
});

describe('the database backstop (agent_base_guard)', () => {
  it('refuses a cycle, a chain of 5 and a retired base written around the resolver', async () => {
    const [a, b, c, d, e] = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((s) => orgAgent(orgA, s)));
    await expect(link(a, a)).rejects.toThrow(/agent_base_no_cycle|cycle/);
    await link(a, b);
    await expect(link(b, a)).rejects.toThrow(/cycle/);
    await link(b, c);
    await link(c, d);
    await expect(link(d, e)).rejects.toThrow(/more than 4/);
    await db.agent.update({ where: { id: e }, data: { deletedAt: new Date() } });
    const f = await orgAgent(orgA, 'f');
    await expect(link(f, e)).rejects.toThrow(/retired/);
    expect(await baseOf(d)).toBeNull();
    expect(await baseOf(f)).toBeNull();
  });

  it('an insert is checked too', async () => {
    const [a, b, c, d] = await Promise.all(['a', 'b', 'c', 'd'].map((s) => orgAgent(orgA, s)));
    await link(a, b);
    await link(b, c);
    await link(c, d);
    await expect(
      db.agent.create({ data: { organizationId: orgA.id, name: 'x', urn: `${orgA.urn}:x`, extendsAgentId: a } }),
    ).rejects.toThrow(/more than 4/);
  });

  it('serializes two changes that would together close a cycle: exactly one commits', async () => {
    // Two raw connections, each in its own transaction, each setting one half
    // of a two-Agent cycle. Without the graph lock both see no cycle and both
    // commit. The guard's lock makes the second wait and then see the first.
    const a = await orgAgent(orgA, 'a');
    const b = await orgAgent(orgA, 'b');
    const url = process.env.DATABASE_URL!;
    const c1 = new pg.Client({ connectionString: url });
    const c2 = new pg.Client({ connectionString: url });
    await c1.connect();
    await c2.connect();
    try {
      await c1.query('BEGIN');
      await c2.query('BEGIN');
      await c1.query('UPDATE agents SET extends_agent_id = $1 WHERE id = $2', [b, a]);
      const second = c2.query('UPDATE agents SET extends_agent_id = $1 WHERE id = $2', [a, b]).then(
        () => 'ok',
        (e: Error) => e.message,
      );
      await new Promise((r) => setTimeout(r, 200));
      await c1.query('COMMIT');
      const outcome = await second;
      await c2.query(outcome === 'ok' ? 'COMMIT' : 'ROLLBACK');
      expect(outcome).toMatch(/cycle/);
    } finally {
      await c1.end();
      await c2.end();
    }
    expect(await baseOf(a)).toBe(b);
    expect(await baseOf(b)).toBeNull();
  });

  it('the migration carries a byte-identical copy of the invariants file, and post-push includes it', () => {
    const source = readFileSync(new URL('../../../../prisma/agent-base-invariants.sql', import.meta.url), 'utf8');
    const migration = readFileSync(new URL('../../../../prisma/migrations/20261014120000_agent_base/migration.sql', import.meta.url), 'utf8');
    expect(migration.endsWith(`\n${source}`)).toBe(true);
    const post = readFileSync(new URL('../../../../prisma/post-push.sql', import.meta.url), 'utf8');
    expect(post).toContain('\\ir agent-base-invariants.sql');
  });
});
