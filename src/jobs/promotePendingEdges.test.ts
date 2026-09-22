import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbNode, createDbOrgAndGraph } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
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
