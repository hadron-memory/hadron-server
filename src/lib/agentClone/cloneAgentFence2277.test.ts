/**
 * #2277 (S9): `cloneAgent` runs under the #2063 include-history fence. A holder of F must queue the clone
 * before any of its work, and the clone must finish once F is released. Without `fence: true` the clone never
 * waits on F, so the barrier below times out (red).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';

const M = resolvers.Mutation as Record<string, (...a: unknown[]) => Promise<any>>;
const FENCE = [2063, 1772] as const;

/** Resolve once a backend in this database waits, ungranted, on the include-history fence key. */
async function waitForFenceWaiter(timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [{ n }] = await db.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE a.datname = current_database() AND l.locktype = 'advisory' AND NOT l.granted
        AND l.classid = ${FENCE[0]}::oid AND l.objid = ${FENCE[1]}::oid`;
    if (n >= 1) return;
    if (Date.now() > deadline) throw new Error('the clone never queued on the include-history fence');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('cloneAgent queues on the include-history fence (#2277)', () => {
  let org: { id: string; urn: string };
  let admin: string;
  beforeEach(async () => {
    await cleanDb(db);
    org = { id: generateId(), urn: 'cf-fence.example' };
    await db.organization.create({ data: { id: org.id, name: org.urn, urn: org.urn } });
    admin = generateId();
    await db.user.create({ data: { id: admin, email: `a-${admin}@x.test`, handle: `a${admin.slice(-6)}`.toLowerCase() } });
    await db.orgMember.create({ data: { organizationId: org.id, userId: admin, role: 'ADMIN' } });
  });

  it('waits for a held F before writing anything, then completes', async () => {
    const memId = generateId();
    await db.memory.create({ data: { id: memId, organizationId: org.id, urn: `${org.urn}:s-system`, name: 's System', class: 'system', acceptsUploads: false } as never });
    await db.agent.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:s`, name: 's', systemMemoryId: memId, visibility: 'ORGANIZATION' } });
    await db.node.create({ data: { id: generateId(), memoryId: memId, loc: 'a', name: 'a', nodeType: 'page', content: 'v1' } as never });

    let release!: () => void;
    let held!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const heldP = new Promise<void>((r) => { held = r; });
    const holder = db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${FENCE[0]}::int, ${FENCE[1]}::int)`;
      held();
      await gate;
    }, { timeout: 30_000 });
    await heldP;

    const ctx = { db, userId: admin, roles: ['READER'] } as Context;
    const clone = M.cloneAgent(null, { source: `${org.urn}:s`, target: org.urn, name: 'copy' }, ctx);
    clone.catch(() => undefined);
    try {
      await waitForFenceWaiter();
      expect(await db.agentCloneAudit.count()).toBe(0);
      expect(await db.agent.count()).toBe(1);
    } finally {
      release();
      await Promise.allSettled([holder]);
    }
    const created = await clone;
    expect(created.clonedFromAgentRef).toBe(`${org.urn}:s`);
    expect(await db.agent.count()).toBe(2);
    expect(await db.agentCloneAudit.count()).toBe(1);
  }, 20_000);
});
