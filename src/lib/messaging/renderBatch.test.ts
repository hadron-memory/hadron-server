/** #2017 slice (a): pure shared rendering, exact rendered ranges and bounded overflow. */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
const path = './renderBatch.js';
const render = async (input: Record<string, unknown>) => (await import(/* @vite-ignore */ path)).renderBatch(input);
const msg = (seq: number, extra: Record<string, unknown> = {}) => ({
  channelId: 'channel-a', seq, createdAt: new Date(1_700_000_000_000 + seq * 1000),
  authorName: 'Ada', body: `body-${seq}`, parentSeq: null, mentions: [], ...extra,
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
  it('renders 10 messages and leaves the 11th due with the exact final marker', async () => {
    const out = await render(input(Array.from({ length: 11 }, (_, i) => msg(i + 1))));
    expect(out.renderedCount).toBe(10);
    expect(out.overflow).toBe(1);
    expect(out.text).toMatch(/\[\+1 more, next batch\]$/);
    expect(out.text).not.toContain('body-11');
    expect(out.ranges).toEqual([{ channelId: 'channel-a', fromSeq: 1, throughSeq: 10, seqs: [1,2,3,4,5,6,7,8,9,10] }]);
  });
  it('does not add an overflow marker at the exact message cap', async () => {
    const out = await render(input(Array.from({ length: 10 }, (_, i) => msg(i + 1))));
    expect(out.renderedCount).toBe(10); expect(out.overflow).toBe(0);
  });
  it('counts the formatted delivery at the 6000/6001 character boundary', async () => {
    const baseline = await render(input([msg(1), msg(2, { body: 'x' })]));
    const fill = 'x'.repeat(6000 - baseline.text.length + 1);
    const exact = await render(input([msg(1), msg(2, { body: fill })]));
    expect(exact.text.length).toBe(6000); expect(exact.renderedCount).toBe(2);
    const over = await render(input([msg(1), msg(2, { body: fill + 'x' })]));
    expect(over.renderedCount).toBe(1); expect(over.overflow).toBe(1);
    expect(over.text.length).toBeLessThanOrEqual(6000);
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
  it('hashes the actual UTF-8 text, stable across shuffled inputs and sensitive to body changes', async () => {
    const out = await render(input([msg(2), msg(1)]));
    expect(out.renderHash).toBe(createHash('sha256').update(out.text, 'utf8').digest('hex'));
    expect(out.renderHash).toBe((await render(input([msg(1), msg(2)]))).renderHash);
    expect(out.renderHash).not.toBe((await render(input([msg(1), msg(2, { body: 'changed' })]))).renderHash);
  });
});
