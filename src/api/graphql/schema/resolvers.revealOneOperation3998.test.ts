/**
 * #3998 plan R8: two `revealSecret` fields in one operation are refused, and neither reads. Pure counting plus the resolver's
 * refusal; the reading itself is pinned in resolvers.revealSecret3998.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { parse, Kind } from 'graphql';
import type { DefinitionNode, FragmentDefinitionNode, OperationDefinitionNode } from 'graphql';
import { resolvers } from './resolvers.js';
import { countRevealFields, SECRET_REVEAL_ONE_PER_OPERATION } from '../../../lib/secrets/revealOperationGuard.js';

function infoOf(doc: string) {
  const defs = parse(doc).definitions as DefinitionNode[];
  const operation = defs.find((d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION)!;
  const fragments: Record<string, FragmentDefinitionNode> = {};
  for (const d of defs) if (d.kind === Kind.FRAGMENT_DEFINITION) fragments[d.name.value] = d;
  return { operation, fragments };
}

describe('#3998 R8: one revealSecret per operation', () => {
  it.each([
    ['one field', 'mutation { revealSecret(clientId: "a") { value } }', 1],
    ['two aliased fields', 'mutation { a: revealSecret(clientId: "a") { value } b: revealSecret(clientId: "b") { value } }', 2],
    ['the same client twice', 'mutation { revealSecret(clientId: "a") { value } x: revealSecret(clientId: "a") { value } }', 2],
    ['one in an inline fragment, one direct', 'mutation { ... on Mutation { revealSecret(clientId: "a") { value } } b: revealSecret(clientId: "b") { value } }', 2],
    ['a named fragment spread twice', 'mutation { ...F x: revealSecret(clientId: "c") { value } } fragment F on Mutation { revealSecret(clientId: "a") { value } }', 2],
    ['other fields are not counted', 'mutation { deleteSecret(id: "a") revealSecret(clientId: "a") { value } }', 1],
  ])('counts %s', (_n, doc, n) => {
    expect(countRevealFields(infoOf(doc))).toBe(n);
  });

  it('refuses every field of a two-field operation before any read, with the documented code', async () => {
    const info = infoOf('mutation { a: revealSecret(clientId: "a") { value } b: revealSecret(clientId: "b") { value } }');
    for (const clientId of ['a', 'b']) {
      // No ctx is touched: the refusal comes before the rate limit and before any database read.
      await expect(resolvers.Mutation.revealSecret({}, { clientId }, {} as never, info as never))
        .rejects.toMatchObject({ extensions: { code: SECRET_REVEAL_ONE_PER_OPERATION } });
    }
  });
});
