import { GraphQLError } from 'graphql';
import { echoRootName, ROOT_NAME_RULE_TEXT, RootNameInvalidError, RootNameTakenError } from './mintPrincipal.js';

/**
 * Map the #692 principal pool's typed errors to user-facing refusals;
 * re-throw anything else. Use as a `.catch()` on a mint transaction.
 *
 * `RootNameTakenError` → the existing conflict refusal. `RootNameInvalidError`
 * (#4481, the #4415 root-name rule) → `ROOT_NAME_INVALID`, its own code so a
 * client can tell an unrepeatable name from a taken one.
 *
 * Reachability: every mint caller validates the name first (`normalizeHandle` /
 * `validateOrgRoot`), so `RootNameInvalidError` is a backstop no call reaches
 * today — the mapping exists so a future caller that skips validation still
 * surfaces a typed refusal, not an internal error. `RootNameTakenError` IS
 * reachable: the validators' availability probe and the mint are two steps, so
 * a concurrent mint of the same name makes the unique constraint refuse the
 * loser (`mintPrincipal` maps that `P2002`).
 *
 * Moved out of `resolvers.mutation.org.ts` by #4515 (no behavior change) so the
 * pool's tests no longer import a resolver module.
 */
export function rethrowRootNameErrors(err: unknown): never {
  if (err instanceof RootNameInvalidError) {
    throw new GraphQLError(
      `The name ${echoRootName(err.rootName)} is not a legal root name: ${ROOT_NAME_RULE_TEXT}`,
      { extensions: { code: 'ROOT_NAME_INVALID' } },
    );
  }
  if (err instanceof RootNameTakenError) {
    throw new GraphQLError(`The name "${err.rootName}" is already taken.`, {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }
  throw err;
}
