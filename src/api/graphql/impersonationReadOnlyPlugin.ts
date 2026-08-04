/**
 * Read-only enforcement for admin-impersonation sessions — the ONE chokepoint
 * that blocks every GraphQL mutation for an impersonated request, so no
 * per-resolver deny-list can drift (src/lib/auth/impersonation.ts has the
 * contract; the token is resolved in src/middleware/auth.ts).
 *
 * Runs at didResolveOperation: when the request context carries
 * `impersonation` and the operation is a mutation, every top-level field of
 * the mutation's selection set must be on the allowlist — only
 * `stopImpersonation` (ending the session is the sole permitted write) and
 * the `__typename` introspection meta-field. Fragment spreads and inline
 * fragments on Mutation are legal GraphQL and are resolved against the
 * document so they can't smuggle a field past the check; aliases don't hide
 * the real `field.name.value`.
 *
 * Non-GraphQL surfaces are handled separately: /mcp rejects impersonation
 * tokens at session init, and /auth/me rejects `imp`-bearing JWTs.
 */

import { GraphQLError } from 'graphql';
import type {
  DocumentNode,
  FragmentDefinitionNode,
  OperationDefinitionNode,
  SelectionSetNode,
} from 'graphql';
import type { ApolloServerPlugin } from '@apollo/server';
import type { ImpersonationContext } from '../../lib/auth/impersonation.js';

const ALLOWED_MUTATION_FIELDS = new Set(['stopImpersonation', '__typename']);

/**
 * Collect the top-level field names of a mutation selection set, expanding
 * fragment spreads / inline fragments (depth-bounded — fragments cannot
 * legally cycle, but a malformed document must not loop us).
 */
function topLevelFieldNames(
  selectionSet: SelectionSetNode,
  fragments: Map<string, FragmentDefinitionNode>,
  depth = 0,
): string[] {
  if (depth > 10) return [];
  const names: string[] = [];
  for (const sel of selectionSet.selections) {
    if (sel.kind === 'Field') {
      names.push(sel.name.value);
    } else if (sel.kind === 'InlineFragment') {
      names.push(...topLevelFieldNames(sel.selectionSet, fragments, depth + 1));
    } else if (sel.kind === 'FragmentSpread') {
      const frag = fragments.get(sel.name.value);
      if (frag) names.push(...topLevelFieldNames(frag.selectionSet, fragments, depth + 1));
    }
  }
  return names;
}

function fragmentMap(document: DocumentNode): Map<string, FragmentDefinitionNode> {
  const map = new Map<string, FragmentDefinitionNode>();
  for (const def of document.definitions) {
    if (def.kind === 'FragmentDefinition') map.set(def.name.value, def);
  }
  return map;
}

export const impersonationReadOnlyPlugin: ApolloServerPlugin<{
  impersonation?: ImpersonationContext;
}> = {
  async requestDidStart() {
    return {
      async didResolveOperation({ operation, document, contextValue }) {
        if (!contextValue.impersonation) return;
        const op = operation as OperationDefinitionNode | undefined;
        if (!op || op.operation !== 'mutation') return;
        const fields = topLevelFieldNames(op.selectionSet, fragmentMap(document));
        const blocked = fields.filter((f) => !ALLOWED_MUTATION_FIELDS.has(f));
        if (blocked.length > 0) {
          throw new GraphQLError(
            'This is a read-only impersonation session; mutations are disabled.',
            { extensions: { code: 'IMPERSONATION_READ_ONLY', blockedFields: blocked } },
          );
        }
      },
    };
  },
};
