/** #4039 (cor:cht:020:02 step 1, Q14/Q14a): the author's order, as a pure function. */
import { describe, expect, it } from 'vitest';
import { byAuthorOrder, hasEntryCondition, pickEntryConversation, pickUnnamedStartConversation } from './chatConversationOrder.js';

const n = (loc: string, seq: number | null = null, data: Record<string, unknown> = {}) => ({ loc: `conversations:${loc}`, seq, data });

describe('byAuthorOrder', () => {
  it('seq ascending, nulls last, ties by code-unit loc', () => {
    const out = byAuthorOrder([n('zz'), n('b', 2), n('a', 2), n('c', 1), n('B'), n('a0', 0)]).map((x) => x.loc.split(':')[1]);
    expect(out).toEqual(['a0', 'c', 'a', 'b', 'B', 'zz']);
  });
  it('no seq anywhere is exactly loc order (ruling 0127)', () => {
    expect(byAuthorOrder([n('b'), n('B'), n('a')]).map((x) => x.loc)).toEqual(['conversations:B', 'conversations:a', 'conversations:b']);
  });
});

describe('pickEntryConversation', () => {
  it('walks ordinary conversations in order; the first whose condition holds wins; no condition holds without a call', async () => {
    const calls: string[] = [];
    const nodes = [n('b', 2), n('a', 1, { entryCondition: { x: 1 } }), n('c', 3, { entryCondition: { y: 1 } })];
    const pick = await pickEntryConversation(nodes, async (c) => { calls.push(c.loc); return false; });
    expect(pick?.loc).toBe('conversations:b');
    expect(calls).toEqual(['conversations:a']);
  });
  it('none holds: setup, then fallback, then null; setup and fallback are never in the scan', async () => {
    const never = async () => false;
    const gated = { entryCondition: { x: 1 } };
    expect((await pickEntryConversation([n('a', 1, gated), n('fb', 0, { isFallback: true }), n('su', 5, { isSetup: true })], never))?.loc).toBe('conversations:su');
    expect((await pickEntryConversation([n('a', 1, gated), n('fb', 0, { isFallback: true, entryCondition: { x: 1 } })], never))?.loc).toBe('conversations:fb');
    expect(await pickEntryConversation([n('a', 1, gated)], never)).toBeNull();
  });
  it('a throwing condition propagates: the scan never skips it (Q16)', async () => {
    await expect(pickEntryConversation([n('a', 1, { entryCondition: { x: 1 } }), n('b', 2)], async () => { throw new Error('boom'); })).rejects.toThrow('boom');
  });
});

describe('the unconditioned pick', () => {
  it('is seq-aware and ignores conditions', () => {
    expect(pickUnnamedStartConversation([n('a'), n('z', 1)])?.loc).toBe('conversations:z');
    expect(hasEntryCondition(n('a', null, { entryCondition: null }))).toBe(false);
    expect(hasEntryCondition(n('a', null, { entryCondition: { x: 1 } }))).toBe(true);
  });
});
