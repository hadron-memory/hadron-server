import { createHash } from 'node:crypto';

export type BatchMessage = {
  channelId: string; seq: number; createdAt: Date; authorName: string;
  body: string; parentSeq: number | null;
  parent: { seq: number; authorName: string; excerpt: string } | null; mentions: string[];
};
export type RenderInput = { workerName: string; messages: BatchMessage[]; maxMessages?: number; maxChars?: number; totalEligible?: number };
export type RenderedRange = { channelId: string; fromSeq: number; throughSeq: number; seqs: number[] };
export type RenderOutput = { text: string; ranges: RenderedRange[]; renderedCount: number; overflow: number; renderHash: string };

/** cor:agt:080:26: preserve message text, flatten only input-submitting line separators. */
const oneLine = (value: string): string => value.replace(/\r\n|[\r\n\u2028\u2029]/g, ' ');
const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
export const REPLY_HINT = 'reply: hadron team chat post --reply-to <seq> "@name …"';

/** C7 owns the eventual command name; all overflow rendering uses this constant. */
export const OVERFLOW_READ_COMMAND = 'hadron team chat inbox';

function parentHint(message: BatchMessage): string {
  if (message.parentSeq === null) return '';
  const parent = message.parent;
  if (!parent || parent.seq !== message.parentSeq) return ` (re #${message.parentSeq})`;
  const excerpt = oneLine(parent.excerpt).slice(0, 80);
  return ` (re #${message.parentSeq} ${oneLine(parent.authorName)}: "${excerpt}")`;
}

function format(workerName: string, messages: BatchMessage[], overflow: number): string {
  if (messages.length === 0) return '';
  const groups = new Map<string, BatchMessage[]>();
  for (const message of messages) {
    if (message.parentSeq === null) continue;
    const key = JSON.stringify([message.channelId, message.parentSeq]);
    const group = groups.get(key) ?? [];
    group.push(message); groups.set(key, group);
  }
  const emitted = new Set<string>();
  const entries: string[] = [];
  for (const message of messages) {
    if (message.parentSeq === null) {
      entries.push(`#${message.seq} ${oneLine(message.authorName)}: ${oneLine(message.body)}`);
      continue;
    }
    const key = JSON.stringify([message.channelId, message.parentSeq]);
    if (emitted.has(key)) continue;
    emitted.add(key);
    const children = [...groups.get(key)!].sort((a, b) => a.seq - b.seq);
    entries.push(children.map((child, index) =>
      `#${child.seq} ${oneLine(child.authorName)}${index === 0 ? parentHint(child) : ''}: ${oneLine(child.body)}`).join('; '));
  }
  return [
    `[hadron chat] ${messages.length} for ${oneLine(workerName)}`,
    ...entries,
    ...(overflow > 0 ? [`+${overflow} more waiting`, `read: ${OVERFLOW_READ_COMMAND}`] : []),
    REPLY_HINT,
  ].join(' · ');
}

/** #2017 slice (a), cor:agt:080:26. Input contains eligible messages only.
 * Select an oldest prefix before rendering: no omitted eligible message is skipped
 * for a smaller later one. The first message is always delivered whole, alone
 * if its body exceeds the character budget. Only flattened bodies count toward
 * the budget (Liam #21298); header, authors, parent context, overflow and hint do not.
 * The loader may supply a bounded sample plus its exact totalEligible; counts
 * outside that sample affect overflow text/hash, never rendered ranges.
 * Parent context is supplied by the loader under its two-reader gate. No DB/auth/proof work.
 */
export function renderBatch(input: RenderInput): RenderOutput {
  const totalEligible = input.totalEligible ?? input.messages.length;
  if (!Number.isSafeInteger(totalEligible) || totalEligible < input.messages.length) {
    throw new RangeError('totalEligible must be a safe integer at least messages.length.');
  }
  // A mark covers by seq. Merge channel prefixes by their oldest available
  // head, never timestamp-sort within a channel (clocks can run backward).
  // A comparator mixing same-channel seq with cross-channel time is not
  // transitive, so make the per-channel ordering explicit first.
  const queues = new Map<string, BatchMessage[]>();
  for (const message of input.messages) {
    const queue = queues.get(message.channelId) ?? [];
    queue.push(message); queues.set(message.channelId, queue);
  }
  for (const queue of queues.values()) queue.sort((a, b) => a.seq - b.seq);
  const messageLimit = Math.min(10, input.maxMessages ?? 10);
  const ordered: BatchMessage[] = [];
  while (queues.size && ordered.length < messageLimit) {
    const head = [...queues.values()].map(q => q[0]).sort((a, b) =>
      a.createdAt.getTime() - b.createdAt.getTime() || compareText(a.channelId, b.channelId) || a.seq - b.seq)[0];
    ordered.push(head);
    const queue = queues.get(head.channelId)!;
    queue.shift();
    if (!queue.length) queues.delete(head.channelId);
  }
  const characterLimit = Math.min(6000, input.maxChars ?? 6000);
  const selected: BatchMessage[] = [];
  let bodyCharacters = 0;
  for (const message of ordered) {
    if (selected.length >= messageLimit) break;
    const nextCharacters = bodyCharacters + oneLine(message.body).length;
    if (nextCharacters > characterLimit && selected.length > 0) break;
    selected.push(message);
    bodyCharacters = nextCharacters;
    if (nextCharacters > characterLimit) break;
  }
  const overflow = totalEligible - selected.length;
  const text = format(input.workerName, selected, overflow);
  const channels = new Map<string, number[]>();
  for (const message of selected) {
    const seqs = channels.get(message.channelId) ?? [];
    seqs.push(message.seq); channels.set(message.channelId, seqs);
  }
  const ranges = [...channels].sort(([a], [b]) => compareText(a, b)).map(([channelId, seqs]) => {
    seqs.sort((a, b) => a - b);
    return { channelId, fromSeq: seqs[0], throughSeq: seqs[seqs.length - 1], seqs };
  });
  return { text, ranges, renderedCount: selected.length, overflow, renderHash: createHash('sha256').update(text, 'utf8').digest('hex') };
}
