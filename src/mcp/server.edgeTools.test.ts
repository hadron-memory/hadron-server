/**
 * #835 — MCP edge editing. GraphQL has had full edge CRUD since spec 037, but
 * MCP exposed only `hadron_create_edge`. So changing ONE edge's label forced
 * `hadron_update_node(edges:)`, whose argument REPLACES the node's entire
 * outgoing set — a whole-set overwrite to express a single-edge intent, which
 * returns "Node updated" and reports nothing about the edges it dropped.
 *
 * The first describe reproduces that data loss so the fix has something
 * concrete to be measured against; the rest cover the two new tools.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer, describeEdgeUpdate, EDGE_DESCRIPTION_DOC } from './server.js';
import { typeDefs } from '../api/graphql/schema/typeDefs.js';
import type { AuthContext } from '../middleware/auth.js';
import { ensureChannelWithRoot, lockMemoryForChannelChange } from '../lib/channels.js';
import { acquireLockSet } from '../lib/nodeSubtreeLock.js';
import { runPendingEdgePromotionSweep } from '../jobs/promotePendingEdges.js';
import { pendingEdgeStableTargetKey } from '../lib/pendingEdgePromotion.js';
import { waitForLockWaitersOfType } from '../test/lockWait.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

let adminId: string;
let memId: string;
let memUrn: string;
let source: { id: string; loc: string };
let t1: { id: string };
let t2: { id: string };
let t3: { id: string };

const admin = (): Context => ({ db, roles: ['ADMIN'], userId: adminId } as Context);
const adminAuth = (): AuthContext => ({ userId: adminId, roles: ['ADMIN'], clientId: `user:${adminId}` });
const call = (tool: string, args: Record<string, unknown>): Promise<string> =>
  createTestableMcpServer(adminAuth()).callToolText(tool, args);

const node = (loc: string, name: string) =>
  db.node.create({
    data: { id: generateId(), memoryId: memId, loc, name, ownerRepo: 'test/repo', tags: [] },
  });

async function waitForChannelMemoryLockWaiters(
  memoryId: string,
  minimumWaiters: number,
  timeoutMs = 10_000,
): Promise<void> {
  const key = `channel-host:${memoryId}`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [{ count }] = await db.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*)::bigint AS count
      FROM pg_locks
      WHERE locktype = 'advisory'
        AND NOT granted
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND classid = (((hashtext(${key})::bigint >> 32) & 4294967295))::oid
        AND objid = ((hashtext(${key})::bigint & 4294967295))::oid
        AND objsubid = 1
    `;
    if (Number(count) >= minimumWaiters) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${minimumWaiters} Channel memory-lock waiter(s) on ${memoryId}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}


async function holdNodeLocLock(memoryId: string, loc: string): Promise<{
  release: () => void;
  done: Promise<unknown>;
}> {
  let signalHeld!: () => void;
  let signalRelease!: () => void;
  const held = new Promise<void>((resolve) => { signalHeld = resolve; });
  const release = new Promise<void>((resolve) => { signalRelease = resolve; });
  const done = db.$transaction(async (tx) => {
    await acquireLockSet(tx, [{ memoryId, loc }]);
    signalHeld();
    await release;
  }, { timeout: 20_000 });
  await held;
  return { release: signalRelease, done };
}

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'emcp-org', urn: 'emcp-org' } });
  const a = await db.user.create({ data: { githubId: 6711, githubUsername: 'emcp-admin', roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: a.id, role: 'ADMIN' } });
  adminId = a.id;
  const mem = await resolvers.Mutation.createMemory({}, { orgId: org.id, name: 'edges' }, admin());
  memId = mem.id;
  memUrn = mem.urn;

  source = await node('review:item', 'Item');
  t1 = await node('review', 'Review');
  t2 = await node('docs:guide', 'Guide');
  t3 = await node('rel:other', 'Other');
  // The real shape from the issue: an `applies-when` routing edge alongside
  // `documented-by` / `relates-to` siblings that must survive an edit.
  for (const [target, name] of [[t1, 'applies-when'], [t2, 'documented-by'], [t3, 'relates-to']] as const) {
    await db.edge.create({
      data: {
        id: generateId(), memoryId: memId, sourceId: source.id, targetId: target.id,
        name, loc: `${source.loc}:${name}:${(target as { id: string }).id.slice(0, 6)}`,
      },
    });
  }
});

const edgesOf = () =>
  db.edge.findMany({ where: { sourceId: source.id }, orderBy: { name: 'asc' } });

describe('the hazard #835 exists to remove', () => {
  it('hadron_update_node(edges:) silently destroys the siblings it was not given', async () => {
    expect((await edgesOf()).length).toBe(3);
    const out = await call('hadron_update_node', {
      urn: `${memUrn.replace(':', '::')}::${source.loc}`,
      edges: [{ targetUrn: t1.id, name: 'applies-when-renamed' }],
    });
    const after = await edgesOf();
    // Two unrelated edges are gone...
    expect(after.length).toBe(1);
    expect(after[0].name).toBe('applies-when-renamed');
    // ...and nothing in the response says so.
    expect(out).not.toMatch(/deleted|removed|dropped/i);
  });

  it('rolls back the inline node update when Channel reuse invalidates an edge target', async () => {
    const { channel, rootId } = await ensureChannelWithRoot(db, {
      memoryId: memId,
      loc: 'chats:inline-edge-race',
      name: 'inline-edge-race',
      createdBy: adminId,
    });
    const oldMessage = await db.node.create({
      data: {
        id: generateId(),
        memoryId: memId,
        loc: 'chats:inline-edge-race:messages:0001',
        name: 'old message',
      },
    });
    const deletedAt = new Date();
    await db.$transaction([
      db.channel.update({ where: { id: channel.id }, data: { deletedAt } }),
      db.node.update({ where: { id: rootId }, data: { deletedAt } }),
    ]);

    let signalHeld!: () => void;
    let signalRelease!: () => void;
    const held = new Promise<void>((resolve) => { signalHeld = resolve; });
    const release = new Promise<void>((resolve) => { signalRelease = resolve; });
    const holder = db.$transaction(async (tx) => {
      await lockMemoryForChannelChange(tx, memId);
      signalHeld();
      await release;
    }, { timeout: 20_000 });

    await held;
    const reusing = ensureChannelWithRoot(db, {
      memoryId: memId,
      loc: 'chats:inline-edge-race',
      name: 'inline-edge-race',
      createdBy: adminId,
    });
    try {
      await waitForChannelMemoryLockWaiters(memId, 1);
      const updating = call('hadron_update_node', {
        urn: `${memUrn.replace(':', '::')}::${source.loc}`,
        content: 'must roll back with the rejected edge set',
        edges: [{ targetUrn: oldMessage.id, name: 'stale-target' }],
      });
      await waitForChannelMemoryLockWaiters(memId, 2);
      signalRelease();
      await holder;
      await reusing;

      const out = await updating;
      expect(out).toContain(`Edge target not found: "${oldMessage.id}"`);
      expect((await db.node.findUniqueOrThrow({ where: { id: source.id } })).content).toBeNull();
      expect(await db.edge.count({ where: { sourceId: source.id } })).toBe(3);
      expect(await db.edge.count({ where: { targetId: oldMessage.id, deletedAt: null } })).toBe(0);
    } finally {
      signalRelease();
      await holder.catch(() => undefined);
    }
  }, 20_000);

  it('serializes PendingEdge promotion with reuse and drops a tombstoned source', async () => {
    const { channel, rootId } = await ensureChannelWithRoot(db, {
      memoryId: memId,
      loc: 'chats:pending-edge-race',
      name: 'pending-edge-race',
      createdBy: adminId,
    });
    const oldMessage = await db.node.create({
      data: {
        id: generateId(),
        memoryId: memId,
        loc: 'chats:pending-edge-race:messages:0001',
        name: 'old message',
      },
    });
    await db.pendingEdge.create({
      data: {
        id: generateId(),
        sourceId: oldMessage.id,
        targetId: 'future-target',
        name: 'stale-pending',
      },
    });
    const deletedAt = new Date();
    await db.$transaction([
      db.channel.update({ where: { id: channel.id }, data: { deletedAt } }),
      db.node.update({ where: { id: rootId }, data: { deletedAt } }),
    ]);

    let signalHeld!: () => void;
    let signalRelease!: () => void;
    const held = new Promise<void>((resolve) => { signalHeld = resolve; });
    const release = new Promise<void>((resolve) => { signalRelease = resolve; });
    const holder = db.$transaction(async (tx) => {
      await lockMemoryForChannelChange(tx, memId);
      signalHeld();
      await release;
    }, { timeout: 20_000 });

    await held;
    const reusing = ensureChannelWithRoot(db, {
      memoryId: memId,
      loc: 'chats:pending-edge-race',
      name: 'pending-edge-race',
      createdBy: adminId,
    });
    try {
      await waitForChannelMemoryLockWaiters(memId, 1);
      const creating = call('hadron_create_node', {
        urn: `${memUrn.replace(':', '::')}::future-target`,
        name: 'future target',
      });
      await waitForChannelMemoryLockWaiters(memId, 2);
      signalRelease();
      await holder;
      await reusing;

      expect(await creating).toMatch(/Node saved/);
      expect(await db.edge.count({ where: { sourceId: oldMessage.id, deletedAt: null } })).toBe(0);
      expect(await db.pendingEdge.count({ where: { sourceId: oldMessage.id } })).toBe(0);
    } finally {
      signalRelease();
      await holder.catch(() => undefined);
    }
  }, 20_000);

  it('does not recreate a PendingEdge removed by a source edges update while promotion waits', async () => {
    const target = await node('future-stable-target', 'future stable target');
    const pending = await db.pendingEdge.create({
      data: {
        id: generateId(),
        sourceId: source.id,
        targetId: pendingEdgeStableTargetKey(target.id),
        name: 'removed-while-waiting',
      },
    });

    let signalHeld!: () => void;
    let signalRelease!: () => void;
    const held = new Promise<void>((resolve) => { signalHeld = resolve; });
    const release = new Promise<void>((resolve) => { signalRelease = resolve; });
    const holder = db.$transaction(async (tx) => {
      await lockMemoryForChannelChange(tx, memId);
      signalHeld();
      await release;
    }, { timeout: 20_000 });

    await held;
    const clearing = call('hadron_update_node', {
      urn: `${memUrn.replace(':', '::')}::${source.loc}`,
      edges: [],
    });
    try {
      // Queue the explicit source update first, then let the durable sweep
      // snapshot the still-present PendingEdge and queue behind it.
      await waitForChannelMemoryLockWaiters(memId, 1);
      const sweeping = runPendingEdgePromotionSweep(db);
      await waitForChannelMemoryLockWaiters(memId, 2);
      signalRelease();
      await holder;

      expect(await clearing).toMatch(/Node updated/);
      await sweeping;
      expect(await db.pendingEdge.findUnique({ where: { id: pending.id } })).toBeNull();
      expect(await db.edge.count({
        where: { sourceId: source.id, targetId: target.id, name: 'removed-while-waiting' },
      })).toBe(0);
    } finally {
      signalRelease();
      await holder.catch(() => undefined);
    }
  }, 20_000);

  it('revalidates a tombstoned target after a queued resurrection wins the memory lock', async () => {
    const target = await node('resurrected-stable-target', 'resurrected stable target');
    await db.node.update({ where: { id: target.id }, data: { deletedAt: new Date() } });
    const pending = await db.pendingEdge.create({
      data: {
        id: generateId(),
        sourceId: source.id,
        targetId: pendingEdgeStableTargetKey(target.id),
        name: 'survives-resurrection',
      },
    });

    let signalHeld!: () => void;
    let signalRelease!: () => void;
    const held = new Promise<void>((resolve) => { signalHeld = resolve; });
    const release = new Promise<void>((resolve) => { signalRelease = resolve; });
    const holder = db.$transaction(async (tx) => {
      await lockMemoryForChannelChange(tx, memId);
      signalHeld();
      await release;
    }, { timeout: 20_000 });

    await held;
    // Durable stable-id work is intentionally not rediscovered through the
    // loc-keyed create callback. Queue the resurrection transaction itself so
    // it wins the shared memory lock before the sweep revalidates the target.
    const resurrecting = db.$transaction(async (tx) => {
      await lockMemoryForChannelChange(tx, memId);
      return tx.node.update({
        where: { id: target.id },
        data: { deletedAt: null, deletedBy: null },
      });
    }, { timeout: 20_000 });
    try {
      await waitForChannelMemoryLockWaiters(memId, 1);
      const sweeping = runPendingEdgePromotionSweep(db);
      await waitForChannelMemoryLockWaiters(memId, 2);
      signalRelease();
      await holder;

      expect(await resurrecting).toMatchObject({ id: target.id, deletedAt: null });
      await sweeping;
      expect(await db.pendingEdge.findUnique({ where: { id: pending.id } })).toBeNull();
      expect(await db.edge.findFirst({
        where: {
          sourceId: source.id,
          targetId: target.id,
          name: 'survives-resurrection',
          deletedAt: null,
        },
      })).not.toBeNull();
    } finally {
      signalRelease();
      await holder.catch(() => undefined);
    }
  }, 20_000);

  it('locks endpoint ancestors and retries promotion after an ancestor move', async () => {
    const { organizationId } = await db.memory.findUniqueOrThrow({
      where: { id: memId },
      select: { organizationId: true },
    });
    const movedMemory = await resolvers.Mutation.createMemory(
      {},
      { orgId: organizationId!, name: 'moved pending source' },
      admin(),
    );
    const pending = await db.pendingEdge.create({
      data: {
        id: generateId(),
        sourceId: source.id,
        targetId: 'future-moved-target',
        name: 'survives-move',
      },
    });

    const blockingEdge = await db.edge.findFirstOrThrow({
      where: { sourceId: source.id, deletedAt: null },
    });
    let signalEdgeHeld!: () => void;
    let signalEdgeRelease!: () => void;
    const edgeHeld = new Promise<void>((resolve) => { signalEdgeHeld = resolve; });
    const edgeRelease = new Promise<void>((resolve) => { signalEdgeRelease = resolve; });
    const edgeHolder = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM edges WHERE id = ${blockingEdge.id} FOR UPDATE`;
      signalEdgeHeld();
      await edgeRelease;
    }, { timeout: 20_000 });

    let signalMemoryHeld!: () => void;
    let signalMemoryRelease!: () => void;
    const memoryHeld = new Promise<void>((resolve) => { signalMemoryHeld = resolve; });
    const memoryRelease = new Promise<void>((resolve) => { signalMemoryRelease = resolve; });
    const memoryHolder = db.$transaction(async (tx) => {
      await lockMemoryForChannelChange(tx, memId);
      signalMemoryHeld();
      await memoryRelease;
    }, { timeout: 20_000 });

    await Promise.all([edgeHeld, memoryHeld]);
    const creating = call('hadron_create_node', {
      urn: `${memUrn.replace(':', '::')}::future-moved-target`,
      name: 'future moved target',
    });
    try {
      await waitForChannelMemoryLockWaiters(memId, 1);

      // Move the SOURCE'S ANCESTOR, not the endpoint itself. The move holds
      // `review`, rebases `review:item`, snapshots its outgoing edges, then
      // blocks on the pre-existing edge row. Exact-loc-only promotion could
      // now insert from the old snapshot and escape the move's edge carry-over.
      const moving = call('hadron_move_node', {
        urn: `urn:node:${memUrn}:review`,
        targetUrn: `urn:node:${movedMemory.urn}:moved:review`,
      });
      await waitForLockWaitersOfType(db, 'transactionid', 1);

      signalMemoryRelease();
      await memoryHolder;
      // The promotion must now wait on the ancestor key held by the move. This
      // assertion mutation-tests the fix: exact endpoint locks produce no
      // advisory waiter and the test times out here.
      await waitForLockWaitersOfType(db, 'advisory', 1);

      signalEdgeRelease();
      await edgeHolder;

      expect(await moving).toMatch(/Moved/);
      expect(await creating).toMatch(/Node saved/);
      expect(await db.pendingEdge.findUnique({ where: { id: pending.id } })).toBeNull();
      expect(await db.node.findUniqueOrThrow({ where: { id: source.id } })).toMatchObject({
        memoryId: movedMemory.id,
        loc: 'moved:review:item',
      });
      const promoted = await db.edge.findFirstOrThrow({
        where: { sourceId: source.id, name: 'survives-move', deletedAt: null },
      });
      expect(promoted.memoryId).toBe(movedMemory.id);
      expect(promoted.loc).toMatch(/^moved:review:item:survives-move:/);
    } finally {
      signalMemoryRelease();
      signalEdgeRelease();
      await Promise.all([
        memoryHolder.catch(() => undefined),
        edgeHolder.catch(() => undefined),
      ]);
    }
  }, 20_000);

  it('keeps a successful create and its PendingEdge when move retries exhaust', async () => {
    const { organizationId } = await db.memory.findUniqueOrThrow({
      where: { id: memId },
      select: { organizationId: true },
    });
    const movedMemory = await resolvers.Mutation.createMemory(
      {},
      { orgId: organizationId!, name: 'pending retry destination' },
      admin(),
    );
    const pending = await db.pendingEdge.create({
      data: {
        id: generateId(),
        sourceId: source.id,
        targetId: 'future-retry-target',
        name: 'waits-for-later',
      },
    });

    type Holder = Awaited<ReturnType<typeof holdNodeLocLock>>;
    const holders: Holder[] = [];
    const hold = async (memoryId: string, loc: string): Promise<Holder> => {
      const holder = await holdNodeLocLock(memoryId, loc);
      holders.push(holder);
      return holder;
    };

    // Hold the exact endpoint loc from the first outer snapshot. Each next
    // barrier is acquired before releasing the current one; only two are held
    // concurrently so the test does not consume Prisma's whole connection pool.
    const a1 = await hold(memId, source.loc);
    const creating = call('hadron_create_node', {
      urn: `${memUrn.replace(':', '::')}::future-retry-target`,
      name: 'future retry target',
    });

    try {
      // Attempt 0 snapshots A and waits at the old exact loc; move to B before
      // release. Attempts 1–3 alternate the same way. The final A3 lock stays
      // held while `creating` resolves, proving there was no hidden fifth retry
      // after the documented budget was exhausted.
      await waitForLockWaitersOfType(db, 'advisory', 1);
      const b1 = await hold(movedMemory.id, 'bounce-b1:review:item');
      await db.node.update({
        where: { id: source.id },
        data: { memoryId: movedMemory.id, loc: 'bounce-b1:review:item' },
      });
      a1.release();
      await a1.done;

      await waitForLockWaitersOfType(db, 'advisory', 1);
      const a2 = await hold(memId, 'bounce-a2:review:item');
      await db.node.update({
        where: { id: source.id },
        data: { memoryId: memId, loc: 'bounce-a2:review:item' },
      });
      b1.release();
      await b1.done;

      await waitForLockWaitersOfType(db, 'advisory', 1);
      const b2 = await hold(movedMemory.id, 'bounce-b2:review:item');
      await db.node.update({
        where: { id: source.id },
        data: { memoryId: movedMemory.id, loc: 'bounce-b2:review:item' },
      });
      a2.release();
      await a2.done;

      await waitForLockWaitersOfType(db, 'advisory', 1);
      await hold(memId, 'bounce-a3:review:item');
      await db.node.update({
        where: { id: source.id },
        data: { memoryId: memId, loc: 'bounce-a3:review:item' },
      });
      b2.release();
      await b2.done;

      expect(await creating).toMatch(/Node saved/);
      const target = await db.node.findUniqueOrThrow({
        where: { loc_memoryId: { memoryId: memId, loc: 'future-retry-target' } },
      });
      expect(await db.pendingEdge.findUnique({ where: { id: pending.id } })).toMatchObject({
        targetId: pendingEdgeStableTargetKey(target.id),
      });
      expect(await db.edge.count({
        where: { sourceId: source.id, name: 'waits-for-later', deletedAt: null },
      })).toBe(0);

      // Let the queued pass acquire A3. The stable-id retarget makes this work
      // reachable after the one create call that could resolve the old loc key.
      for (const holder of holders) holder.release();
      await Promise.all(holders.map((holder) => holder.done));
      const deadline = Date.now() + 5_000;
      while (await db.pendingEdge.findUnique({ where: { id: pending.id } })) {
        if (Date.now() > deadline) throw new Error('timed out waiting for deferred promotion');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const promoted = await db.edge.findFirstOrThrow({
        where: { sourceId: source.id, targetId: target.id, name: 'waits-for-later', deletedAt: null },
      });
      expect(promoted.memoryId).toBe(memId);
      expect(promoted.loc).toMatch(/^bounce-a3:review:item:waits-for-later:/);
    } finally {
      for (const holder of holders) holder.release();
      await Promise.all(holders.map((holder) => holder.done.catch(() => undefined)));
    }
  }, 20_000);
});

/**
 * Source of the `hadron_update_edge` parameter shape. Since #2260 shapes live at module scope in server.ts
 * (`SHAPE_HADRON_UPDATE_EDGE`), built once per process, not inline in the `server.tool` call.
 */
