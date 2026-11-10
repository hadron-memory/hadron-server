import type { Prisma } from '../../generated/prisma/index.js';
import { GraphQLError } from 'graphql';

/** #2644: after stop-fence, before reportsTo/worker/task rows, on every task decision. */
export async function lockTaskGraph(tx: Prisma.TransactionClient, appId: string, mode: 'shared' | 'exclusive' = 'exclusive'): Promise<void> {
  if (mode === 'shared') await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${'task-blockers:' + appId}, 0))`;
  else await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'task-blockers:' + appId}, 0))`;
}
/** The single range rule used by creates, dedicated mutations and future edit calls. */
export function taskPriority(value: number | null | undefined): number {
  if (value == null) return 1;
  if (!Number.isInteger(value) || value < 1 || value > 5) {
    throw new GraphQLError('priority must be an integer from 1 to 5.', { extensions: { code: 'BAD_USER_INPUT' } });
  }
  return value;
}
/** Caller holds the App graph lock and has checked assigner authority and same-App refs. */
export async function addTaskBlocker(tx: Prisma.TransactionClient, taskId: string, blockerTaskId: string): Promise<void> {
  const cyclic = await tx.$queryRaw<{ found: boolean }[]>`
    WITH RECURSIVE reach(id) AS (
      SELECT ${blockerTaskId}::text UNION
      SELECT b.blocker_task_id FROM agent_task_blockers b JOIN reach r ON b.task_id = r.id
    ) SELECT EXISTS(SELECT 1 FROM reach WHERE id = ${taskId}) AS found`;
  if (cyclic[0]?.found) throw new GraphQLError('This blocker would create a cycle.', { extensions: { code: 'TASK_BLOCKER_CYCLE' } });
  await tx.agentTaskBlocker.upsert({ where: { taskId_blockerTaskId: { taskId, blockerTaskId } },
    create: { taskId, blockerTaskId }, update: {} });
}
/** The single unlink path. SQL owns last-blocker release, including owner cascades. */
export async function removeTaskBlocker(tx: Prisma.TransactionClient, taskId: string, blockerTaskId: string): Promise<void> {
  await tx.agentTaskBlocker.deleteMany({ where: { taskId, blockerTaskId } });
}
