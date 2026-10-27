import { describe, expect, it } from 'vitest';
import { composeTaskHandle, handleDepth, MAX_HANDLE_DEPTH, parseTaskHandle, qualifiedTaskHandle } from './handle.js';

const deep = (n: number) => `AT1${'.1'.repeat(n - 1)}`;

describe('parseTaskHandle (#2553)', () => {
  it('accepts projects, AT0, and nested paths; canonicalizes case', () => {
    expect(parseTaskHandle('AT0')).toEqual({ handle: 'AT0', appUrn: null });
    expect(parseTaskHandle('at3.405.16')).toEqual({ handle: 'AT3.405.16', appUrn: null });
  });

  it('refuses leading zeros, zero below the project, bare numbers, spaces and non-strings', () => {
    for (const bad of ['AT00', 'AT01', 'AT1.0', 'AT1.05', 'AT', 'AT.1', 'AT1.', 'AT1..2', '388', 'AT1 ', ' AT1', 'AT-1', '']) {
      expect(parseTaskHandle(bad), bad).toBeNull();
    }
    for (const bad of [null, undefined, 3, {}]) expect(parseTaskHandle(bad)).toBeNull();
  });

  it('bounds the depth at 16 segments: 16 parses, 17 is malformed', () => {
    expect(handleDepth(deep(MAX_HANDLE_DEPTH))).toBe(16);
    expect(parseTaskHandle(deep(MAX_HANDLE_DEPTH))?.handle).toBe(deep(16));
    expect(parseTaskHandle(deep(MAX_HANDLE_DEPTH + 1))).toBeNull();
  });

  it('bounds each segment to a bigint the column holds', () => {
    expect(parseTaskHandle('AT9223372036854775807')).not.toBeNull();
    expect(parseTaskHandle('AT9223372036854775808')).toBeNull();
    expect(parseTaskHandle('AT1.99999999999999999999')).toBeNull();
  });

  it('parses the qualified form and round-trips qualifiedTaskHandle', () => {
    const q = qualifiedTaskHandle('hadronmemory.com:hadron-dev-team', 'AT0.388');
    expect(parseTaskHandle(q)).toEqual({ handle: 'AT0.388', appUrn: 'hadronmemory.com:hadron-dev-team' });
    expect(parseTaskHandle('hrn:agenttask:onlyone:AT1')).toBeNull();
    expect(parseTaskHandle('hrn:agenttask:a:b:AT1.0')).toBeNull();
  });

  it('composes a child handle from its parent', () => {
    expect(composeTaskHandle(null, 3)).toBe('AT3');
    expect(composeTaskHandle('AT3', 405n)).toBe('AT3.405');
  });
});