function updateEdgeShapeSource(): string {
  const src = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
  const start = src.indexOf('const SHAPE_HADRON_UPDATE_EDGE = ');
  expect(start).toBeGreaterThan(-1);
  return src.slice(start, src.indexOf('\n};', start));
}

describe('hadron_update_edge — the single-edge intent (#835)', () => {
  it('renames ONE edge and leaves every sibling intact', async () => {
    const target = (await edgesOf()).find((e) => e.name === 'applies-when')!;
    const out = await call('hadron_update_edge', { edgeRef: target.id, name: 'applies-when-v2' });
    expect(out).toMatch(/Edge updated/);
    const after = await edgesOf();
    expect(after.length).toBe(3);
    expect(after.map((e) => e.name).sort()).toEqual(
      ['applies-when-v2', 'documented-by', 'relates-to'],
    );
  });

  it('updates only the fields supplied — omitted ones are preserved', async () => {
    const target = (await edgesOf()).find((e) => e.name === 'documented-by')!;
    await call('hadron_update_edge', { edgeRef: target.id, description: 'why this applies' });
    const after = await db.edge.findUniqueOrThrow({ where: { id: target.id } });
    expect(after.description).toBe('why this applies');
    expect(after.name).toBe('documented-by'); // untouched
    expect(after.loc).toBe(target.loc);
  });

  it('accepts a fully-qualified edge URN as well as a PK', async () => {
    const target = (await edgesOf()).find((e) => e.name === 'relates-to')!;
    const urn = `hrn:edge:${memUrn.replace(':', '::')}::${target.loc}`;
    const out = await call('hadron_update_edge', { edgeRef: urn, name: 'relates-to-v2' });
    expect(out).toMatch(/Edge updated/);
    expect((await db.edge.findUniqueOrThrow({ where: { id: target.id } })).name).toBe('relates-to-v2');
  });

  it('#1057: the receipt echoes what CHANGED, read back from the store — never the untouched name', async () => {
    const target = (await edgesOf()).find((e) => e.name === 'documented-by')!;
    const out = await call('hadron_update_edge', { edgeRef: target.id, description: 'why this applies' });
    expect(out).toMatch(/Edge updated: .* — description → "why this applies"$/);
    // The URN legitimately contains the name (edge locs derive from it); what
    // must not appear is the old "(name)" echo or any claim the name changed.
    expect(out).not.toMatch(/\(documented-by\)|name →/);
  });

  it('#1057: a rename echoes the NEW name; an explicit null says cleared', async () => {
    const target = (await edgesOf()).find((e) => e.name === 'applies-when')!;
    expect(await call('hadron_update_edge', { edgeRef: target.id, name: 'applies-when-v3' }))
      .toMatch(/— name → "applies-when-v3"$/);
    await call('hadron_update_edge', { edgeRef: target.id, description: 'x' });
    expect(await call('hadron_update_edge', { edgeRef: target.id, description: null }))
      .toMatch(/— description cleared$/);
  });

  it('#1057: routing and structured fields report what they became; several fields are all listed', async () => {
    const target = (await edgesOf()).find((e) => e.name === 'relates-to')!;
    const out = await call('hadron_update_edge', {
      edgeRef: target.id, priority: 3, condition: { '==': [1, 1] }, data: { k: 'v' }, isRunnable: true,
    });
    expect(out).toMatch(/— isRunnable → true; priority → 3; condition set; data set$/);
    expect(await call('hadron_update_edge', { edgeRef: target.id, condition: null, data: null }))
      .toMatch(/— condition cleared; data cleared$/);
  });

  it('returns tool-error text (not a crash) for an unknown edge', async () => {
    const out = await call('hadron_update_edge', { edgeRef: generateId(), name: 'x' });
    expect(out).toMatch(/not found/i);
    expect((await edgesOf()).length).toBe(3);
  });

  // PR #861 review (Codex P2): `z.string().optional()` rejected null, so a
  // caller could replace name/description but never restore them to unset —
  // even though Mutation.updateEdge uses explicit null to clear.
  it('an explicit null CLEARS a nullable field', async () => {
    const target = (await edgesOf()).find((e) => e.name === 'documented-by')!;
    await call('hadron_update_edge', { edgeRef: target.id, description: 'temporary' });
    expect((await db.edge.findUniqueOrThrow({ where: { id: target.id } })).description).toBe('temporary');
    await call('hadron_update_edge', { edgeRef: target.id, description: null });
    expect((await db.edge.findUniqueOrThrow({ where: { id: target.id } })).description).toBeNull();
  });

  // PR #861 review (Codex P2): updateEdge has always supported these; the
  // wrapper neither accepted nor forwarded them, leaving routing conditions
  // uneditable over MCP entirely (hadron_update_node(edges:) has no such field).
  it('sets and clears a JSONLogic routing condition', async () => {
    const target = (await edgesOf()).find((e) => e.name === 'applies-when')!;
    // `var` is an allowed operator and the path must carry a valid scope
    // (memory./chat./agent./message.data.) — the validator rejects anything
    // else with INVALID_EDGE_CONDITION, which the wrapper surfaces as tool
    // text rather than crashing (covered below).
    await call('hadron_update_edge', { edgeRef: target.id, condition: { var: 'message.data.stage' } });
    expect((await db.edge.findUniqueOrThrow({ where: { id: target.id } })).condition)
      .toEqual({ var: 'message.data.stage' });
    await call('hadron_update_edge', { edgeRef: target.id, condition: null });
    expect((await db.edge.findUniqueOrThrow({ where: { id: target.id } })).condition).toBeNull();
  });

  it('surfaces an INVALID_EDGE_CONDITION as tool text, leaving the edge alone', async () => {
    const target = (await edgesOf()).find((e) => e.name === 'applies-when')!;
    const out = await call('hadron_update_edge', { edgeRef: target.id, condition: { var: 'nope.stage' } });
    expect(out).toMatch(/valid scope/i);
    expect((await db.edge.findUniqueOrThrow({ where: { id: target.id } })).condition).toBeNull();
  });

  it('sets edge data', async () => {
    const target = (await edgesOf()).find((e) => e.name === 'relates-to')!;
    await call('hadron_update_edge', { edgeRef: target.id, data: { weight: 3 } });
    expect((await db.edge.findUniqueOrThrow({ where: { id: target.id } })).data).toEqual({ weight: 3 });
  });

  // PR #861 review (Copilot): priority is an Int in GraphQL and an integer
  // column, so a float must be rejected at the tool boundary rather than
  // reaching Prisma/PG.
  //
  // Asserted on the SCHEMA, not by calling: createTestableMcpServer invokes
  // the handler directly and never runs the zod parse the MCP transport does,
  // so a runtime-rejection test here would pass vacuously.
  it('declares priority as an INTEGER so a float is rejected by the transport', () => {
    const desc = updateEdgeShapeSource();
    expect(desc).toMatch(/priority: z\.number\(\)\.int\(\)/);
  });

  it('declares the clearable fields as NULLABLE so null reaches the resolver', () => {
    const desc = updateEdgeShapeSource();
    expect(desc).toMatch(/name: z\.string\(\)\.nullable\(\)\.optional\(\)/);
    expect(desc).toMatch(/description: z\.string\(\)\.nullable\(\)\.optional\(\)/);
  });

  // PR #861 review (Codex P2 / Copilot): the description used to advertise
  // "retarget", which the schema cannot express and the resolver cannot do.
  it('does not advertise retargeting, which it cannot do', () => {
    const src = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
    const desc = src.slice(src.indexOf("'hadron_update_edge'"), src.indexOf("'hadron_delete_edge'"));
    expect(desc).not.toMatch(/relabel or retarget/);
    expect(desc).toMatch(/canNOT move an edge to a different source or target/);
  });
});

