import type { PrismaClient } from '../generated/prisma/index.js';
import { recordStopConsumerDeclaration, UNHOSTED_LANE } from '../lib/stopSignals/delivery.js';

/**
 * Test helper (#2169): declare every serving lane of `appId` (the unhosted lane and each host registration) as having a
 * stop-notice consumer, as of now, the way a consumer polling `dueWakes(accepts: [STOP])` would. For tests that exercise
 * stop signals themselves rather than the lane guard; call it again after registering a host.
 */
export async function declareAllStopLanes(db: PrismaClient, appId: string, now: Date = new Date()): Promise<void> {
  await recordStopConsumerDeclaration(db, appId, UNHOSTED_LANE, now);
  const regs = await db.hostRegistration.findMany({ where: { appId }, select: { id: true } });
  for (const r of regs) await recordStopConsumerDeclaration(db, appId, r.id, now);
}
