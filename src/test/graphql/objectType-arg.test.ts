/**
 * Schema-surface regression for #725 — Node.objectType across the node surfaces:
 * the NodeFilter facet, the readable Node field, and the write inputs.
 */
import { describe, it, expect } from 'vitest';
import { buildSchema, parse, validate } from 'graphql';
import { typeDefs } from '../../api/graphql/schema/typeDefs.js';

const schema = buildSchema(typeDefs);
const errs = (query: string): string[] => validate(schema, parse(query)).map((e) => e.message);

describe('#725 — objectType on the node surfaces', () => {
  it('findNodes NodeFilter.objectType is a valid filter', () => {
    expect(errs(`query { findNodes(filter: { objectType: "competitor" }) { total } }`)).toEqual([]);
  });

  it('Node.objectType is selectable', () => {
    expect(errs(`query { findNodes(query: "x") { hits { node { objectType } } } }`)).toEqual([]);
  });

  it('createNode / updateNode inputs accept objectType', () => {
    expect(
      errs(`mutation { createNode(input: { memoryId: "m", loc: "l", name: "n", objectType: "competitor" }) { objectType } }`),
    ).toEqual([]);
    expect(errs(`mutation { updateNode(input: { id: "x", objectType: null }) { objectType } }`)).toEqual([]);
  });

  it('objectType is typed String — a non-string literal is rejected', () => {
    expect(errs(`query { findNodes(filter: { objectType: 5 }) { total } }`).some((m) => /String cannot represent/.test(m))).toBe(true);
  });
});
