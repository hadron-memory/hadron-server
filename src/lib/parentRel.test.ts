import { describe, it, expect } from 'vitest';
import { validateParentRel, InvalidParentRelError } from './parentRel.js';

describe('validateParentRel', () => {
  it('accepts undefined (root-level)', () => {
    expect(() => validateParentRel(undefined)).not.toThrow();
  });

  it('accepts a bare rel-path', () => {
    expect(() => validateParentRel('review')).not.toThrow();
    expect(() => validateParentRel('review:render-urn')).not.toThrow();
  });

  it('accepts a canonical urn:memory: prefix', () => {
    expect(() => validateParentRel('urn:memory:hadronmemory.com:dev')).not.toThrow();
    expect(() => validateParentRel('urn:memory:hadronmemory.com:dev:review')).not.toThrow();
  });

  it('accepts a canonical urn:node: prefix', () => {
    expect(() => validateParentRel('urn:node:hadronmemory.com:dev:review')).not.toThrow();
  });

  it('accepts the legacy loc: prefix', () => {
    expect(() => validateParentRel('loc:review')).not.toThrow();
  });

  it('rejects empty string', () => {
    expect(() => validateParentRel('')).toThrow(InvalidParentRelError);
    expect(() => validateParentRel('')).toThrow(/omitted for root-level/);
  });

  it('rejects whitespace-only', () => {
    expect(() => validateParentRel('   ')).toThrow(InvalidParentRelError);
  });

  it('rejects literal-quotes (the original-orphan-node bug shape)', () => {
    expect(() => validateParentRel('""')).toThrow(InvalidParentRelError);
    expect(() => validateParentRel("''")).toThrow(InvalidParentRelError);
  });

  it('rejects wrong-type URN prefixes (silent-coercion guard)', () => {
    expect(() => validateParentRel('urn:agent:foo:bar')).toThrow(/urn:agent:/);
    expect(() => validateParentRel('urn:org:foo')).toThrow(/urn:org:/);
    expect(() => validateParentRel('urn:app:foo:bar')).toThrow(/urn:app:/);
  });

  it('rejects unknown urn:<type>: prefixes', () => {
    expect(() => validateParentRel('urn:bogus:foo')).toThrow(/not a known URN type/);
  });
});
