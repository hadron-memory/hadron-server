import { describe, it, expect } from 'vitest';
import { projectGovernedKind, governedKindAnnotation, UNSUPPORTED_EDGE_GOVERNED_KIND } from './edgeGovernedKind.js';

describe('projectGovernedKind (#2124)', () => {
  it('maps SQL NULL to null and each known kind to itself', () => {
    expect(projectGovernedKind(null)).toBeNull();
    for (const k of ['INCLUDE', 'COMMENT_ANCHOR', 'COMMENT_REPLY']) expect(projectGovernedKind(k)).toBe(k);
  });
  it('never reads an unknown or unselected value as ordinary', () => {
    for (const bad of ['SOMETHING_NEW', 'include', '', undefined, 0, {}]) {
      expect(() => projectGovernedKind(bad)).toThrow(UNSUPPORTED_EDGE_GOVERNED_KIND);
    }
  });
  it('annotates null explicitly', () => {
    expect(governedKindAnnotation(null)).toBe(' (governedKind: null)');
    expect(governedKindAnnotation('INCLUDE')).toBe(' (governedKind: INCLUDE)');
  });
});
