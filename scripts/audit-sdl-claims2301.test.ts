import { expect, it } from 'vitest';
import { scanClaims } from './audit-sdl-claims2301.mjs';

it('collects actual descriptions with coordinates and source lines, excluding issue/citation-only numbers', () => {
  const source = 'export const typeDefs = `type Query {\n  "Only its owner." owner: String\n  "limit 50 (cap 200)." page: String\n  "Currently available." status: String\n  "#2301 hrn:node:org:specs:cor:agt:050:21" citation: String\n  plain: String\n}`;';
  expect(scanClaims(source).map(({ line, coord }) => ({ line, coord }))).toEqual([
    { line: 2, coord: 'Query.owner' },
    { line: 3, coord: 'Query.page' },
    { line: 4, coord: 'Query.status' },
  ]);
});
it('rejects an interpolated template rather than auditing an incomplete SDL', () => {
  expect(() => scanClaims('export const typeDefs = `type Query { ${fields} }`;')).toThrow('static typeDefs');
});

it('keeps field argument coordinates distinct from input object fields', () => {
  const source = 'export const typeDefs = `type Query { thing("Only this one." ref: String): String } input Selection { "Only this one." ref: String }`;';
  expect(scanClaims(source).map(row => row.coord)).toEqual(['Query.thing(ref:)', 'Selection.ref']);
});
