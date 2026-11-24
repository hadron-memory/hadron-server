/** #5078: every memory's stored live-node figure equals a recount of `nodes`, and no committed transaction left a change unfolded. */
import { expect } from 'vitest';
import type { PrismaClient } from '../generated/prisma/index.js';
import { findMemoryNodeTotalDrift } from '../lib/ownerLimits/nodeTotals.js';

export async function expectNodeTotalsExact(db: Pick<PrismaClient, '$queryRaw' | 'memoryNodePending'>): Promise<void> {
  expect(await findMemoryNodeTotalDrift(db)).toEqual([]);
  expect(await db.memoryNodePending.count()).toBe(0);
}
