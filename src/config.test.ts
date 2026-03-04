import { describe, it, expect } from 'vitest';
import { graphNameToNamespace } from './config.js';

describe('graphNameToNamespace', () => {
  it('converts slash to dot', () => {
    expect(graphNameToNamespace('foo/bar')).toBe('foo.bar');
  });
  it('converts multiple slashes', () => {
    expect(graphNameToNamespace('a/b/c')).toBe('a.b.c');
  });
  it('passthrough for names without slash', () => {
    expect(graphNameToNamespace('simple')).toBe('simple');
  });
  it('handles empty string', () => {
    expect(graphNameToNamespace('')).toBe('');
  });
});

