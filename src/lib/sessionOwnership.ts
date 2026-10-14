import { keyEverHeldHostOperate } from './hostOperations/hostKey.js';

/**
 * Session attribution ownership, shared by binding and usage recording (#1662).
 * A user owns their attributed sessions, never through impersonation. A pure
 * App principal owns its App's sessions, including end-user chatbot sessions.
 * Selecting an App as a user grants no App-key authority; admin roles grant no
 * attribution bypass. Lifecycle checks belong to the caller, so late usage on
 * an owned ended session can be recorded without binding or reviving it.
 */
export function ownsSession(
  principal: { userId?: string | null; appId?: string | null; impersonation?: unknown },
  session: { userId: string | null; appId: string | null; launchOperationId?: string | null },
): boolean {
  if (principal.impersonation) return false;
  if (principal.userId) return session.userId === principal.userId;
  // #1709 (Rook #10734, Holger's ruling A): a host-launched session is its holder's alone. No App key owns it, so none
  // binds it, attributes usage to it or keeps it live: not the host key that started it, nor another key of the App.
  if (session.launchOperationId) return false;
  return !!principal.appId && session.appId === principal.appId;
}

/**
 * #932's seam, held open pending Holger's ruling (the open question on hadron-server#1934, queued through Vera):
 * does an App key that never held `host:operate` keep #932's power to write its App's ORDINARY (non-launched)
 * sessions? Until it is ruled, yes, unchanged. A ruling of "no" flips this to false; nothing else moves.
 */
export const PLAIN_APP_KEY_WRITES_ORDINARY_APP_SESSIONS = true;

/**
 * May a PURE App principal WRITE this session of its own App: update it, end it, or record work against it?
 * The App branch of the session write gate, shared by GraphQL `requireSessionWriteAccess` and MCP
 * `hadron_end_session` so the two surfaces cannot drift (#931 and #1934 both found them apart).
 *
 * cor:agt:070:04, a host key never drives the session it starts, where "drives" is ANY session write (Ada's ruling,
 * team chat #11486). So, beyond the same-App requirement (#932):
 *  1. A host-launched session (one with a `launchOperationId`) is its holder's alone: no App key writes it, the host
 *     key that started it included. The same rule `ownsSession` applies to binding, liveness and usage (#1883).
 *  2. A key that holds, or ever held, `host:operate` writes no session of its App, launched or not, the rule #1919
 *     applies to the host-operations listing: revoking the scope never restores the power.
 *  3. Otherwise, {@link PLAIN_APP_KEY_WRITES_ORDINARY_APP_SESSIONS}.
 *
 * `launchOperationId` is REQUIRED in the session shape, so a caller that forgot to select it fails to compile rather
 * than reading `undefined` as "not launched". A pure App principal with no `appKeyId` (not an `hdr_app_` key) cannot
 * have been granted a scope, so rule 2 does not apply to it; rule 1 still does.
 *
 * Race: both inputs are append-only for this decision. A session's `launchOperationId` is set when it is created and
 * never changes, and scope rows are revoked, never deleted, so no concurrent write turns a refusal into a pass.
 */
export async function appPrincipalMayWriteSession(
  db: Parameters<typeof keyEverHeldHostOperate>[0],
  principal: { userId?: string | null; appId?: string | null; appKeyId?: string | null },
  session: { appId: string | null; launchOperationId: string | null },
): Promise<boolean> {
  if (principal.userId || !principal.appId || session.appId !== principal.appId) return false;
  if (session.launchOperationId) return false;
  if (principal.appKeyId && (await keyEverHeldHostOperate(db, principal.appKeyId))) return false;
  return PLAIN_APP_KEY_WRITES_ORDINARY_APP_SESSIONS;
}
