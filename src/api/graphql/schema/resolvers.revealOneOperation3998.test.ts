/**
 * #3998 plan R8: two `revealSecret` fields in one operation are refused, and neither reads. Pure counting plus the resolver's
 * refusal; the reading itself is pinned in resolvers.revealSecret3998.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { parse, Kind } from 'graphql';
import type { DefinitionNode, FragmentDefinitionNode, OperationDefinitionNode } from 'graphql';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';
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
    ['a named fragment spread once beside a direct field', 'mutation { ...F x: revealSecret(clientId: "c") { value } } fragment F on Mutation { revealSecret(clientId: "a") { value } }', 2],
    ['one named fragment spread twice', 'mutation { ...F ...F } fragment F on Mutation { revealSecret(clientId: "a") { value } }', 2],
    ['one named fragment spread once', 'mutation { ...F } fragment F on Mutation { revealSecret(clientId: "a") { value } }', 1],
    ['an unknown spread counts nothing', 'mutation { ...Gone revealSecret(clientId: "a") { value } }', 1],
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

  // Dara (BLIND delta, P1): fragments reused in layers are an acyclic, valid document whose naive walk costs 2^depth, and the walk
  // runs BEFORE the rate limit. Memoized and capped, it is linear in the document.
  it('walks a layered shared-fragment document in linear time (no reveal at the bottom: the memo is what saves it)', () => {
    const depth = 40;
    const frags = Array.from({ length: depth }, (_, i) => `fragment F${i} on Mutation { ...F${i + 1} ...F${i + 1} }`).join(' ');
    const doc = `mutation { ...F0 } ${frags} fragment F${depth} on Mutation { deleteSecret(id: "a") }`;
    const t = Date.now();
    expect(countRevealFields(infoOf(doc))).toBe(0);
    expect(Date.now() - t).toBeLessThan(500);
  });

  it('stops at two: a deep layered document whose bottom holds a reveal is two, not 2^depth', () => {
    const depth = 40;
    const frags = Array.from({ length: depth }, (_, i) => `fragment F${i} on Mutation { ...F${i + 1} ...F${i + 1} }`).join(' ');
    const doc = `mutation { ...F0 } ${frags} fragment F${depth} on Mutation { revealSecret(clientId: "a") { value } }`;
    const t = Date.now();
    expect(countRevealFields(infoOf(doc))).toBe(2);
    expect(Date.now() - t).toBeLessThan(500);
  });
});

// Through GraphQL execution, so the production wiring that forwards `info` to the guard is what is under test (the direct resolver
// test above hands `info` in by hand). The context's db throws on any touch: the refusal must come before the rate limit and any read.
describe('#3998 R8 through GraphQL execution', () => {
  const server = new ApolloServer<Context>({ typeDefs, resolvers });
  beforeAll(() => server.start());
  afterAll(() => server.stop());
  const untouchable = new Proxy({}, { get: () => { throw new Error('the database was touched'); } });
  const run = async (query: string) => {
    const r = await server.executeOperation({ query }, { contextValue: { db: untouchable, userId: 'u', roles: [] } as unknown as Context });
    if (r.body.kind !== 'single') throw new Error('single result expected');
    return r.body.singleResult;
  };

  it('two aliased reveals are refused with the documented code, and nothing touches the database', async () => {
    const r = await run('mutation { a: revealSecret(clientId: "a") { value } b: revealSecret(clientId: "b") { value } }');
    const codes = (r.errors ?? []).map((e) => e.extensions?.code);
    // A non-null mutation field that errors ends the serial execution, so the second field never runs: one refusal is the whole answer.
    expect(codes).toEqual([SECRET_REVEAL_ONE_PER_OPERATION]);
    expect(JSON.stringify(r.errors)).not.toContain('the database was touched');
  });
});
