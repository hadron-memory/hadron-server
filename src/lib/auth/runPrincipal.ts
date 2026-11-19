import { internalRateIdentity } from '../rateLimit/identity.js';
/**
 * The client-id prefix of a headless AppRun principal (`runContext`,
 * cor:agt:010:01): the App plus an optional on-behalf-of user, never a session.
 */
export const RUN_CLIENT_PREFIX = 'run:';

/**
 * Is this principal an AppRun acting for its App (and possibly on a user's
 * behalf), rather than the user acting directly? A run carries `userId` and
 * `appId` but no `sessionId`, so a user-id check alone cannot tell it from a
 * direct user credential. Gates that grant a user something beyond their
 * App's scope must exclude runs (#1503).
 */
export function isRunPrincipal(auth: { clientId?: string | null }): boolean {
  return auth.clientId?.startsWith(RUN_CLIENT_PREFIX) === true;
}

/** One definition of the authority carried by a headless activation or setup. */
export function runAuthContext(run: { id: string; appId: string; userId: string | null; organizationId: string }): import('../../middleware/auth.js').AuthContext {
  return { limiterIdentity: internalRateIdentity(run.appId), appId: run.appId, userId: run.userId ?? undefined, organizationId: run.organizationId,
    clientId: `${RUN_CLIENT_PREFIX}${run.id}`, roles: [] };
}
