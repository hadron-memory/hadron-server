/** #2369: the include-refusal vocabulary admitted by the sync report is tied to one declaration. */
import { describe, expect, it } from 'vitest';
import { GraphQLError } from 'graphql';
import { INCLUDE_REFUSAL_CODES, includeRefusalCode, includeRefusalText } from './writeIncludes.js';

// cor:int:010:01, version 1 report table, `invalid_include` row.
const V1_INVALID_INCLUDE_CODES = ['INVALID_INCLUDE', 'INCLUDE_CYCLE', 'INCLUDE_TARGET_UNAVAILABLE'];

describe('#2369 include refusal codes', () => {
  it('admits exactly the codes of the v1 invalid_include report row', () => {
    expect([...INCLUDE_REFUSAL_CODES]).toEqual(V1_INVALID_INCLUDE_CODES);
  });
  it.each(V1_INVALID_INCLUDE_CODES)('narrows %s and shares the admission with includeRefusalText', code => {
    const e = new GraphQLError('refused', { extensions: { code } });
    expect(includeRefusalCode(e)).toBe(code);
    expect(includeRefusalText(e)).toContain(`[${code.toLowerCase()}]`);
  });
  it('refuses anything outside the admitted set, in both views', () => {
    for (const e of [new GraphQLError('x', { extensions: { code: 'SOMETHING_ELSE' } }), new GraphQLError('x'), new Error('x'), 'INVALID_INCLUDE', null]) {
      expect(includeRefusalCode(e)).toBeNull();
      expect(includeRefusalText(e)).toBeNull();
    }
  });
});
