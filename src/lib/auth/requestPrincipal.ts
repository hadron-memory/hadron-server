import { currentActorAmbiguity } from '../requestActor.js';
import { isRunPrincipal } from './runPrincipal.js';
import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';

/** Principal refusals shared by direct-user reads and instructed acts (#2448, #3307). */
export function isRefusedPrincipal(ctx: Context): boolean {
  return !ctx.userId || !!ctx.impersonation || isRunPrincipal(ctx)
    || currentActorAmbiguity() !== null || !!ctx.sessionBindingRefused;
}
