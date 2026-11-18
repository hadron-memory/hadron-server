/**
 * #1302 — complexity admission prices `SpecDocument.entries` at the cap the resolver enforces
 * (`SPEC_DOCUMENT_MAX_NODES`), not at `GRAPHQL_LIST_FACTOR`. The list has no page argument, so by default
 * it would be costed as 10 entries while a document may hold 300. Mutant: delete the FIXED_LIST_SIZE entry
 * and the first test fails.
 */
import { describe, expect, it } from 'vitest';
import { buildSchema, parse } from 'graphql';
import { getComplexity, simpleEstimator } from 'graphql-query-complexity';
import { typeDefs } from './schema/typeDefs.js';
import { hadronListEstimator, FIXED_LIST_SIZE } from './admissionComplexity.js';
import { SPEC_DOCUMENT_MAX_NODES, SPEC_DOCUMENT_CALL_COST } from '../../lib/specDocument/limits.js';

const schema = buildSchema(typeDefs);
const cost = (selection: string, listFactor = 10) => getComplexity({
  schema, query: parse(`{ specDocument(memoryRef: "m", loc: "l") { ${selection} } }`), variables: {},
  estimators: [hadronListEstimator({ maxCost: 10_000_000, listFactor }), simpleEstimator({ defaultComplexity: 1 })],
});

describe('specDocument admission', () => {
  it('prices entries at the cap, whatever GRAPHQL_LIST_FACTOR is', () => {
    // the call's own price + entries (1 + cap x one leaf)
    const expected = SPEC_DOCUMENT_CALL_COST + 1 + SPEC_DOCUMENT_MAX_NODES;
    expect(cost('entries { loc }')).toBe(expected);
    expect(cost('entries { loc }', 1)).toBe(expected);
    expect(cost('entries { loc }', 1000)).toBe(expected);
  });

  it('the call is priced whatever is selected, so { markdown } and aliases are not cheap', () => {
    expect(cost('markdown')).toBe(SPEC_DOCUMENT_CALL_COST + 1);
    const aliased = (n: number) => getComplexity({
      schema, variables: {},
      query: parse(`{ ${Array.from({ length: n }, (_, i) => `a${i}: specDocument(memoryRef: "m", loc: "l") { markdown }`).join(' ')} }`),
      estimators: [hadronListEstimator({ maxCost: 200_000, listFactor: 10 }), simpleEstimator({ defaultComplexity: 1 })],
    });
    expect(aliased(245)).toBeGreaterThan(200_000);
    expect(aliased(9)).toBeLessThanOrEqual(200_000);
  });

  it('the cap is pinned as a literal and registered', () => {
    expect(SPEC_DOCUMENT_MAX_NODES).toBe(300);
    expect(FIXED_LIST_SIZE['SpecDocument.entries']).toBe(SPEC_DOCUMENT_MAX_NODES);
  });
});
