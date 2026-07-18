/**
 * Schema-surface regression for #725 PR B — Memory.schema read field + the
 * updateMemory(schema:) write arg.
 */
import { describe, it, expect } from 'vitest';
import { buildSchema, parse, validate } from 'graphql';
import { typeDefs } from '../../api/graphql/schema/typeDefs.js';

const schema = buildSchema(typeDefs);
const errs = (query: string): string[] => validate(schema, parse(query)).map((e) => e.message);

describe('#725 PR B — Memory.schema surface', () => {
  it('updateMemory accepts a schema arg and Memory.schema is selectable', () => {
    expect(errs(`mutation($s: JSON) { updateMemory(id: "x", schema: $s) { id schema } }`)).toEqual([]);
  });

  it('Memory.schema is a JSON field on the Memory type', () => {
    expect(errs(`mutation { updateMemory(id: "x") { schema } }`)).toEqual([]);
  });
});
