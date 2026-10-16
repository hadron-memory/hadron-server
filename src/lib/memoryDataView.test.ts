import { describe, it, expect } from 'vitest';
import {
  MEMORY_WIDE_KEYS_KEY,
  USERS_KEY,
  isMultiHumanChatHost,
  mergeTurnExtraction,
  multiHumanDataView,
} from './memoryDataView.js';

describe('isMultiHumanChatHost (#910)', () => {
  it.each([
    ['app', true],
    ['personal', false],
    ['private', false],
    ['knowledge', false],
    ['group', false],
    ['system', false],
  ])('%s → %s', (cls, expected) => {
    expect(isMultiHumanChatHost({ class: cls })).toBe(expected);
  });
});

describe('mergeTurnExtraction (#910)', () => {
  const declared = new Set(['region']);

  it("files the speaker's values under them and declared memory-wide values flat", () => {
    const next = mergeTurnExtraction(
      { [USERS_KEY]: { bob: { industry: 'B' } }, legacy: 'kept' },
      { industry: 'A', region: 'EU' },
      declared,
      'alice',
    );
    expect(next).toEqual({
      [USERS_KEY]: { bob: { industry: 'B' }, alice: { industry: 'A' } },
      legacy: 'kept',
      region: 'EU',
    });
  });

  it('files a field listed in memoryWideKeys flat, exactly as the read classifies it', () => {
    const next = mergeTurnExtraction(
      { tier: 'OLD', [MEMORY_WIDE_KEYS_KEY]: ['tier'] }, { tier: 'NEW' }, new Set(), 'alice',
    );
    expect(next).toEqual({ tier: 'NEW', [MEMORY_WIDE_KEYS_KEY]: ['tier'] });
    expect(multiHumanDataView(next, new Set(), 'bob')).toEqual({ tier: 'NEW' });
  });

  it('drops personal values when no person is attributable, but keeps memory-wide ones', () => {
    const next = mergeTurnExtraction({}, { industry: 'A', region: 'EU' }, declared, null);
    expect(next).toEqual({ region: 'EU' });
  });

  it('never lets an extracted field overwrite the storage map or the classification list', () => {
    const stored = { [USERS_KEY]: { bob: { industry: 'B' } }, [MEMORY_WIDE_KEYS_KEY]: ['x'] };
    const next = mergeTurnExtraction(
      stored,
      { [USERS_KEY]: 'model-said', [MEMORY_WIDE_KEYS_KEY]: ['industry'] },
      new Set([USERS_KEY, MEMORY_WIDE_KEYS_KEY]),
      'alice',
    );
    expect(next[MEMORY_WIDE_KEYS_KEY]).toEqual(['x']);
    expect((next[USERS_KEY] as Record<string, unknown>).bob).toEqual({ industry: 'B' });
    expect((next[USERS_KEY] as Record<string, unknown>).alice).toEqual({
      [USERS_KEY]: 'model-said',
      [MEMORY_WIDE_KEYS_KEY]: ['industry'],
    });
  });
});

describe('multiHumanDataView (#910)', () => {
  const stored = {
    region: 'EU',
    listed: 'L',
    legacy: 'someone said this',
    [MEMORY_WIDE_KEYS_KEY]: ['listed'],
    [USERS_KEY]: { alice: { industry: 'A', region: 'alice-region' }, bob: { industry: 'B' } },
  };

  it('reads explicitly memory-wide values, then only the reader’s own on top', () => {
    expect(multiHumanDataView(stored, new Set(['region']), 'alice')).toEqual({
      region: 'alice-region', listed: 'L', industry: 'A',
    });
    expect(multiHumanDataView(stored, new Set(['region']), 'bob')).toEqual({
      region: 'EU', listed: 'L', industry: 'B',
    });
  });

  it('reads memory-wide values only when there is no person', () => {
    expect(multiHumanDataView(stored, new Set(['region']), null)).toEqual({ region: 'EU', listed: 'L' });
  });

  it('never exposes the storage map, the list, or an unclassified legacy value', () => {
    const view = multiHumanDataView(stored, new Set(['region', USERS_KEY]), 'carol');
    expect(view).not.toHaveProperty(USERS_KEY);
    expect(view).not.toHaveProperty(MEMORY_WIDE_KEYS_KEY);
    expect(view).not.toHaveProperty('legacy');
  });

  it('tolerates a malformed stored shape', () => {
    expect(multiHumanDataView({ [USERS_KEY]: 'x', [MEMORY_WIDE_KEYS_KEY]: 'y' }, new Set(), 'a')).toEqual({});
    expect(multiHumanDataView(null, new Set(), 'a')).toEqual({});
  });
});
