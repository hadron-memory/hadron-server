import type { PrismaClient } from '../generated/prisma/index.js';
import type { HadronJwtPayload } from './jwt.js';

/** Call only after verified login. All consent freshness uses this DB clock. */
export async function verifiedLoginEvidence(db: Pick<PrismaClient, '$queryRaw'>,
  method: NonNullable<HadronJwtPayload['login']>['method']): Promise<NonNullable<HadronJwtPayload['login']>> {
  const [{ now }] = await db.$queryRaw<{ now: Date }[]>`SELECT (clock_timestamp() AT TIME ZONE 'UTC') AS now`;
  return { at: now.getTime(), method };
}
