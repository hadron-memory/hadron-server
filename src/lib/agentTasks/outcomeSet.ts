/**
 * #2652 (cor:agt:050:30, slice a): a team's closed set of finish outcomes.
 *
 * The set comes from the system memory of the agent installed as the team's App: the node at
 * `schema:task-outcomes`, found by the same resolver #2420 uses for `schema:task-properties` (`readTeamSchemaNode`,
 * one resolver, not a second). Its `data` is `{"outcomes": ["approved", "changes-requested", ...]}`.
 *
 *   - No Team Agent, or no node: no set; any one word is accepted, as before (050:01, R122).
 *   - A usable set: an outcome outside it is refused with TASK_OUTCOME_NOT_IN_SET, before any write.
 *   - A node that exists but can't be used (not that shape, an empty list, an entry that isn't an outcome word, more
 *     than TASK_OUTCOME_SET_MAX entries) or two Team Agents refuses with TASK_OUTCOME_SET_UNUSABLE: fail closed, as a
 *     broken properties schema does, never "no set". Two Team Agents refuse only when one of them has the node, so an
 *     App with no set anywhere finishes exactly as before.
 *
 * Read at finish time only, so changing the set never touches a finished task's result. The platform compares words
 * and never interprets them ("the platform never knows what the work is"). The refusal does not echo the set: the
 * finisher may not be able to read the Team Agent's memory (the #2420 rule for schema text).
 */
import { GraphQLError } from 'graphql';
import type { Prisma } from '../../generated/prisma/index.js';
import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';
import { readTeamSchemaNode } from './properties.js';

/** Where the team's outcome set lives in the Team Agent's system memory. */
export const TASK_OUTCOME_SET_LOC = 'schema:task-outcomes';

/** The most outcomes a set may list. A review scale runs to a handful; this is far above that. */
export const TASK_OUTCOME_SET_MAX = 100;

const refusal = (code: string, message: string) => new GraphQLError(message, { extensions: { code } });

/**
 * Refuse `outcome` unless the team's set admits it. `isOutcomeWord` is the finish path's own one-word test, so a set
 * entry that the finish would refuse anyway makes the set unusable rather than silently unreachable.
 */
export async function checkOutcomeInTeamSet(
  tx: Prisma.TransactionClient,
  txCtx: Context,
  appId: string,
  outcome: string,
  isOutcomeWord: (word: string) => boolean,
): Promise<void> {
  const unusable = (why: string) => refusal(
    'TASK_OUTCOME_SET_UNUSABLE',
    `The team's ${TASK_OUTCOME_SET_LOC} ${why}, so no task can be finished until it is fixed.`,
  );
  const data = await readTeamSchemaNode(tx, txCtx, appId, TASK_OUTCOME_SET_LOC,
    () => unusable('cannot be chosen: more than one installed Agent carries a roles: branch'), { ambiguousOnlyIfAnyHasNode: true });
  if (data === undefined) return;
  const outcomes = data !== null && typeof data === 'object' && !Array.isArray(data) ? (data as { outcomes?: unknown }).outcomes : undefined;
  if (!Array.isArray(outcomes) || outcomes.length === 0 || outcomes.length > TASK_OUTCOME_SET_MAX
    || !outcomes.every((o) => typeof o === 'string' && isOutcomeWord(o))) {
    throw unusable(`node exists but is not {"outcomes": [...]} with 1 to ${TASK_OUTCOME_SET_MAX} one-word outcomes`);
  }
  if (!(outcomes as string[]).includes(outcome)) {
    throw refusal(
      'TASK_OUTCOME_NOT_IN_SET',
      `"${outcome}" is not one of the team's outcomes (${TASK_OUTCOME_SET_LOC}); finish with one of them.`,
    );
  }
}
