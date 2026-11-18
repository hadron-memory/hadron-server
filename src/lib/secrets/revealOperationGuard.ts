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

export function countRevealFields(info: RevealOperationInfo): number {
  const seen = new Set<string>();
  const walk = (set: SelectionSetNode): number => {
    let n = 0;
    for (const sel of set.selections) {
      if (sel.kind === Kind.FIELD) { if (sel.name.value === 'revealSecret') n += 1; continue; }
      if (sel.kind === Kind.INLINE_FRAGMENT) { n += walk(sel.selectionSet); continue; }
      // A named fragment counts once per spread: two spreads of one fragment are two fields.
      const frag = info.fragments[sel.name.value];
      if (!frag) continue;
      if (seen.has(sel.name.value)) { n += walk(frag.selectionSet); continue; }
      seen.add(sel.name.value);
      n += walk(frag.selectionSet);
    }
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