describe('hadron_delete_edge — removing one relationship (#835)', () => {
  it('deletes ONE edge and leaves the others and both nodes alone', async () => {
    const target = (await edgesOf()).find((e) => e.name === 'documented-by')!;
    const out = await call('hadron_delete_edge', { edgeRef: target.id });
    expect(out).toMatch(/Edge deleted/);
    const after = await edgesOf();
    expect(after.map((e) => e.name).sort()).toEqual(['applies-when', 'relates-to']);
    // Endpoints untouched.
    expect(await db.node.findUnique({ where: { id: source.id } })).not.toBeNull();
    expect(await db.node.findUnique({ where: { id: t2.id } })).not.toBeNull();
  });

  it('returns tool-error text for an unknown edge', async () => {
    const out = await call('hadron_delete_edge', { edgeRef: generateId() });
    expect(out).toMatch(/not found/i);
    expect((await edgesOf()).length).toBe(3);
  });
});

describe('the destructive semantics are legible at the callsite (#835 item 2)', () => {
  // The MCP harness exposes handlers, not argument descriptions, so this reads
  // the source text — the same audit-by-regex shape used elsewhere in the repo
  // for schema-text guarantees.
  const serverSource = () =>
    readFileSync(new URL('./server.ts', import.meta.url), 'utf8');

  it('hadron_update_node advertises that `edges` REPLACES, not merges', () => {
    // Pre-#835 the warning lived only on the SAFE tool (hadron_create_edge
    // advertised being non-destructive) while the dangerous one said merely
    // "Replace outgoing edges (the full set on this node)".
    const src = serverSource();
    expect(src).not.toMatch(/describe\('Replace outgoing edges \(the full set on this node\)'\)/);
    // NOTE: the apostrophe is backslash-escaped in the source string literal.
    expect(src).toMatch(/REPLACES the node.{1,2}s ENTIRE outgoing edge set/);
    expect(src).toMatch(/it does NOT merge/);
    expect(src).toMatch(/is DELETED, silently and without a diff/);
  });

  it('...and points at the single-edge tools as the alternative', () => {
    const src = serverSource();
    expect(src).toMatch(/To change ONE edge, use hadron_update_edge instead/);
    expect(src).toMatch(/to add one without touching the others, use hadron_create_edge/);
  });
});

describe('#1057 — describeEdgeUpdate and the edge description doc', () => {
  it('clips a long text value and says so when nothing was passed', () => {
    const long = 'x'.repeat(200);
    expect(describeEdgeUpdate({ description: long }, { loc: 'l', name: 'n', description: long }))
      .toBe(`description → "${'x'.repeat(79)}…"`);
    expect(describeEdgeUpdate({}, { loc: 'l', name: 'n' })).toBe('no fields were passed, so nothing changed');
  });

  it('documents description as structured-only, on the tools and in the SDL', () => {
    expect(EDGE_DESCRIPTION_DOC).toMatch(/NOT rendered on node reads/);
    expect(EDGE_DESCRIPTION_DOC).toMatch(/`name`/);
    expect(typeDefs).toMatch(/NOT rendered on agent node reads[\s\S]{0,200}\n\s+description: String/);
  });
});
