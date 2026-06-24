/**
 * Schema-surface regression for issue #372 — the `isRunnable` filter on
 * `Query.nodes`.
 *
 * The resolver applied `isRunnable` (added in #359, cor:api:060), but a
 * matching test executed the resolver DIRECTLY, which bypasses GraphQL
 * validation. So a missing arg declaration in the SDL went uncaught: every
 * real client request `nodes(isRunnable: ...)` failed with
 * `Unknown argument "isRunnable" on field "Query.nodes"`
 * (GRAPHQL_VALIDATION_FAILED) before reaching the resolver.
 *
 * This guards the SCHEMA surface itself: build the schema from the SDL and
 * `parse + validate` — exactly the layer that produced the live failure. Keep
 * it here (resolver behavior is covered by resolvers.nodesMemoryFilter.test.ts)
 * so removing the arg from typeDefs trips a test even though the resolver still
 * compiles.
 */

import { describe, it, expect } from 'vitest';
import { buildSchema, parse, validate } from 'graphql';
import { typeDefs } from '../../api/graphql/schema/typeDefs.js';

const schema = buildSchema(typeDefs);

function validationErrorMessages(query: string): string[] {
  return validate(schema, parse(query)).map((e) => e.message);
}

describe('issue #372 — Query.nodes declares the isRunnable filter arg', () => {
  it('accepts nodes(isRunnable: true) without a validation error', () => {
    expect(validationErrorMessages(`query { nodes(isRunnable: true) { loc } }`)).toEqual([]);
  });

  it('accepts nodes(isRunnable: false)', () => {
    expect(validationErrorMessages(`query { nodes(isRunnable: false) { loc } }`)).toEqual([]);
  });

  it('composes isRunnable with the existing memory-scope args', () => {
    expect(
      validationErrorMessages(
        `query { nodes(memoryIds: ["m1"], isRunnable: true, limit: 50) { loc name } }`,
      ),
    ).toEqual([]);
  });

  it('is typed Boolean — a non-Boolean literal is rejected', () => {
    // Confirms the arg is genuinely declared (and typed), not silently ignored.
    const errors = validationErrorMessages(`query { nodes(isRunnable: "yes") { loc } }`);
    expect(errors.some((m) => m.includes('Boolean cannot represent'))).toBe(true);
  });
});
