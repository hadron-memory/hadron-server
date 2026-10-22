/** #2063 caller cut 1: reconciliation reads take the outer fence before node locks. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { waitForLockWaitersOfType } from '../../test/lockWait.js';
import { generateId } from '../id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from '../../mcp/server.js';
import { reconcileNodeWithIncludeHistory } from '../nodeRevisionSnapshot.js';
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

async function underHeldFence<T>(work: () => Promise<T>, whileWaiting: (pending: Promise<T>) => Promise<void>) {
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
    await whileWaiting(result);
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
  it.each(['node', 'revision', 'batch', 'mcp', 'mcp-batch'] as const)('%s unchanged read finishes while an unrelated fence is held', async (surface) => {
    const n = await db.node.create({ data: { memoryId, loc: 'steady', name: 'Steady', content: 'unchanged' } });
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((r) => { entered = r; });
    const gate = new Promise<void>((r) => { release = r; });
    const holder = withIncludeHistoryTransaction(db, async () => { entered(); await gate; });
    await ready;
    const pending = (async () => {
      if (surface === 'node') return resolvers.Query.node(null, { ref: n.id, raw: true }, ctx());
      if (surface === 'revision') return resolvers.Node.revision(n as never, {}, ctx());
      if (surface === 'batch') return resolvers.Query.nodeBatch(null, { refs: [n.id] }, ctx());
      const mcp = createTestableMcpServer({ userId, roles: ['ADMIN'], clientId: `user:${userId}` });
      return surface === 'mcp'
        ? mcp.callToolText('hadron_get_node', { urn: 'hrn:node:read-fence.example:mem:steady' })
        : mcp.callToolText('hadron_get_nodes', { refs: ['hrn:node:read-fence.example:mem:steady'] });
    })();
    const settled = pending.then((value) => ({ value }), (error: unknown) => ({ error }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([settled, new Promise<'blocked'>((r) => { timer = setTimeout(() => r('blocked'), 750); })]);
      expect(outcome, 'unchanged reads must not queue behind the global history fence').not.toBe('blocked');
      expect(outcome).toHaveProperty('value');
    } finally {
      clearTimeout(timer);
      release();
      await holder;
      await settled;
    }
    expect(await db.nodeRevision.count({ where: { nodeId: n.id } })).toBe(0);
  });

  it.each(['node', 'revision', 'batch', 'mcp', 'mcp-batch'] as const)('%s waits before touching revision state, then reconciles', async (surface) => {
    const n = await drifted();
    const parent = await db.node.findUniqueOrThrow({ where: { id: n.id } });
    const result = await underHeldFence(
      async () => {
        if (surface === 'node') return resolvers.Query.node(null, { ref: n.id, raw: true }, ctx());
        if (surface === 'revision') return resolvers.Node.revision(parent as never, {}, ctx());
        if (surface === 'batch') return resolvers.Query.nodeBatch(null, { refs: [n.id] }, ctx());
        const mcp = createTestableMcpServer({ userId, roles: ['ADMIN'], clientId: `user:${userId}` });
        return surface === 'mcp'
          ? mcp.callToolText('hadron_get_node', { urn: 'hrn:node:read-fence.example:mem:drift' })
          : mcp.callToolText('hadron_get_nodes', { refs: ['hrn:node:read-fence.example:mem:drift'] });
      },
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
    expect(result).not.toBeNull();
    expect((await db.node.findUniqueOrThrow({ where: { id: n.id } })).revSeq).toBe(2);
    expect(await db.nodeRevision.count({ where: { nodeId: n.id } })).toBe(1);
  });
  it('refuses a raw client before any reconcile mutation', async () => {
    const n = await drifted();
    await expect(reconcileNodeWithIncludeHistory(db as never, n.id, { expectedMemoryId: memoryId })).rejects.toThrow(/prepared/);
    expect((await db.node.findUniqueOrThrow({ where: { id: n.id } })).revSeq).toBe(1);
    expect(await db.nodeRevision.count({ where: { nodeId: n.id } })).toBe(0);
  });

  it('rechecks the selected memory after the fence wait', async () => {
    const n = await drifted();
    const other = await db.memory.create({ data: { urn: 'read-fence.example:other', name: 'Other', class: 'personal', ownerUserId: userId, userId } });
    const result = await underHeldFence(
      async () => resolvers.Query.node(null, { ref: n.id, raw: true }, ctx()),
      async () => { await db.node.update({ where: { id: n.id }, data: { memoryId: other.id } }); },
    );
    expect(result).toBeNull();
    expect((await db.node.findUniqueOrThrow({ where: { id: n.id } })).revSeq).toBe(1);
    expect(await db.nodeRevision.count({ where: { nodeId: n.id } })).toBe(0);
  });

  it('cancels a reader waiting for the fence without reconciling, and later reads still work', async () => {
    const n = await drifted();
    await expect(underHeldFence(
      async () => resolvers.Query.node(null, { ref: n.id, raw: true }, ctx()),
      async (pending) => {
        const [waiter] = await db.$queryRaw<Array<{ pid: number }>>`
          SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
            AND classid = 2063 AND objid = 1772 AND objsubid = 2
            AND pid IN (SELECT pid FROM pg_stat_activity WHERE datname = current_database())`;
        expect(waiter).toBeDefined();
        const [{ cancelled }] = await db.$queryRaw<Array<{ cancelled: boolean }>>`SELECT pg_cancel_backend(${waiter!.pid}::int) AS cancelled`;
        expect(cancelled).toBe(true);
        // Observe cancellation while the holder still owns the fence; releasing
        // immediately could let acquisition win before the cancel is delivered.
        await expect(pending).rejects.toThrow();
      },
    )).rejects.toThrow();
    expect((await db.node.findUniqueOrThrow({ where: { id: n.id } })).revSeq).toBe(1);
    expect(await db.nodeRevision.count({ where: { nodeId: n.id } })).toBe(0);
    const after = await resolvers.Query.node(null, { ref: n.id, raw: true }, ctx());
    expect(after?.revSeq).toBe(2);
  });

  it.each(['node', 'mcp'] as const)('%s rechecks live authority after the fence wait, before reconciling', async (surface) => {
    const n = await drifted();
    const result = await underHeldFence(
      async () => surface === 'node'
        ? resolvers.Query.node(null, { ref: n.id, raw: true }, ctx())
        : createTestableMcpServer({ userId, roles: ['ADMIN'], clientId: `user:${userId}` }).callToolText('hadron_get_node', { urn: 'hrn:node:read-fence.example:mem:drift' }),
      async () => {
        await db.user.update({ where: { id: userId }, data: { roles: [] } });
        await db.orgMember.deleteMany({ where: { userId } });
      },
    );
    if (surface === 'node') expect(result).toBeNull();
    else expect(result).not.toContain('raw change');
    expect((await db.node.findUniqueOrThrow({ where: { id: n.id } })).revSeq).toBe(1);
    expect(await db.nodeRevision.count({ where: { nodeId: n.id } })).toBe(0);
  });

  it('refuses an escaped prepared context before reconciliation', async () => {
    const n = await drifted();
    const escaped = await withIncludeHistoryTransaction(db, async (history) => history);
    await expect(reconcileNodeWithIncludeHistory(escaped, n.id, { expectedMemoryId: memoryId })).rejects.toThrow(/prepared/);
    expect((await db.node.findUniqueOrThrow({ where: { id: n.id } })).revSeq).toBe(1);
  });

  it('concurrent canonical readers finish without nested pooled work or duplicate snapshots', async () => {
    const n = await drifted();
    const results = await Promise.all(Array.from({ length: 4 }, () => resolvers.Query.node(null, { ref: n.id, raw: true }, ctx())));
    expect(results.every((row) => row?.revSeq === 2 && row.content === 'raw change')).toBe(true);
    expect(await db.nodeRevision.count({ where: { nodeId: n.id } })).toBe(1);
  });

  it.each([
    ['node', 'missing'], ['node', 'deleted'], ['mcp', 'missing'], ['mcp', 'deleted'],
  ] as const)('%s refuses a %s actor after the fence wait without history mutation', async (surface, state) => {
    const n = await drifted();
    const result = await underHeldFence(
      async () => {
        try {
          return surface === 'node'
            ? await resolvers.Query.node(null, { ref: n.id, raw: true }, ctx())
            : await createTestableMcpServer({ userId, roles: ['ADMIN'], clientId: `user:${userId}` }).callToolText('hadron_get_node', { urn: 'hrn:node:read-fence.example:mem:drift' });
        } catch (error) { return error; }
      },
      async () => {
        if (state === 'missing') await db.user.delete({ where: { id: userId } });
        else await db.user.update({ where: { id: userId }, data: { deletedAt: new Date() } });
      },
    );
    if (surface === 'node') {
      expect(result).toBeInstanceOf(Error);
      expect((result as { extensions: { code: string } }).extensions.code).toBe('FORBIDDEN');
    } else {
      expect(result).toEqual(expect.any(String));
      expect(result).not.toContain('raw change');
      expect(result).toMatch(/not found/i);
    }
    expect((await db.node.findUniqueOrThrow({ where: { id: n.id } })).revSeq).toBe(1);
    expect(await db.nodeRevision.count({ where: { nodeId: n.id } })).toBe(0);
  });

});
