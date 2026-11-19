/** #3819 slice 1: advisory counts, with exactly the roster's admission and snapshot. */
import { GraphQLError } from 'graphql';
import type { Context } from './resolvers.helpers.js';
import { withRosterAppRead } from './resolvers.agentTaskMatching.js';
import { normalizeFamily, type ModelTier } from '../../../lib/agentTasks/family.js';
import { loadTeamUtilization } from '../../../lib/agentTasks/utilization.js';

export interface UtilizationArgs { appRef: string; family?: string | null; tier?: string | null; role?: string | null; windowHours?: number | null }
export const utilizationQueries = {
  teamUtilization: async (_: unknown, args: UtilizationArgs, ctx: Context) => {
    // #4497: the argument checks come BEFORE admission and before any transaction. They depend only on the arguments, so
    // they answer the same for every App (readable, concealed or missing): they reveal nothing about whether an App
    // exists and take no transaction slot, and a busy store can no longer dress a caller fault as a retryable
    // TEAM_READ_BUSY. Valid input is unchanged: the roster's refusal, byte for byte (cor:agt:060:13).
    const windowHours = args.windowHours ?? 24;
    if (!Number.isInteger(windowHours) || windowHours < 1 || windowHours > 168) {
      throw new GraphQLError('windowHours must be an integer from 1 to 168.', { extensions: { code: 'BAD_USER_INPUT' } });
    }
    const family = args.family == null ? null : normalizeFamily(args.family);
    if ((args.family != null && family == null) || (args.tier != null && !['high', 'mid', 'low'].includes(args.tier))) {
      throw new GraphQLError('Invalid utilization family or tier.', { extensions: { code: 'BAD_USER_INPUT' } });
    }
    return withRosterAppRead(ctx, args.appRef, async (readCtx, app) =>
      loadTeamUtilization(readCtx.db, app.id, new Date(), windowHours, { family, tier: args.tier as ModelTier | null, role: args.role }));
  },
};
