/**
 * #3649 slice C: the grant row lock a grant signing completion takes (lock order step 6 of the refold's C row), in its own module
 * so a two-connection race test can pause a real completion right after it (findings:race-a-real-writer-by-pausing-after-its-anchors).
 * Lock first, judge second: the caller reads and judges the row in a SECOND statement, on the clock read after its last lock.
 */
import type { Prisma } from '../../generated/prisma/index.js';

/** `FOR UPDATE` on the grant of `appId`; true when the row exists. */
export async function lockGrantForSigning(tx: Prisma.TransactionClient, grantId: string, appId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM grants WHERE id = ${grantId} AND app_id = ${appId} FOR UPDATE`;
  return rows.length === 1;
}
