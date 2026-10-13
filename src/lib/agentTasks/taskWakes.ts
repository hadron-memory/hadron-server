// #1708 — task events as a due-wake relevance source. Red-first stub.
import type { PrismaClient } from '../../generated/prisma/index.js';

export async function recordUndeliverableTaskWakes(_db: PrismaClient, _now = new Date()): Promise<number> {
  return 0;
}
