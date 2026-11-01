import type { PrismaClient } from '../../generated/prisma/index.js';
import { configFence, assertRateReadiness, RateConfigurationError } from './index.js';
import { readRateKeys, keyFingerprint } from './config.js';

/** Operator maintenance only; no public config surface. Prepare both keys on every serving process before calling. */
export async function beginRateKeyOverlap(db: PrismaClient, newKeyId: string) {
  await assertRateReadiness(db);
  return db.$transaction(async tx => {
    await configFence(tx,true);
    const ring = readRateKeys();
    const m = await tx.rateLimitManifest.findUniqueOrThrow({ where: { id: 'global' } });
    if (m.keyIds.length !== 1 || m.keyIds[0] === newKeyId || !ring.keys.has(newKeyId)) throw new RateConfigurationError();
    const [{now}] = await tx.$queryRaw<Array<{now:Date}>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
    return tx.rateLimitManifest.update({ where: { id: 'global' }, data: {
      keyIds: [...m.keyIds,newKeyId], fingerprints: { ...(m.fingerprints as Record<string,string>), [newKeyId]: keyFingerprint(ring.keys.get(newKeyId)!) },
      overlapStartedAt: now, version: { increment: 1 },
    } });
  });
}
/** Exclusive fence drains every prior admission; 24h overlap exceeds every active window. Never erase counters to rotate. */
export async function retireRateKey(db: PrismaClient) {
  await assertRateReadiness(db);
  return db.$transaction(async tx => {
    await configFence(tx,true);
    const m = await tx.rateLimitManifest.findUniqueOrThrow({ where: { id: 'global' } });
    const [{now}] = await tx.$queryRaw<Array<{now:Date}>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
    if (m.keyIds.length !== 2 || !m.overlapStartedAt || now.getTime()-m.overlapStartedAt.getTime() < 86400_000) throw new RateConfigurationError();
    const keep = m.keyIds[1];
    return tx.rateLimitManifest.update({ where: { id: 'global' }, data: { keyIds: [keep], fingerprints: { [keep]: (m.fingerprints as Record<string,string>)[keep] }, overlapStartedAt: null, version: { increment: 1 } } });
  });
}
