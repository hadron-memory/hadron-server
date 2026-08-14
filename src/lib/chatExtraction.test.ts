import { describe, it, expect } from 'vitest';
import {
  DEFAULT_EXTRACTION_DESTINATION,
  EXTRACTED_SUBKEY,
  USERS_SUBKEY,
  buildExtractionView,
  mergeExtractedInto,
  mergeUserScopedInto,
  parseExtractionField,
  routeExtractedData,
} from './chatExtraction.js';

describe('parseExtractionField', () => {
  it.each([
    ['memory.industry', 'memory', 'industry'],
    ['chat.topic', 'chat', 'topic'],
    ['user.industry', 'user', 'industry'],
    ['stage.answer', 'stage', 'answer'],
  ])('%s → %s / %s', (field, destination, name) => {
    expect(parseExtractionField(field)).toEqual({ destination, name });
  });

  it('defaults an unprefixed field to the conversation', () => {
    // Defaulting to `memory` would keep the #910 bleed for every chatbot that
    // never adopts the syntax.
    expect(parseExtractionField('industry')).toEqual({
      destination: DEFAULT_EXTRACTION_DESTINATION,
      name: 'industry',
    });
    expect(DEFAULT_EXTRACTION_DESTINATION).toBe('chat');
  });

  it('treats an unknown prefix as inert, not as an error', () => {
    // These strings cross a JSON boundary from authored node data, so a typo
    // must degrade rather than throw.
    expect(parseExtractionField('foo.industry')).toEqual({
      destination: DEFAULT_EXTRACTION_DESTINATION,
      name: 'industry',
    });
  });

  it('takes the LAST segment as the name, matching the tool schema', () => {
    // buildRespondToolSchema uses field.split('.').pop() for the property the
    // model answers with. If these two disagreed, a routed value would be
    // looked up under a key the model never returned.
    expect(parseExtractionField('memory.a.b').name).toBe('b');
  });
});

describe('routeExtractedData', () => {
  it('partitions values by their declared destination', () => {
    const buckets = routeExtractedData(
      { industry: 'construction', topic: 'pricing', size: 12 },
      [{ field: 'user.industry' }, { field: 'chat.topic' }, { field: 'memory.size' }],
    );
    expect(buckets.user).toEqual({ industry: 'construction' });
    expect(buckets.chat).toEqual({ topic: 'pricing' });
    expect(buckets.memory).toEqual({ size: 12 });
    expect(buckets.stage).toEqual({});
  });

  it('files an undeclared value under the default rather than dropping it', () => {
    // The model is not a trusted source of field names, but silently
    // discarding data an author may rely on is worse than filing it
    // conservatively.
    const buckets = routeExtractedData({ surprise: 'x' }, [{ field: 'memory.known' }]);
    expect(buckets[DEFAULT_EXTRACTION_DESTINATION]).toEqual({ surprise: 'x' });
  });

  it('always returns every bucket, so callers need no guards', () => {
    expect(Object.keys(routeExtractedData({}, [])).sort()).toEqual([
      'chat', 'memory', 'stage', 'user',
    ]);
  });
});

describe('mergeExtractedInto', () => {
  it('nests under a sub-key and preserves the node’s own control fields', () => {
    // The chat root's data holds scope/stageName/messageCount, and extraction
    // keys come from the MODEL — a top-level merge of an extracted `scope`
    // would corrupt the chat's scope invariant.
    const merged = mergeExtractedInto(
      { scope: 'shared', stageName: 'intro', [EXTRACTED_SUBKEY]: { a: 1 } },
      { scope: 'MALICIOUS', b: 2 },
    );
    expect(merged.scope).toBe('shared');
    expect(merged[EXTRACTED_SUBKEY]).toEqual({ a: 1, scope: 'MALICIOUS', b: 2 });
  });
});

describe('mergeUserScopedInto', () => {
  it('files values under the speaker alone, leaving other members untouched', () => {
    const before = { [USERS_SUBKEY]: { alice: { industry: 'construction' } } };
    const after = mergeUserScopedInto(before, 'bob', { industry: 'hospitality' });
    expect((after[USERS_SUBKEY] as Record<string, unknown>).alice).toEqual({
      industry: 'construction',
    });
    expect((after[USERS_SUBKEY] as Record<string, unknown>).bob).toEqual({
      industry: 'hospitality',
    });
  });

  it('drops values when the turn has no attributed speaker', () => {
    // A bucket keyed `unknown` would be read back as somebody's facts by the
    // view builder — the exact failure this rule exists to prevent.
    const after = mergeUserScopedInto({ existing: true }, null, { industry: 'x' });
    expect(after).toEqual({ existing: true });
    expect(after[USERS_SUBKEY]).toBeUndefined();
  });
});

describe('buildExtractionView', () => {
  const memoryData = {
    companyName: 'Acme',
    [USERS_SUBKEY]: {
      alice: { industry: 'construction' },
      bob: { industry: 'hospitality' },
    },
  };

  it('layers most-specific-last: memory → stage → chat → speaker', () => {
    const view = buildExtractionView({
      memoryData: { ...memoryData, tier: 'memory' },
      stageData: { [EXTRACTED_SUBKEY]: { tier: 'stage', fromStage: true } },
      chatData: { [EXTRACTED_SUBKEY]: { tier: 'chat' } },
      userId: 'bob',
    });
    expect(view.companyName).toBe('Acme'); // memory-wide still visible
    expect(view.fromStage).toBe(true);
    expect(view.tier).toBe('chat'); // chat beats stage beats memory
    expect(view.industry).toBe('hospitality'); // bob's own, not alice's
  });

  it("never exposes another participant's values, even indirectly", () => {
    // The regression #910 is about. Bob's turn must not be able to read
    // Alice's answer — including through the storage shape.
    const view = buildExtractionView({ memoryData, userId: 'bob' });
    expect(view.industry).toBe('hospitality');
    expect(view[USERS_SUBKEY]).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain('construction');
  });

  it('yields no per-user values when the speaker is unknown', () => {
    const view = buildExtractionView({ memoryData, userId: null });
    expect(view.industry).toBeUndefined();
    expect(view.companyName).toBe('Acme');
  });
});
