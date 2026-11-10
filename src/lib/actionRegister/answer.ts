/** #3449: optional code-to-role-task projection, read as the caller (cor:agt:110:03). */
import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';
import { withoutRequestCaches } from '../../api/graphql/schema/resolvers.helpers.js';
import { boundedRead } from '../../api/graphql/schema/resolvers.taskWarnings.js';
import { RegisterLookup } from './lookup.js';

export type { ActionAnswer } from './answerCore.js';
import { answerWithLookup, type ActionAnswer } from './answerCore.js';

/** Post-commit guidance: a failed/expired read never reverses an accepted event. */
export async function resolveActionAnswer(ctx: Context, appId: string, code: string, agentId: string | null): Promise<ActionAnswer> {
  const withheld: ActionAnswer = { code, state: 'WITHHELD', taskLoc: null, taskUrn: null };
  // Holger ruling 0159: a caller with no Agent gets code only, with no lookup.
  if (!agentId) return withheld;
  try {
    return await boundedRead(ctx, async (tx, deadline) => {
      const c = withoutRequestCaches(ctx, tx);
      return answerWithLookup(new RegisterLookup(tx, c, appId, deadline), c, code, agentId);
    });
  } catch {
    // Fixed category only: never log the caller, code, task loc or private failure details.
    console.warn('action_register.answer_failed');
    return withheld;
  }
}
