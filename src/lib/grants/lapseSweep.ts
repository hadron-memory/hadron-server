import type { PrismaClient } from '../../generated/prisma/index.js';

export interface LapseSweepOutcome { pairsJudged: number; pairsDeparted: number; grantsEnded: number }

/** #4178 (stub for the red pins; replaced by the implementation). */
export async function sweepLapsedAgentGrants(
  _db: PrismaClient,
  _opts: { batchSize?: number; maxPages?: number } = {},
): Promise<LapseSweepOutcome> {
  return { pairsJudged: 0, pairsDeparted: 0, grantsEnded: 0 };
}
