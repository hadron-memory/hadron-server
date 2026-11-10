/** #3308: the common lock set for an instructed/granted staff or member act. */
import type { Prisma } from '../../generated/prisma/index.js';
import { lockWorkersForAssignment } from '../agentTasks/workerLock.js';
import { lockAppManagerMemberships } from './appManagement.js';
import type { StaffActAdmission } from './instructedAct.js';

export async function lockStaffingAct(
  tx: Prisma.TransactionClient,
  app: { id: string; organizationId: string | null; ownerUserId: string | null },
  admission: StaffActAdmission,
  sessionId?: string,
  subjectIds: readonly string[] = [],
): Promise<void> {
  const ids = [...new Set([...subjectIds, ...(admission.kind === 'person' ? [] : [admission.workerId])])].sort();
  // Caller graph/stop/ticker locks precede this helper. Assignment precedes deciding memberships and Worker rows;
  // a grant revoker also takes Worker before grant. The final grant check follows these locks, never before them.
  await lockWorkersForAssignment(tx, ids);
  await lockAppManagerMemberships(tx, admission.userId, app);
  if (ids.length) await tx.$queryRaw`SELECT id FROM workers WHERE id = ANY(${ids}::text[]) ORDER BY id FOR UPDATE`;
  if (sessionId) await tx.$queryRaw`SELECT id FROM sessions WHERE id = ${sessionId} FOR SHARE`;
}
