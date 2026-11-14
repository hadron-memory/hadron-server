/** #3982: Holger model A (gate 6816791184), qualifying cor:api:140:01/:02 for updateApp only. */
import { GraphQLError } from 'graphql';
import { AppNotFoundError, AmbiguousLegacyUrnError } from '../../../lib/entityRef/errors.js';
import { authorizationDenied } from '../../../lib/auth/authorizationDenied.js';
import { isAppParticipant } from '../../../lib/auth/appParticipantRead.js';
import { locateForDelete, type DeleteTarget } from './appInstallState.js';
import { mayReadAppTasks } from './resolvers.agentTask.js';
import { requireOwnerOrOrgRole, type Context } from './resolvers.helpers.js';

type App = Extract<DeleteTarget, { kind: 'app' }>['app'];

/** Return management admission, catching only the shared gate's typed denial; infrastructure faults propagate. */
async function mayManage(ctx: Context, app: App): Promise<boolean> {
  try {
    await requireOwnerOrOrgRole(ctx, app, 'ADMIN');
    return true;
  } catch (e) {
    if (e instanceof GraphQLError && e.extensions.code === 'FORBIDDEN' && e.message === 'Forbidden') return false;
    throw e;
  }
}

/** Shared person participation (also on retained rows), or the existing live key/run-grant read gate. No write authority. */
async function mayReach(ctx: Context, app: App): Promise<boolean> {
  return ctx.userId ? isAppParticipant(ctx, app) : mayReadAppTasks(ctx, app.id);
}

/**
 * Locate without disclosing, then partition reach from authority. Preserve current management authority; disclose
 * ambiguity only to a manager of EVERY live claimant. A partial reader learns only their existing reach, never a
 * claimant's identity. State/input checks belong to the caller AFTER this admission, with #3980's locked checks intact.
 */
export async function requireUpdateAppTarget(ctx: Context, ref: string): Promise<App> {
  const target = await locateForDelete(ctx, ref);
  if (target.kind === 'none') throw new AppNotFoundError(ref);
  if (target.kind === 'ambiguous') {
    let allManage = target.candidates.length > 0;
    let anyReach = false;
    for (const app of target.candidates) {
      const manages = await mayManage(ctx, app);
      allManage = allManage && manages;
      // Do not short-circuit later claimants: their read/DB failures must still propagate.
      const reaches = manages || await mayReach(ctx, app);
      anyReach = anyReach || reaches;
    }
    if (allManage) throw new AmbiguousLegacyUrnError(ref);
    if (anyReach) throw authorizationDenied();
    throw new AppNotFoundError(ref);
  }
  if (await mayManage(ctx, target.app)) return target.app;
  if (await mayReach(ctx, target.app)) throw authorizationDenied();
  throw new AppNotFoundError(ref);
}
