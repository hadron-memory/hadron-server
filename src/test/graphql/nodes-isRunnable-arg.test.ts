/**
 * Schema-surface regression for issue #372 — the `isRunnable` filter on node
 * search.
 *
 * Originally this guarded `Query.nodes(isRunnable:)`. PR3 removed the `nodes`
 * query; the runnable filter now lives on `findNodes` as `NodeFilter.isRunnable`
 * (cor:api:060 / cor:api:090:02). This still guards the SCHEMA surface itself —
 * build the schema from the SDL and `parse + validate`, the layer that produced
 * the original live `Unknown argument` failure — so dropping the field from
 * `NodeFilter` in typeDefs trips a test even though the resolver still compiles.
 * (Resolver behavior is covered by resolvers.findNodes.test.ts.)
 */

import { describe, it, expect } from 'vitest';
import { buildSchema, parse, validate } from 'graphql';
import { typeDefs } from '../../api/graphql/schema/typeDefs.js';

const schema = buildSchema(typeDefs);

function validationErrorMessages(query: string): string[] {
  return validate(schema, parse(query)).map((e) => e.message);
}

describe('issue #372 (PR3) — findNodes NodeFilter declares the isRunnable field', () => {
  it('accepts findNodes(filter: { isRunnable: true }) without a validation error', () => {
    expect(
      validationErrorMessages(`query { findNodes(filter: { isRunnable: true }) { total } }`),
    ).toEqual([]);
  });

  it('accepts findNodes(filter: { isRunnable: false })', () => {
    expect(
      validationErrorMessages(`query { findNodes(filter: { isRunnable: false }) { total } }`),
    ).toEqual([]);
  });

  it('composes isRunnable with the other filter + query args', () => {
    expect(
      validationErrorMessages(
        `query { findNodes(query: "x", filter: { memoryIds: ["m1"], isRunnable: true }, limit: 50) { hits { node { loc name } } } }`,
      ),
    ).toEqual([]);
  });

  it('is typed Boolean — a non-Boolean literal is rejected', () => {
    // Confirms the field is genuinely declared (and typed), not silently ignored.
    const errors = validationErrorMessages(
      `query { findNodes(filter: { isRunnable: "yes" }) { total } }`,
    );
    expect(errors.some((m) => m.includes('Boolean cannot represent'))).toBe(true);
  });
});
