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
 * Bound on fragment/inline-fragment nesting we will walk. Generous — the one
 * allowed mutation is a single unnested field — and exceeding it FAILS CLOSED
 * rather than being treated as "nothing to block".
 */
const MAX_SELECTION_DEPTH = 64;

/**
 * Collect the top-level field names of a mutation selection set, expanding
 * fragment spreads and inline fragments.
 *
 * Returns `null` when the selection set could NOT be fully resolved — depth
 * limit exceeded, a fragment spread naming an unknown fragment, or a spread
 * cycle. **The caller MUST treat `null` as "block the operation"**, never as
 * "no fields found": an incomplete traversal cannot prove the absence of a
 * disallowed field.
 *
 * This is the fail-closed direction, and it is load-bearing. An earlier
 * version returned `[]` at the depth limit, which the caller read as "zero
 * blocked fields" — so a mutation hidden behind 11 nested inline fragments
 * (legal GraphQL) executed on a supposedly read-only session. Both PR #875
 * reviewers flagged it independently.
 */
function topLevelFieldNames(
  selectionSet: SelectionSetNode,
  fragments: Map<string, FragmentDefinitionNode>,
  // Fragment names on the CURRENT path, for cycle detection. Copied on
  // descent so two sibling spreads of the same fragment stay legal (only an
  // ancestor repeat is a cycle). GraphQL validation rejects cycles before we
  // run, so this is defense in depth.
  ancestorSpreads: ReadonlySet<string> = new Set(),
  depth = 0,
): string[] | null {
  if (depth > MAX_SELECTION_DEPTH) return null;
  const names: string[] = [];
  for (const sel of selectionSet.selections) {
    if (sel.kind === 'Field') {
      names.push(sel.name.value);
    } else if (sel.kind === 'InlineFragment') {
      const inner = topLevelFieldNames(sel.selectionSet, fragments, ancestorSpreads, depth + 1);
      if (inner === null) return null;
      names.push(...inner);
    } else if (sel.kind === 'FragmentSpread') {
      const name = sel.name.value;
      const frag = fragments.get(name);
      // Unknown fragment or a cycle: we cannot enumerate what it selects.
      if (!frag || ancestorSpreads.has(name)) return null;
      const inner = topLevelFieldNames(
        frag.selectionSet,
        fragments,
        new Set(ancestorSpreads).add(name),
        depth + 1,
      );
      if (inner === null) return null;
      names.push(...inner);
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
        // null = the selection set could not be fully enumerated. Block: an
        // incomplete traversal cannot prove no disallowed field is present.
        const blocked = fields === null ? ['<unresolvable selection set>'] : fields.filter((f) => !ALLOWED_MUTATION_FIELDS.has(f));
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
