/** #2017 slice (a): pure shared rendering, exact rendered ranges and bounded overflow. */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
const path = './renderBatch.js';
const render = async (input: Record<string, unknown>) => (await import(/* @vite-ignore */ path)).renderBatch(input);
const msg = (seq: number, extra: Record<string, unknown> = {}) => ({
  channelId: 'channel-a', seq, createdAt: new Date(1_700_000_000_000 + seq * 1000),
  authorName: 'Ada', body: `body-${seq}`, parentSeq: null, parent: null, mentions: [], ...extra,
});
const input = (messages: ReturnType<typeof msg>[], extra = {}) => ({ workerName: 'Liam', messages, ...extra });

describe('renderBatch — S1 shared pure renderer', () => {
  it('renders an empty delivery without a fake header or range', async () => {
    expect(await render(input([]))).toEqual({ text: '', ranges: [], renderedCount: 0, overflow: 0, renderHash: createHash('sha256').update('').digest('hex') });
  });
  it('uses the delivery header, seq and author, full body and fixed reply hint', async () => {
    const out = await render(input([msg(1)]));
    expect(out.text).toMatch(/^\[hadron chat\] 1 for Liam/);
    expect(out.text).toContain('#1 Ada: body-1');
    expect(out.text).toContain('reply: hadron team chat post --reply-to <seq>');
    expect(out.overflow).toBe(0);
    expect(out.text).not.toContain('next batch');
  });
  it('sorts by timestamp then channel then seq regardless of input order, without mutating input', async () => {
    const same = new Date('2026-10-19T00:00:00Z');
    const messages = [msg(8, { channelId: 'z', createdAt: same }), msg(3, { channelId: 'a', createdAt: same }), msg(2, { channelId: 'a', createdAt: same })];
    const before = structuredClone(messages);
    const out = await render(input(messages));
    expect(out).toEqual(await render(input([...messages].reverse())));
    expect(messages).toEqual(before);
    expect(out.text.indexOf('#2 Ada')).toBeLessThan(out.text.indexOf('#3 Ada'));
    expect(out.text.indexOf('#3 Ada')).toBeLessThan(out.text.indexOf('#8 Ada'));
  });
  it('renders 10 messages and leaves the 11th due with overflow before the last reply hint', async () => {
    const out = await render(input(Array.from({ length: 11 }, (_, i) => msg(i + 1))));
    expect(out.renderedCount).toBe(10);
    expect(out.overflow).toBe(1);
    expect(out.text).toContain('+1 more waiting · read: hadron team chat inbox');
    expect(out.text).toMatch(/reply: hadron team chat post --reply-to <seq> "@name …"$/);
    expect(out.text).not.toContain('body-11');
    expect(out.ranges).toEqual([{ channelId: 'channel-a', fromSeq: 1, throughSeq: 10, seqs: [1,2,3,4,5,6,7,8,9,10] }]);
  });
  it('does not add an overflow marker at the exact message cap', async () => {
    const out = await render(input(Array.from({ length: 10 }, (_, i) => msg(i + 1))));
    expect(out.renderedCount).toBe(10); expect(out.overflow).toBe(0);
  });
  it('counts message body text only at 6000/6001, excluding header, hint and overflow', async () => {
    const exact = await render(input([msg(1, { body: 'x'.repeat(3000) }), msg(2, { body: 'y'.repeat(3000) })]));
    expect(exact.renderedCount).toBe(2); expect(exact.text.length).toBeGreaterThan(6000);
    const over = await render(input([msg(1, { body: 'x'.repeat(3000) }), msg(2, { body: 'y'.repeat(3001) })]));
    expect(over.renderedCount).toBe(1); expect(over.overflow).toBe(1);
    expect(over.ranges[0].seqs).toEqual([1]);
  });
  it('renders an oversized first message whole and alone, preserving the remainder', async () => {
    const body = 'long '.repeat(1500);
    const out = await render(input([msg(1, { body }), msg(2)]));
    expect(out.text).toContain(body); expect(out.renderedCount).toBe(1); expect(out.overflow).toBe(1);
    expect(out.ranges[0].seqs).toEqual([1]); expect(out.text).not.toContain('body-2');
  });
  it('stops before a later oversized message instead of truncating or skipping it', async () => {
    const messages = [msg(1), msg(2, { body: 'x'.repeat(7000) }), msg(3)];
    const first = await render(input(messages));
    expect(first.renderedCount).toBe(1); expect(first.overflow).toBe(2);
    const next = await render(input(messages.slice(1)));
    expect(next.renderedCount).toBe(1); expect(next.ranges[0].seqs).toEqual([2]);
  });
  it('returns exact seq lists and per-channel ranges without inventing intermediate messages', async () => {
    const out = await render(input([msg(2), msg(8, { channelId: 'channel-b' }), msg(7)], { maxMessages: 2 }));
    expect(out.ranges).toEqual([{ channelId: 'channel-a', fromSeq: 2, throughSeq: 7, seqs: [2,7] }]);
    expect(out.renderedCount).toBe(2); expect(out.overflow).toBe(1);
  });
  it('keeps same-seq messages in different channels distinct', async () => {
    const out = await render(input([msg(1), msg(1, { channelId: 'channel-b', body: 'other' })]));
    expect(out.ranges).toEqual([
      { channelId: 'channel-a', fromSeq: 1, throughSeq: 1, seqs: [1] },
      { channelId: 'channel-b', fromSeq: 1, throughSeq: 1, seqs: [1] },
    ]);
    expect(out.text).toContain('body-1'); expect(out.text).toContain('other');
  });
  it('flattens line separators in all supplied display text without losing message content', async () => {
    const out = await render({ workerName: 'Li\nam', messages: [msg(1, { authorName: 'A\r\nda', body: 'one\ntwo\rthree\u2028four\u2029five' })] });
    expect(out.text).not.toMatch(/[\r\n\u2028\u2029]/);
    expect(out.text).toContain('one two three four five');
  });
  it('collapses replies to the same parent into one entry, counting each child and ordering children by seq', async () => {
    const out = await render(input([
      msg(9, { parentSeq: 4, body: 'child-nine', createdAt: new Date(1) }),
      msg(7, { parentSeq: 4, body: 'child-seven', createdAt: new Date(2) }),
    ]));
    expect(out.renderedCount).toBe(2);
    expect(out.text.match(/re #4/g)).toHaveLength(1);
    expect(out.text.indexOf('child-seven')).toBeLessThan(out.text.indexOf('child-nine'));
    expect(out.ranges[0]).toEqual({ channelId: 'channel-a', fromSeq: 7, throughSeq: 9, seqs: [7,9] });
  });
  it('never collapses same-parent-seq replies from different channels', async () => {
    const out = await render(input([msg(5, { parentSeq: 1 }), msg(5, { channelId: 'channel-b', parentSeq: 1 })]));
    expect(out.text.match(/re #1/g)).toHaveLength(2);
    expect(out.renderedCount).toBe(2); expect(out.ranges).toHaveLength(2);
  });
  it('uses only supplied parent metadata, flattens it and limits the excerpt to 80 characters', async () => {
    const excerpt = 'p'.repeat(80);
    const out = await render(input([msg(5, { parentSeq: 1, parent: { seq: 1, authorName: 'Gil\nHead', excerpt: excerpt + 'SECRET-TAIL' } })]));
    expect(out.text).toContain('(re #1 Gil Head: "' + excerpt + '")');
    expect(out.text).not.toContain('SECRET-TAIL');
    expect(out.renderedCount).toBe(1); expect(out.ranges[0].seqs).toEqual([5]);
  });
  it('uses a seq-only stub when the loader provides no parent metadata', async () => {
    const out = await render(input([msg(5, { parentSeq: 1, parent: null })]));
    expect(out.text).toContain('(re #1)');
    expect(out.text).not.toContain('undefined');
  });
  it('exports the sole overflow command and fixed final reply hint', async () => {
    const module = await import(/* @vite-ignore */ path);
    expect(module.OVERFLOW_READ_COMMAND).toBe('hadron team chat inbox');
    expect(module.REPLY_HINT).toBe('reply: hadron team chat post --reply-to <seq> "@name …"');
    const out = module.renderBatch(input([msg(1), msg(2)], { maxMessages: 1 }));
    expect(out.text.endsWith(module.REPLY_HINT)).toBe(true);
  });
  it('honors tighter optional budgets while never widening the 10-message ceiling', async () => {
    const messages = Array.from({ length: 12 }, (_, i) => msg(i + 1, { body: 'xx' }));
    expect((await render(input(messages, { maxMessages: 50 }))).renderedCount).toBe(10);
    const short = await render(input(messages, { maxChars: 5 }));
    expect(short.renderedCount).toBe(2); expect(short.overflow).toBe(10);
    const oversize = await render(input(messages, { maxChars: 1 }));
    expect(oversize.renderedCount).toBe(1); expect(oversize.text).toContain('xx');
  });
  it('groups at first occurrence without reordering unrelated entries or mutating the parent', async () => {
    const parent = { seq: 1, authorName: 'Gil', excerpt: 'parent-context' };
    const messages = [msg(2, { parentSeq: 1, parent }), msg(3), msg(4, { parentSeq: 1, parent })];
    const out = await render(input(messages));
    expect(out).toEqual(await render(input([...messages].reverse())));
    expect(out.text.indexOf('body-4')).toBeLessThan(out.text.indexOf('body-3'));
    expect(out.renderedCount).toBe(3);
    expect(parent.excerpt).toBe('parent-context');
  });
  it('does not invent parent context when supplied parent identity disagrees', async () => {
    const out = await render(input([msg(5, { parentSeq: 1, parent: { seq: 99, authorName: 'Wrong', excerpt: 'not-the-parent' } })]));
    expect(out.text).toContain('(re #1)'); expect(out.text).not.toContain('not-the-parent');
  });
  it('uses the exact eligible total for overflow text and hash when given a bounded sample', async () => {
    const messages = Array.from({ length: 10 }, (_, i) => msg(i+1));
    const sampled = await render(input(messages, { totalEligible: 205 }));
    expect(sampled.renderedCount).toBe(10); expect(sampled.overflow).toBe(195);
    expect(sampled.text).toContain('+195 more waiting');
    expect(sampled.renderHash).toBe(createHash('sha256').update(sampled.text).digest('hex'));
    expect(sampled.renderHash).not.toBe((await render(input(messages))).renderHash);
    expect(sampled.ranges).toEqual((await render(input(messages))).ranges);
  });
  it.each([1, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects an invalid eligible total %s rather than inventing overflow', async (totalEligible) => {
    await expect(render(input([msg(1), msg(2)], { totalEligible }))).rejects.toThrow();
  });
  it('hashes the actual UTF-8 text, stable across shuffled inputs and sensitive to body changes', async () => {
    const out = await render(input([msg(2), msg(1)]));
    expect(out.renderHash).toBe(createHash('sha256').update(out.text, 'utf8').digest('hex'));
    expect(out.renderHash).toBe((await render(input([msg(1), msg(2)]))).renderHash);
    expect(out.renderHash).not.toBe((await render(input([msg(1), msg(2, { body: 'changed' })]))).renderHash);
  });
});

it('keeps a sequence prefix at the cap when a channel timestamp runs backward', async () => {
  const messages = Array.from({ length: 11 }, (_, i) => msg(i + 1, { createdAt: new Date(2000 - i) }));
  const out = await render(input(messages));
  expect(out.ranges[0].seqs).toEqual([1,2,3,4,5,6,7,8,9,10]);
  expect(out.text).not.toContain('body-11');
});

it('merges channel heads by time without letting a backward child leap over its lower seq', async () => {
  const out = await render(input([
    msg(1, { createdAt: new Date(2000) }),
    msg(2, { createdAt: new Date(500) }),
    msg(1, { channelId: 'channel-b', createdAt: new Date(1500), body: 'from-b' }),
  ], { maxMessages: 2 }));
  expect(out.ranges).toEqual([
    { channelId: 'channel-a', fromSeq: 1, throughSeq: 1, seqs: [1] },
    { channelId: 'channel-b', fromSeq: 1, throughSeq: 1, seqs: [1] },
  ]);
  expect(out.text.indexOf('from-b')).toBeLessThan(out.text.indexOf('body-1'));
});
