/**
 * #4280: the one role check for a command a worker may run only in some roles (the reuse-the-shared-gate invariant:
 * the next role-gated command calls this, not an inline check).
 *
 * It reads the worker's CURRENT `Worker.role` from the worker row, at request time, in the caller's transaction. Never
 * `Session.role`: that is the role at bind (#2458, cor:dmo:050:11), history, so a worker recast out of a role would
 * keep that role's rights for as long as its session stayed open. The session proves which worker acts; the worker row
 * says what it may do now. A retired worker, or a worker of another App, has no role here.
 *
 * Read without a row lock, on purpose: a caller already holds its target's row (a task), and taking the worker row
 * after it would invert the order of writers that lock a worker and then its tasks (a retirement). A recast that
 * committed before this statement is seen; one that commits after it is ordered after the act.
 */
import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';

type Db = PrismaClient | Prisma.TransactionClient;

export async function workerHasRole(db: Db, workerId: string, appId: string, roles: readonly string[]): Promise<boolean> {
  const worker = await db.worker.findFirst({ where: { id: workerId, appId, retiredAt: null }, select: { role: true } });
  return worker?.role != null && roles.includes(worker.role);
}
