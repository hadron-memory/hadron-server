/** #4225 S4b — stub: the pins are committed red first; the enforcement lands in the next commit. */
import type { PrismaClient } from '../../generated/prisma/index.js';

export async function contextCapTick(_db: PrismaClient, _now: Date = new Date()): Promise<number> {
  return 0;
}
