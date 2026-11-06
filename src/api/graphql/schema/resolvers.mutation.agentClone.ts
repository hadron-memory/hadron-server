// cloneAgent (#2245): a thin resolver; the transaction, locks and gates live in src/lib/agentClone/cloneAgent.ts.
import { cloneAgent } from '../../../lib/agentClone/cloneAgent.js';
import type { Context } from './resolvers.helpers.js';

export const agentCloneMutations = {
  cloneAgent: (
    _: unknown,
    args: { source: string; target: string; name?: string | null; slug?: string | null },
    ctx: Context,
  ) => cloneAgent(ctx, args),
};
