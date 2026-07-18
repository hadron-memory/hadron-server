/**
 * Schema-surface regression for #719 — the `where` predicate input on findNodes.
 *
 * Builds the schema from the SDL and `parse + validate` (the layer that catches
 * a missing/mis-typed input field), so dropping `NodeFilter.where` or the
 * `NodeWhereInput` shape trips a test even if the resolver still compiles.
 * (Resolver behavior is covered by resolvers.findNodesWhere.test.ts.)
 */
import { describe, it, expect } from 'vitest';
import { buildSchema, parse, validate } from 'graphql';
import { typeDefs } from '../../api/graphql/schema/typeDefs.js';

const schema = buildSchema(typeDefs);
const errs = (query: string): string[] => validate(schema, parse(query)).map((e) => e.message);

describe('#719 — findNodes NodeFilter.where predicate surface', () => {
  it('accepts a leaf predicate', () => {
    expect(errs(`query { findNodes(filter: { where: { path: ["sourceKind"], eq: "substack" } }) { total } }`)).toEqual([]);
  });

  it('accepts nested and/or/not with field + as enums and a datetime bound', () => {
    expect(
      errs(
        `query { findNodes(filter: { where: {
           and: [
             { field: properties, path: ["extractedAt"], as: datetime, gte: "2026-07-01" },
             { not: { path: ["status"], eq: "closed" } }
           ]
         } }) { hits { node { loc } } } }`,
      ),
    ).toEqual([]);
  });

  it('accepts the data column selector', () => {
    expect(errs(`query { findNodes(filter: { where: { field: data, path: ["tools"], contains: "web_search" } }) { total } }`)).toEqual([]);
  });

  it('rejects an unknown field-column enum value', () => {
    const e = errs(`query { findNodes(filter: { where: { field: content, path: ["x"], eq: "y" } }) { total } }`);
    expect(e.length).toBeGreaterThan(0);
    expect(e.some((m) => /NodeWhereColumn|content/.test(m))).toBe(true);
  });

  it('rejects an unknown cast enum value', () => {
    const e = errs(`query { findNodes(filter: { where: { path: ["x"], as: json, eq: "y" } }) { total } }`);
    expect(e.length).toBeGreaterThan(0);
    expect(e.some((m) => /NodeWhereCast|json/.test(m))).toBe(true);
  });
});
