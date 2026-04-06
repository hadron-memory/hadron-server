import { describe, it, expect } from 'vitest';
import { parseUrnInput, formatUrn, validateUrnType } from './urn.js';

describe('parseUrnInput', () => {
  it('parses urn:memory: prefix', () => {
    expect(parseUrnInput('urn:memory:hadronmemory.com:core')).toEqual({
      type: 'memory', value: 'hadronmemory.com:core',
    });
  });

  it('parses urn:node: prefix', () => {
    expect(parseUrnInput('urn:node:micromentor.org:mmdata:services:admin')).toEqual({
      type: 'node', value: 'micromentor.org:mmdata:services:admin',
    });
  });

  it('parses urn:org: prefix', () => {
    expect(parseUrnInput('urn:org:hadronmemory.com')).toEqual({
      type: 'org', value: 'hadronmemory.com',
    });
  });

  it('parses urn:agent: prefix', () => {
    expect(parseUrnInput('urn:agent:hadronmemory.com:engineering')).toEqual({
      type: 'agent', value: 'hadronmemory.com:engineering',
    });
  });

  it('parses urn:station: prefix', () => {
    expect(parseUrnInput('urn:station:hadronmemory.com:dev-ws')).toEqual({
      type: 'station', value: 'hadronmemory.com:dev-ws',
    });
  });

  it('parses loc: prefix', () => {
    expect(parseUrnInput('loc:services:admin')).toEqual({
      type: 'loc', value: 'services:admin',
    });
  });

  it('returns unknown for bare URN (backwards compat)', () => {
    expect(parseUrnInput('hadronmemory.com:core')).toEqual({
      type: 'unknown', value: 'hadronmemory.com:core',
    });
  });

  it('returns unknown for bare loc', () => {
    expect(parseUrnInput('services:admin')).toEqual({
      type: 'unknown', value: 'services:admin',
    });
  });

  it('returns unknown for empty string', () => {
    expect(parseUrnInput('')).toEqual({
      type: 'unknown', value: '',
    });
  });

  it('returns unknown for string without colons', () => {
    expect(parseUrnInput('architecture')).toEqual({
      type: 'unknown', value: 'architecture',
    });
  });
});

describe('formatUrn', () => {
  it('formats a memory URN', () => {
    expect(formatUrn('memory', 'hadronmemory.com:core')).toBe('urn:memory:hadronmemory.com:core');
  });

  it('formats a node URN', () => {
    expect(formatUrn('node', 'micromentor.org:mmdata:services:admin')).toBe('urn:node:micromentor.org:mmdata:services:admin');
  });
});

describe('validateUrnType', () => {
  it('accepts matching type', () => {
    expect(validateUrnType({ type: 'memory', value: 'x' }, 'memory')).toBeNull();
  });

  it('accepts unknown type (backwards compat)', () => {
    expect(validateUrnType({ type: 'unknown', value: 'x' }, 'memory')).toBeNull();
  });

  it('accepts loc where node is expected', () => {
    expect(validateUrnType({ type: 'loc', value: 'x' }, 'node')).toBeNull();
  });

  it('rejects mismatched type', () => {
    const result = validateUrnType({ type: 'agent', value: 'x' }, 'memory');
    expect(result).toContain('Expected memory URN');
    expect(result).toContain('got urn:agent');
  });

  it('rejects loc where memory is expected', () => {
    const result = validateUrnType({ type: 'loc', value: 'x' }, 'memory');
    expect(result).not.toBeNull();
  });
});
