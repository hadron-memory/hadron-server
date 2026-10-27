/**
 * #2484 (cor:agt:010:01, epic #2435, #2431 slice A): an App's prefix-scoped write
 * grant on a memory, for its USERLESS runs.
 *
 * cor:agt:010:01 rules that a userless run may write where its App holds an
 * explicit, register-recorded read-write grant, and nowhere else. The grant is a
 * row per (App, memory, loc prefix) in `app_memory_write_grants`. It permits node
 * CREATE and UPDATE under the prefix, by a userless run principal of THAT App,
 * judged live at each write; nothing else and nobody else:
 *
 *  - not delete, move, edges, memory settings, stored files, worker or session
 *    rows: the arm below answers only when the write door names a destination
 *    ({@link WriteDestination}), and only the node create/update door does;
 *  - not another App's run, a user-backed run, an App key, a worker session or a
 *    person: {@link isUserlessRunPrincipal} is the whole identity test.
 *
 * The prefix matches the loc itself and its `:`-boundary descendants only, so
 * `reports:team-progress` does not match `reports:team-progressX`
 * ({@link grantCoversLoc}). It is judged on the destination AFTER `writeTo`
 * expansion (#2437): the door passes the loc it is about to write.
 *
 * Fail-closed shape: every check below can only refuse. The caller adds the
 * result to whatever the gate already decided (`true` here never narrows an
 * existing allow), so with no row, a revoked row, or any refusing check the run
 * has exactly the authority it had before this existed.
 *
 * Concurrency (the gate's "revoked authority cannot commit a later write"): the
 * App, memory and (for a personal/private target) owner rows are held `FOR SHARE`
 * so a change to the authority a grant rests on serializes with the write, and the
 * covering grant row is read `FOR SHARE`, and a revocation UPDATEs that row, so
 * a revoke cannot return while a write that read the grant is still open, and a
 * write that starts after it sees the terminal `revokedAt`. The node write door
 * re-runs its gate on the writing transaction (`assertMemoryWriteStateStable`),
 * which is where this lock is taken for real; outside a transaction it is a
 * plain read. For a personal or private target the owner's deciding
 * memberships are held `FOR SHARE` the same way, so a demotion cannot commit
 * between this check and the write.
 */
import type { PrismaClient } from '../generated/prisma/index.js';
import type { AuthContext } from '../middleware/auth.js';
import { managesApp } from './auth/appManagement.js';
import { isRunPrincipal } from './auth/runPrincipal.js';

/**
 * What a node write is about to do and where. Passed by the node write door
 * (`writeNodeCore`) and by the run write pre-check; no other verb names one,
 * which is what keeps delete, move, edge and settings writes out of reach.
 * `upsert` is create-or-update and needs both verbs.
 */
export interface WriteDestination {
  loc: string;
  verb: 'create' | 'update' | 'upsert';
}

/** `reports:team-progress` covers itself and `reports:team-progress:<anything>`; never `reports:team-progressX`. */
export function grantCoversLoc(prefix: string, loc: string): boolean {
  return loc === prefix || loc.startsWith(`${prefix}:`);
}

/**
 * A headless AppRun acting for its App alone: the run client id, an App, and NO
 * user, session or impersonation. A user-backed run carries its user's authority
 * (the conjunction rule) and gains nothing from this grant.
 */
export function isUserlessRunPrincipal(auth: Pick<AuthContext, 'clientId' | 'userId' | 'appId' | 'sessionId' | 'impersonation'>): boolean {
  return isRunPrincipal(auth) && !auth.userId && !!auth.appId && !auth.sessionId && !auth.impersonation;
}

type GrantApp = { id: string; organizationId: string | null; ownerUserId: string | null };
type GrantMemory = {
  id: string;
  class: string;
  userId: string | null;
  organizationId: string | null;
  appId: string | null;
  ownerUserId: string | null;
  isEncrypted: boolean;
  isInstallMemory: boolean;
  userMemoryOfAgentId: string | null;
  workerOf: Array<{ id: string }>;
};

export const GRANT_MEMORY_SELECT = {
  id: true, class: true, userId: true, organizationId: true, appId: true, ownerUserId: true,
  isEncrypted: true, isInstallMemory: true, userMemoryOfAgentId: true,
  workerOf: { select: { id: true } },
} as const;

/** A personal or private memory: strictly its owner's, decided by `Memory.userId`. */
export const isStrictOwnerClass = (memoryClass: string): boolean => memoryClass === 'personal' || memoryClass === 'private';

/**
 * The App's own TEAM space: `class='app'`, this App, and neither a Worker's working memory nor a session row
 * (findings:app-class-is-four-row-shapes). Bare `appId + class='app'` would admit both.
 */
function isTeamSpaceOf(app: GrantApp, memory: GrantMemory): boolean {
  return memory.class === 'app' && memory.appId === app.id && memory.workerOf.length === 0 &&
    memory.userMemoryOfAgentId === null && !memory.isInstallMemory;
}

