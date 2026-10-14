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
