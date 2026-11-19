import type { Prisma } from '../../generated/prisma/index.js';

/** The title of the reserved project `AT0`. Fixed: nobody edits it (every update of AT0 is refused). */
export const PROJECT_ZERO_TITLE = 'No project';
export const PROJECT_ZERO_HANDLE = 'AT0';

/**
 * #2553 (cor:agt:050:01, Proposed handle paragraph): the reserved project `AT0`, "no project", of one App. A task made
 * with no project is its child (`AT0.388`). It is a `backlog` row, so the matcher (pending only) and the stall
 * evaluator (backlog is terminal) never see it, and the invariants file keeps it there. Created ONCE per App by the
 * platform, in the transaction that creates the App (both create sites in resolvers.mutation.app.ts) and by the
 * migration's backfill; this helper is the one writer, idempotent (`createMany skipDuplicates` is ON CONFLICT DO NOTHING),
 * and `insertTask` also calls it so an App made any other way (a seed, a test fixture) still gets its AT0 before its
 * first task. Its project counter starts at 0, so the first real project is AT1 and nothing else can take 0.
 *
 * `owner` is whoever exists at that moment: the App's owner, else the person creating it. With neither (a platform
 * admin creating an org App) the call is a no-op and AT0 appears with the first task, owned by that task's creator.
 * Returns the AT0 row's id, or null when it does not exist yet.
 */
export async function ensureProjectZero(
  tx: Prisma.TransactionClient,
  appId: string,
  owner: { userId?: string | null; workerId?: string | null } | null,
): Promise<string | null> {
  const existing = await tx.agentTask.findUnique({ where: { appId_handle: { appId, handle: PROJECT_ZERO_HANDLE } }, select: { id: true } });
  if (existing) return existing.id;
  if (!owner?.userId && !owner?.workerId) return null;
  await tx.agentTaskCounter.createMany({ data: [{ appId, parentTaskId: null, lastNumber: 0n }], skipDuplicates: true });
  await tx.agentTask.createMany({
    data: [{
      appId, title: PROJECT_ZERO_TITLE, status: 'backlog', closeSessionWhenDone: false,
      taskNumber: 0n, handle: PROJECT_ZERO_HANDLE,
      ownerUserId: owner.userId ?? null, ownerWorkerId: owner.userId ? null : (owner.workerId ?? null),
    }],
    skipDuplicates: true,
  });
  return (await tx.agentTask.findUnique({ where: { appId_handle: { appId, handle: PROJECT_ZERO_HANDLE } }, select: { id: true } }))?.id ?? null;
}

/**
 * The ONE root predicate (rev 8 build assumption, pending Holger's ruling; carried to #2420 / docs#500): a root is the
 * topmost task other than AT0, so a project (AT1..) and a task with no project (AT0.<n>, whose parent is AT0) both
 * count. AT0 itself is never a root. A different ruling changes this function and nothing else.
 */
export function rootTaskWhere(): Prisma.AgentTaskWhereInput {
  return { OR: [{ parentTaskId: null }, { parent: { handle: PROJECT_ZERO_HANDLE } }], handle: { not: PROJECT_ZERO_HANDLE } };
}