/**
 * Can this App hold a write grant on this memory at all, whoever asks and whenever? The part of the rule that does
 * not depend on a person: encrypted is never grantable, an install memory has its own audience, a shared memory
 * must be one the App's own org or team space already holds (no tenancy change), and a personal or private memory
 * has an owner to be judged against. Returns the refusal reason, or null. Used when a grant is SET and again, live,
 * at every write, so a memory that stops qualifying stops taking writes.
 */
export function grantTargetRefusal(app: GrantApp, memory: GrantMemory): string | null {
  if (memory.isEncrypted) return 'encrypted';
  if (memory.isInstallMemory) return 'install-memory';
  if (isStrictOwnerClass(memory.class)) return memory.userId ? null : 'no-owner';
  if (isTeamSpaceOf(app, memory)) return null;
  if (memory.class !== 'app' && app.organizationId !== null && memory.organizationId === app.organizationId &&
      memory.ownerUserId === null) return null;
  return 'tenancy';
}

/**
 * The grant arm of the write gate. True only when ALL hold, read on `db` (the writing transaction when called from
 * the node write door):
 *  1. the caller is a userless run principal and the write names a destination;
 *  2. a live row of THIS App covers the destination loc (row held FOR SHARE);
 *  3. the App is live, the memory is live, and {@link grantTargetRefusal} still passes;
 *  4. for a personal or private memory: the grantor still owns it AND still manages the App.
 */
export async function userlessRunHoldsWriteGrant(
  db: PrismaClient,
  auth: AuthContext,
  memoryId: string,
  destination: WriteDestination,
): Promise<boolean> {
  if (!isUserlessRunPrincipal(auth)) return false;
  const appId = auth.appId!;
  const { loc } = destination;
  // Hold the authority rows this decision rests on, so a change to any of them either commits before this read and
  // is seen, or waits for the write to finish: the App going away, the memory being encrypted, deleted or moving to
  // another owner. The grant row alone cannot serialize those. Outside a transaction these are plain reads. The
  // writing transaction already holds the memory row and the node row when it gets here, so for a team-space grant
  // this takes the App AFTER the memory, the reverse of an App hard delete's cascade (App, then its memories): the
  // two can deadlock, and Postgres aborts one of them, which the write door reports as NODE_WRITE_CONFLICT. Safe,
  // not ordered.
  await db.$queryRaw`SELECT id FROM apps WHERE id = ${appId} FOR SHARE`;
  await db.$queryRaw`SELECT id FROM memories WHERE id = ${memoryId} FOR SHARE`;
  const rows = await db.$queryRaw<Array<{ id: string; granted_by: string }>>`
    SELECT id, granted_by FROM app_memory_write_grants
    WHERE app_id = ${appId} AND memory_id = ${memoryId} AND revoked_at IS NULL
      AND (prefix = ${loc}::text OR starts_with(${loc}::text, prefix || ':'))
    ORDER BY created_at ASC, id ASC
    FOR SHARE`;
  if (rows.length === 0) return false;

  const app = await db.app.findFirst({
    where: { id: appId, deletedAt: null, uninstalledAt: null },
    select: { id: true, organizationId: true, ownerUserId: true },
  });
  if (!app) return false;
  const memory = await db.memory.findFirst({ where: { id: memoryId, deletedAt: null }, select: GRANT_MEMORY_SELECT });
  if (!memory || grantTargetRefusal(app, memory) !== null) return false;
  // A node that carries derived INCLUDE edges is not a grant target: a write that replaces its content re-derives
  // them, and deleting an edge to a node outside the prefix is an edge write the grant does not permit. The writing
  // transaction holds this node's row, so the edges read here are the ones the write would replace.
  if (await db.edge.findFirst({ where: { governedKind: 'INCLUDE', source: { memoryId, loc } }, select: { id: true } })) return false;
  if (!isStrictOwnerClass(memory.class)) return true;

  // Personal / private: the grant is the OWNER's delegation, made as a person who manages the App. It holds only
  // while that is still true; ownership and App management are both re-read here, with the memberships held.
  return rows.some((row) => row.granted_by === memory.userId) && await ownerStillManagesApp(db, memory.userId!, app);
}

/** Hold the owner's deciding memberships `FOR SHARE`, then decide. A demotion that committed first is seen; a later one waits. */
export async function ownerStillManagesApp(db: PrismaClient, userId: string, app: GrantApp): Promise<boolean> {
  await db.$queryRaw`SELECT user_id FROM app_members WHERE app_id = ${app.id} AND user_id = ${userId} FOR SHARE`;
  if (app.organizationId) {
    await db.$queryRaw`SELECT user_id FROM org_members WHERE organization_id = ${app.organizationId} AND user_id = ${userId} FOR SHARE`;
  }
  await db.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR SHARE`;
  const user = await db.user.findFirst({ where: { id: userId, deletedAt: null }, select: { id: true, roles: true } });
  if (!user) return false;
  return managesApp({ db, userId: user.id, roles: user.roles }, app);
}
