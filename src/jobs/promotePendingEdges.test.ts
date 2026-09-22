import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbNode, createDbOrgAndGraph } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { deriveEdgeLoc } from '../lib/edgeLoc.js';
import {
  runPendingEdgePromotionSweep,
  startPendingEdgePromotionSweepLoop,
  type PendingEdgePromotionLoop,
} from './promotePendingEdges.js';

let memoryId: string;
let loop: PendingEdgePromotionLoop | null = null;

beforeEach(async () => {
  await cleanDb(db);
  const { graph } = await createDbOrgAndGraph(db, {
    orgName: `pending-sweep-${Date.now()}`,
    graphName: 'pending/sweep',
  });
  memoryId = graph.id;
});

afterEach(async () => {
  await loop?.stop();
  loop = null;
});

async function seedStablePending() {
  const source = await createDbNode(db, { memoryId, loc: 'source' });
  const target = await createDbNode(db, { memoryId, loc: 'target' });
  const pending = await db.pendingEdge.create({
    data: {
      id: generateId(),
      sourceId: source.id,
      targetId: target.id,
      name: 'durable',
    },
  });
  await db.memory.update({
    where: { id: memoryId },
    data: { pendingEdgeCount: { increment: 1 } },
  });
  return { source, target, pending };
}

describe('durable PendingEdge promotion sweep', () => {
  it('promotes a stable-id row without any originating create call', async () => {
    const { source, target, pending } = await seedStablePending();

    await expect(runPendingEdgePromotionSweep(db)).resolves.toEqual({
      promoted: 1,
      failed: 0,
      examined: 1,
    });
    expect(await db.pendingEdge.findUnique({ where: { id: pending.id } })).toBeNull();
    expect(await db.edge.findFirst({
      where: { sourceId: source.id, targetId: target.id, name: 'durable', deletedAt: null },
    })).not.toBeNull();
    expect((await db.memory.findUniqueOrThrow({ where: { id: memoryId } })).pendingEdgeCount).toBe(0);
  });

  it('leaves loc-keyed forward references parked until their target is created', async () => {
    const source = await createDbNode(db, { memoryId, loc: 'source' });
    const pending = await db.pendingEdge.create({
      data: { id: generateId(), sourceId: source.id, targetId: 'future:target', name: 'later' },
    });

    await expect(runPendingEdgePromotionSweep(db)).resolves.toEqual({
      promoted: 0,
      failed: 0,
      examined: 0,
    });
    expect(await db.pendingEdge.findUnique({ where: { id: pending.id } })).not.toBeNull();
  });

  it('settles the source-memory count when a dead source makes the work terminal', async () => {
    const { source, pending } = await seedStablePending();
    await db.node.update({
      where: { id: source.id },
      data: { deletedAt: new Date() },
    });

    await expect(runPendingEdgePromotionSweep(db)).resolves.toEqual({
      promoted: 1,
      failed: 0,
      examined: 1,
    });
    expect(await db.pendingEdge.findUnique({ where: { id: pending.id } })).toBeNull();
    expect((await db.memory.findUniqueOrThrow({ where: { id: memoryId } })).pendingEdgeCount).toBe(0);
  });

  it('selects a tombstoned stable target so its queued work is consumed', async () => {
    const { target, pending } = await seedStablePending();
    await db.node.update({
      where: { id: target.id },
      data: { deletedAt: new Date() },
    });

    await expect(runPendingEdgePromotionSweep(db)).resolves.toEqual({
      promoted: 1,
      failed: 0,
      examined: 1,
    });
    expect(await db.pendingEdge.findUnique({ where: { id: pending.id } })).toBeNull();
    expect((await db.memory.findUniqueOrThrow({ where: { id: memoryId } })).pendingEdgeCount).toBe(0);
  });

  it('recomputes instead of stealing another pending row credit', async () => {
    const { source, target, pending } = await seedStablePending();
    await db.node.update({ where: { id: target.id }, data: { deletedAt: new Date() } });
    const parked = await db.pendingEdge.create({
      data: {
        id: generateId(),
        sourceId: source.id,
        targetId: 'still-unresolved',
        name: 'parked',
      },
    });

    await runPendingEdgePromotionSweep(db);

    expect(await db.pendingEdge.findUnique({ where: { id: pending.id } })).toBeNull();
    expect(await db.pendingEdge.findUnique({ where: { id: parked.id } })).not.toBeNull();
    expect((await db.memory.findUniqueOrThrow({ where: { id: memoryId } })).pendingEdgeCount).toBe(1);
  });

  it('repairs the count after a hard source delete cascades the queue row', async () => {
    const { source, pending } = await seedStablePending();
    await db.node.delete({ where: { id: source.id } });
    expect(await db.pendingEdge.findUnique({ where: { id: pending.id } })).toBeNull();
    expect((await db.memory.findUniqueOrThrow({ where: { id: memoryId } })).pendingEdgeCount).toBe(1);

    await expect(runPendingEdgePromotionSweep(db)).resolves.toEqual({
      promoted: 0,
      failed: 0,
      examined: 0,
    });
    expect((await db.memory.findUniqueOrThrow({ where: { id: memoryId } })).pendingEdgeCount).toBe(0);
  });

  it('retains pending work when another cross-memory edge occupies its derived loc', async () => {
    const { source, target, pending } = await seedStablePending();
    const { graph: otherMemory } = await createDbOrgAndGraph(db, {
      orgName: `pending-collision-${Date.now()}`,
      graphName: 'pending/collision',
    });
    const otherTarget = await createDbNode(db, { memoryId: otherMemory.id, loc: target.loc });
    const occupiedLoc = deriveEdgeLoc(source.loc, 'durable', otherTarget.loc);
    const occupied = await db.edge.create({
      data: {
        id: generateId(),
        memoryId,
        sourceId: source.id,
        targetId: otherTarget.id,
        loc: occupiedLoc,
        name: 'durable',
      },
    });

    await expect(runPendingEdgePromotionSweep(db)).resolves.toEqual({
      promoted: 0,
      failed: 1,
      examined: 1,
    });
    expect(await db.pendingEdge.findUnique({ where: { id: pending.id } })).not.toBeNull();
    expect(await db.edge.findUniqueOrThrow({ where: { id: occupied.id } })).toMatchObject({
      sourceId: source.id,
      targetId: otherTarget.id,
      deletedAt: null,
    });
    expect(await db.edge.count({
      where: { sourceId: source.id, targetId: target.id, name: 'durable', deletedAt: null },
    })).toBe(0);
    expect((await db.memory.findUniqueOrThrow({ where: { id: memoryId } })).pendingEdgeCount).toBe(1);
  });

  it('fires on its own schedule so restart recovery is an active path', async () => {
    const { source, target, pending } = await seedStablePending();
    loop = startPendingEdgePromotionSweepLoop(db, 10_000, 5);

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && await db.pendingEdge.findUnique({ where: { id: pending.id } })) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(await db.pendingEdge.findUnique({ where: { id: pending.id } })).toBeNull();
    expect(await db.edge.findFirst({
      where: { sourceId: source.id, targetId: target.id, name: 'durable', deletedAt: null },
    })).not.toBeNull();
  });
});
