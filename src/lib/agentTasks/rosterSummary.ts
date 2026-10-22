import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';

export type RosterTaskSummary = { id: string; title: string; status: 'pending' | 'started' };

/** Display only. The caller must admit the App's task audience before calling this loader. */
export async function loadRosterTaskSummaries(
  db: PrismaClient | Prisma.TransactionClient,
  appId: string,
  workerIds: string[],
): Promise<Map<string, RosterTaskSummary>> {
  if (!workerIds.length) return new Map();
  const rows = await db.$queryRaw<Array<RosterTaskSummary & { workerId: string }>>`
    SELECT DISTINCT ON (assignee_worker_id)
      assignee_worker_id AS "workerId", id, title, status
    FROM agent_tasks
    WHERE app_id = ${appId} AND assignee_worker_id IN (${Prisma.join(workerIds)})
      AND status IN ('started', 'pending')
    ORDER BY assignee_worker_id, CASE status WHEN 'started' THEN 0 ELSE 1 END,
      assigned_at ASC NULLS LAST, created_at ASC, id ASC
  `;
  return new Map(rows.map(({ workerId, ...summary }) => [workerId, summary]));
}
