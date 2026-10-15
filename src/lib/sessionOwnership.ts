import type { PrismaClient } from '../generated/prisma/index.js';
import { keyEverHeldHostOperate, recordHostKeyUseApart } from './hostOperations/hostKey.js';

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
 *  3. Otherwise only a USER-LESS session: one attributed to no person, the kind App keys start. Never a session a
 *     person is behind, worker sessions included (Holger's ruling A via Vera, team chat #11860, which resolved #932's
 *     open question). #932's purpose, an App closing the sessions it runs, survives.
 *
 * `launchOperationId` is REQUIRED in the session shape, so a caller that forgot to select it fails to compile rather
 * than reading `undefined` as "not launched". A pure App principal with no `appKeyId` (not an `hdr_app_` key) cannot
 * have been granted a scope, so rule 2 does not apply to it; rule 1 still does.
 *
 * Race: a session's `launchOperationId` is set when it is created and never changes, and scope rows are revoked,
 * never deleted. `userId` moves only to another person (an account merge) or, when that person's account is deleted,
 * to null (`onDelete: SetNull`), after which no person is behind the session and rule 3 rightly admits it. So no
 * concurrent write turns a refusal into a pass while a person is still behind the session.
 */
export async function appPrincipalMayWriteSession(
  db: Parameters<typeof keyEverHeldHostOperate>[0],
  principal: { userId?: string | null; appId?: string | null; appKeyId?: string | null },
  session: { appId: string | null; userId: string | null; launchOperationId: string | null },
): Promise<boolean> {
  if (principal.userId || !principal.appId || session.appId !== principal.appId) return false;
  if (session.launchOperationId) return false;
  if (session.userId) return false;
  if (principal.appKeyId && (await keyEverHeldHostOperate(db, principal.appKeyId))) return false;
  return true;
}

/**
 * #1969 (cor:agt:070:07: every call the platform refuses a host key is recorded) — the session write gate's App branch
 * WITH its use record, the one call both surfaces make: GraphQL `requireSessionWriteAccess` (updateSession, endSession,
 * and the gate's other callers) and MCP `hadron_end_session`. So a refusal is recorded once, at one site, whichever
 * surface refused it.
 *
 * The DECISION is `appPrincipalMayWriteSession`'s alone and is taken first; the record is written afterwards, apart
 * (its own write, never a caller's transaction), only for a refusal, and never reads back into the answer:
 * `recordHostKeyUseApart` never throws, so a failed record leaves the refusal exactly as it was (#1932's rule).
 *
 * WHO IS RECORDED: a key that is, or ever was, a host key (`host:operate` granted, live or revoked): a host key's
 * refused use. A plain App key refused here (ruling A's user-less rule, #11860) is not a host-key use and records
 * nothing: `recordHostKeyUseApart` finds no host to record it under (Xylon's read of 070:07 on the #1969 gate). Pass
 * the ROOT client as `db`, so the record survives the refused call's rollback.
 */
export async function appPrincipalSessionWriteAllowed(
  db: PrismaClient,
  principal: { userId?: string | null; appId?: string | null; appKeyId?: string | null },
  session: { appId: string | null; userId: string | null; launchOperationId: string | null },
): Promise<boolean> {
  const allowed = await appPrincipalMayWriteSession(db, principal, session);
  if (!allowed && !principal.userId && principal.appId && principal.appKeyId) {
    await recordHostKeyUseApart(db, { appKeyId: principal.appKeyId, appId: principal.appId }, 'session', {
      refusedCode: 'FORBIDDEN',
    });
  }
  return allowed;
}
