/**
 * #3690 (S2a): WHO A GRANT REACHES (cor:acl:140:06, Decided: rulings 0180, 0248, 0253 item 10, 0255 items 20, 20a and 20b).
 * A server function later phases call (#3483 enforces with it); nothing in this slice enforces with it, and reach is not
 * liveness: whether the grant ALLOWS an act is `live.ts`'s verdict, judged separately.
 *
 * A grant reaches its HOLDER, within its own App and nowhere else:
 *  - a grant naming a WORKER reaches that worker only, while the worker is not retired;
 *  - a grant to an AGENT is held by that agent IN THAT APP and reaches that agent's live (not retired) workers there, so many
 *    same-role workers need one grant. It reaches nothing while the agent is uninstalled, unlicensed or deleted, or the App is
 *    deleted (judged now, after the grant exists), and it never passes down the base-agent chain (item 20: requests reach down
 *    the chain, grants do not; an extending agent installed in the same App is not reached by its base's grant, item 20a);
 *  - a grant to a PERSON reaches an agent or worker only while that person drives the session, which the server cannot check
 *    (ruling 0180, the accepted gap), so it reaches no worker here; a grant to an APP names no worker either;
 *  - a grant whose holder departed (`holder_departed_at`) or whose App is soft-deleted reaches nothing.
 * The team-agent lookup is NOT used (ruling 0248: "Let's drop the lookup").
 */
import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import { isAgentInstalledAndLicensed } from '../appAgent.js';

type Db = PrismaClient | Prisma.TransactionClient;

/** The ids of the workers `grantId` reaches, in no particular order. Empty for an unknown grant. */
export async function workersReachedByGrant(db: Db, grantId: string): Promise<string[]> {
  const grant = await db.$queryRaw<Array<{ app_id: string; agent_id: string | null; worker_id: string | null }>>`
    SELECT g.app_id, g.agent_id, g.worker_id FROM grants g
    WHERE g.id = ${grantId} AND g.holder_departed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM apps a WHERE a.id = g.app_id AND a.deleted_at IS NOT NULL)`;
  const g = grant[0];
  if (!g) return [];
  if (g.worker_id !== null) {
    const rows = await db.worker.findMany({ where: { id: g.worker_id, appId: g.app_id, retiredAt: null }, select: { id: true } });
    return rows.map((r) => r.id);
  }
  if (g.agent_id !== null) {
    if (!(await isAgentInstalledAndLicensed(db, g.app_id, g.agent_id))) return [];
    const rows = await db.worker.findMany({ where: { agentId: g.agent_id, appId: g.app_id, retiredAt: null }, select: { id: true } });
    return rows.map((r) => r.id);
  }
  return [];
}

/** Whether `grantId` reaches `workerId` (see {@link workersReachedByGrant}). */
export async function grantReachesWorker(db: Db, grantId: string, workerId: string): Promise<boolean> {
  return (await workersReachedByGrant(db, grantId)).includes(workerId);
}
