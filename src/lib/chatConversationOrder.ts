/**
 * #3405: deterministic conversation order for chat starts and the fallback re-route.
 *
 * Spec: hrn:node:hadronmemory.com:specs:cor:cht:020:01 step 1 (ruling 0127), and the
 * order the re-route walks under cor:cht:030:02 step 3.
 *
 * Order is by `loc`, compared on UTF-16 code units in application code (`<` on JS
 * strings). It is never the database collation or a locale compare, so the answer is
 * the same on any Postgres collation and on a published snapshot's array order.
 */

type ConversationNode = { loc: string; data?: unknown; seq?: number | null };

const flags = (n: ConversationNode) => (n.data as Record<string, unknown> | null | undefined) ?? {};

/** Code-unit `loc` order. Returns a new array; the input is not reordered. */
export function byLocCodeUnits<T extends { loc: string }>(nodes: readonly T[]): T[] {
  return [...nodes].sort((a, b) => (a.loc < b.loc ? -1 : a.loc > b.loc ? 1 : 0));
}

/**
 * #4039 (cor:cht:020:02 step 1, Q14/Q14a): the author's order. `Node.seq` ascending, a conversation with no `seq` after every
 * set value, any tie by `loc` in code-unit order, so the order is total. With no `seq` anywhere it is exactly the `loc` order.
 */
export function byAuthorOrder<T extends { loc: string; seq?: number | null }>(nodes: readonly T[]): T[] {
  return [...nodes].sort((a, b) => {
    const as = a.seq ?? null;
    const bs = b.seq ?? null;
    if (as !== bs) {
      if (as === null) return 1;
      if (bs === null) return -1;
      return as - bs;
    }
    return a.loc < b.loc ? -1 : a.loc > b.loc ? 1 : 0;
  });
}

/** Top-level conversation nodes only (`conversations:<name>`), in the author's order ({@link byAuthorOrder}). */
export function topLevelConversations<T extends { loc: string; seq?: number | null }>(nodes: readonly T[]): T[] {
  return byAuthorOrder(nodes.filter((n) => n.loc.startsWith('conversations:') && n.loc.split(':').length === 2));
}

/** Neither setup nor fallback. */
export function isOrdinaryConversation(n: ConversationNode): boolean {
  const d = flags(n);
  return d.isSetup !== true && d.isFallback !== true;
}

/**
 * The conversation an unnamed start opens (cor:cht:020:01 step 1):
 * 1. the first ordinary conversation by code-unit `loc`;
 * 2. otherwise the first setup conversation (a conversation flagged both setup and fallback counts as setup);
 * 3. otherwise the first fallback conversation;
 * 4. otherwise null, and the caller keeps its AGENT_HAS_NO_CONVERSATIONS refusal.
 *
 * Selection does not look at `stageOrder`: a chosen conversation with no stages is still chosen,
 * so the caller's CONVERSATION_HAS_NO_STAGES refusal stands and nothing skips ahead.
 */
export function pickUnnamedStartConversation<T extends ConversationNode>(nodes: readonly T[]): T | null {
  const ordered = topLevelConversations(nodes);
  return ordered.find(isOrdinaryConversation) ?? pickSetupOrFallback(ordered);
}

function pickSetupOrFallback<T extends ConversationNode>(ordered: readonly T[]): T | null {
  return ordered.find((n) => flags(n).isSetup === true)
    ?? ordered.find((n) => flags(n).isFallback === true)
    ?? null;
}

/** True when this conversation node carries an entry condition (`data.entryCondition`, #4039 D7). */
export function hasEntryCondition(n: ConversationNode): boolean {
  const c = flags(n).entryCondition;
  return c !== undefined && c !== null;
}

/**
 * #4039 (cor:cht:020:02 steps 1-6): the conversation an UNNAMED start opens, by entry condition.
 * Walks the ordinary conversations in the author's order and opens the first whose condition holds (no condition holds,
 * step 4); when none does, ruling 0127's chain applies (setup, then fallback, else null). Setup and fallback are never
 * in the scan. `holds` may throw: a condition that cannot be evaluated refuses the start, and the scan never skips it (step 6).
 */
export async function pickEntryConversation<T extends ConversationNode>(
  nodes: readonly T[],
  holds: (conversation: T) => Promise<boolean>,
): Promise<T | null> {
  const ordered = topLevelConversations(nodes);
  for (const n of ordered) {
    if (!isOrdinaryConversation(n)) continue;
    if (!hasEntryCondition(n) || await holds(n)) return n;
  }
  return pickSetupOrFallback(ordered);
}
