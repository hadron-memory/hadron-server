import type { PrismaClient } from '../../generated/prisma/index.js';
/** STUB for the red pins (#3775 A); the real recorder lands in the next commit. */
export async function recordStallPass(_db: PrismaClient, _now: Date): Promise<{ gapEnded: boolean }> {
  return { gapEnded: false };
}
