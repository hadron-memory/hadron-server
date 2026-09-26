/** #1322 — the dotted role-family query contract exposed to CLI consumers. */
import { describe, expect, it } from 'vitest';
import { buildSchema, parse, validate } from 'graphql';
import { typeDefs } from '../../api/graphql/schema/typeDefs.js';

const schema = buildSchema(typeDefs);
const errors = (query: string): string[] =>
  validate(schema, parse(query)).map((error) => error.message);

describe('#1322 — NodeFilter.role schema surface', () => {
  it('accepts a dotted role-family filter on findNodes and appNodes', () => {
    expect(errors(`query { findNodes(filter: { role: "spec.rule" }) { total } }`)).toEqual([]);
    expect(
      errors(`query { appNodes(appRef: "app", filter: { role: "spec.rule" }) { loc role } }`),
    ).toEqual([]);
  });

  it('types role as a String', () => {
    expect(
      errors(`query { findNodes(filter: { role: 5 }) { total } }`).some((message) =>
        message.includes('String cannot represent'),
      ),
    ).toBe(true);
  });
});
