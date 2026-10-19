/** #2063 caller cut 1: reconciliation reads take the outer fence before node locks. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { waitForLockWaitersOfType } from '../../test/lockWait.js';
import { generateId } from '../id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { withIncludeHistoryTransaction } from './includeHistoryFence.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
let userId: string;
let memoryId: string;
const ctx = (): Context => ({ db, userId, roles: ['ADMIN'] });
beforeEach(async () => {
  await cleanDb(db);
  const user = await db.user.create({ data: { handle: 'read-fence-admin', roles: ['ADMIN'] } });
  userId = user.id;
  const org = await db.organization.create({ data: { name: 'Read fence', urn: 'read-fence.example' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'ADMIN' } });
  memoryId = (await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: 'read-fence.example:mem', name: 'Read fence', class: 'knowledge' } })).id;
});

async function underHeldFence<T>(work: () => Promise<T>, whileWaiting: () => Promise<void>) {
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((r) => { entered = r; });
  const gate = new Promise<void>((r) => { release = r; });
  const holder = withIncludeHistoryTransaction(db, async () => { entered(); await gate; });
  await ready;
  const result = work();
  // Attach the rejection handler immediately, including cancellation probes.
  const settled = result.then((value) => ({ value }), (error: unknown) => ({ error }));
  try {
    await waitForLockWaitersOfType(db, 'advisory', 1, 750);
    await whileWaiting();
  } finally {
    release();
    await holder;
    await settled;
  }
  return result;
}

async function drifted() {
  const n = await db.node.create({ data: { memoryId, loc: 'drift', name: 'Drift', content: 'before' } });
  await db.node.update({ where: { id: n.id }, data: { content: 'raw change' } });
  return n;
}

describe('outer-fenced reconciliation read callers', () => {
  it.each(['node', 'revision'] as const)('%s waits before touching revision state, then reconciles', async (surface) => {
    const n = await drifted();
    const parent = await db.node.findUniqueOrThrow({ where: { id: n.id } });
    const result = await underHeldFence(
      async () => surface === 'node'
        ? resolvers.Query.node(null, { ref: n.id, raw: true }, ctx())
        : resolvers.Node.revision(parent as never, {}, ctx()),
      async () => {
        expect((await db.node.findUniqueOrThrow({ where: { id: n.id } })).revSeq).toBe(1);
        expect(await db.nodeRevision.count({ where: { nodeId: n.id } })).toBe(0);
        // The waiter must not hold the Node row before the outer fence.
        await db.$transaction(async (tx) => {
          await tx.$executeRaw`SET LOCAL lock_timeout = '100ms'`;
          await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${n.id} FOR UPDATE NOWAIT`;
        });
      },
    );
    expect(surface === 'revision' ? result : (result as { revSeq: number }).revSeq).toBe(2);
    expect(await db.nodeRevision.count({ where: { nodeId: n.id } })).toBe(1);
  });
});
