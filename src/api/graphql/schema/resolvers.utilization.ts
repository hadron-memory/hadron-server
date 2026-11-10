/** #3819 slice 1: advisory counts, with exactly the roster's admission and snapshot. */
import { GraphQLError } from 'graphql';
import type { Context } from './resolvers.helpers.js';
import { withRosterAppRead } from './resolvers.agentTaskMatching.js';
import { normalizeFamily, type ModelTier } from '../../../lib/agentTasks/family.js';
import { loadTeamUtilization } from '../../../lib/agentTasks/utilization.js';

interface UtilizationArgs { appRef: string; family?: string | null; tier?: string | null; role?: string | null; windowHours?: number | null }
export const utilizationQueries = {
  teamUtilization: (_: unknown, args: UtilizationArgs, ctx: Context) => withRosterAppRead(ctx, args.appRef, async (readCtx, app) => {
    // Admission comes first: invalid filters never reveal whether a concealed App exists.
    const windowHours = args.windowHours ?? 24;
    if (!Number.isInteger(windowHours) || windowHours < 1 || windowHours > 168) {
      throw new GraphQLError('windowHours must be an integer from 1 to 168.', { extensions: { code: 'BAD_USER_INPUT' } });
    }
    const family = args.family == null ? null : normalizeFamily(args.family);
    if ((args.family != null && family == null) || (args.tier != null && !['high', 'mid', 'low'].includes(args.tier))) {
      throw new GraphQLError('Invalid utilization family or tier.', { extensions: { code: 'BAD_USER_INPUT' } });
    }
    return loadTeamUtilization(readCtx.db, app.id, new Date(), windowHours, { family, tier: args.tier as ModelTier | null, role: args.role });
  }),
};
