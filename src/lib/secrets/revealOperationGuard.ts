/**
 * #3998 (plan R8): one `revealSecret` per GraphQL operation. Mutation fields run one after another, so a second field cannot be
 * refused after the first has already spent a use and shown a value: the operation is judged whole, BEFORE any field reads, by
 * counting the `revealSecret` fields it selects (aliased, in an inline fragment or through a named fragment alike). More than one
 * and every one of them is refused, so neither reads. A client that wants two secrets sends two operations, each admitted and
 * rate-limited on its own.
 */
import { GraphQLError, Kind } from 'graphql';
import type { FragmentDefinitionNode, OperationDefinitionNode, SelectionSetNode } from 'graphql';

export const SECRET_REVEAL_ONE_PER_OPERATION = 'SECRET_REVEAL_ONE_PER_OPERATION';

export interface RevealOperationInfo {
  operation: OperationDefinitionNode;
  fragments: Readonly<Record<string, FragmentDefinitionNode>>;
}

/**
 * How many `revealSecret` fields the operation selects, CAPPED at 2 (the guard only asks "more than one?"). Each named fragment is
 * counted once and memoized, and the walk stops the moment the count reaches 2: a valid, acyclic document that reuses fragments in
 * layers (F spreads G twice, G spreads H twice, ...) would otherwise cost 2^depth visits, and this runs BEFORE the rate limit.
 * Spreads still count per spread: two spreads of one fragment holding one reveal are two fields. Validation has already refused a
 * fragment cycle; the `visiting` set is only a backstop so a cycle can never loop here.
 *
 * Recursion depth (#4443 item 3): the walk recurses once per nested selection set or spread. That is safe without an explicit stack
 * because the guard runs inside the resolver, after the request has been parsed, validated and admitted: the byte, token and
 * selection bounds (`GRAPHQL_MAX_QUERY_BYTES` / `_MAX_TOKENS` / `_MAX_SELECTIONS`, always enforced, no off value) cap how deep a
 * document can nest far below the engine's stack (the shallowest nesting, `... {`, costs 3 tokens a level, so under 1400 levels at
 * the default 4000 tokens), and the depth/cost plugin runs earlier still, on `didResolveOperation`. A test pins a nest of 1300.
 *
 * `visitCounter`, when given, counts every selection visited, so a test can assert memoization and early stop deterministically (a visit
 * count, not a wall-clock budget that can flake under CI load).
 */
export function countRevealFields(info: RevealOperationInfo, visitCounter?: { visits: number }): number {
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const walk = (set: SelectionSetNode): number => {
    let n = 0;
    for (const sel of set.selections) {
      if (visitCounter) visitCounter.visits += 1;
      if (sel.kind === Kind.FIELD) { if (sel.name.value === 'revealSecret') n += 1; }
      else if (sel.kind === Kind.INLINE_FRAGMENT) n += walk(sel.selectionSet);
      else n += fragmentCount(sel.name.value);
      if (n >= 2) return 2;
    }
    return n;
  };
  const fragmentCount = (name: string): number => {
    const known = memo.get(name);
    if (known !== undefined) return known;
    const frag = info.fragments[name];
    if (!frag || visiting.has(name)) return 0;
    visiting.add(name);
    const n = walk(frag.selectionSet);
    visiting.delete(name);
    memo.set(name, n);
    return n;
  };
  return walk(info.operation.selectionSet);
}

/** Refuse the whole operation before anything is read when it selects `revealSecret` more than once. */
export function assertOneRevealPerOperation(info: RevealOperationInfo | undefined): void {
  if (info && countRevealFields(info) > 1) {
    throw new GraphQLError('One operation may read one secret: send each revealSecret as its own operation.', { extensions: { code: SECRET_REVEAL_ONE_PER_OPERATION } });
  }
}
