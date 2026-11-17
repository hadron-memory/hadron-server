/**
 * #2987 (ruling V13, Holger 2026-10-31) — legacy chat messages are protected
 * history: no generic door sets or rewrites the `seq` of a `chat-message` /
 * `record` node.
 *
 * `protectedLoc.ts` already refuses every generic write UNDER a Channel's
 * address, and it keys on WHERE a write lands. Pre-Channel chats (mirrors,
 * chatbot `record` threads) have no Channel row, so that gate never saw them,
 * and `seq` is exactly what orders a conversation. This gate keys on WHAT the
 * node is, the other axis, and only on `seq`: V13 names `seq` alone (a content
 * edit stays allowed; Vera's FIT on #2987). The allocators that legitimately
 * assign `seq` (`appendChatMessage`, `createChannelMessage`, the chat
 * mutations) write through their own transactions and never reach it.
 *
 * Callers run it AFTER `assertLocWritable`, so a node under a Channel keeps its
 * existing `LOC_PROTECTED` refusal; what reaches this gate is a message outside
 * one. It applies to every principal, platform admins included, and runs before
 * any write. Both doors that carry their own inline gates (GraphQL
 * `writeNodeCore`, MCP `hadron_create_node` / `hadron_update_node`) call this
 * one function and re-check under the row lock.
 *
 * "A seq write" means the call names a `seq` that differs from the stored one
 * (`null` included): a client that round-trips a node with its seq unchanged
 * reorders nothing and is not refused. Three more shapes count, each found in
 * review of #2989:
 *   - the PRIOR type being a message, not only the resulting one (a message
 *     cannot shed its type and take a new seq in one write);
 *   - BECOMING a message while carrying a seq, named or stored (retype away, set
 *     a seq, retype back; or convert an ordered node into a message): only an
 *     allocator gives a message its seq;
 *   - `restoreNodeRevision`, which restores a revision's seq verbatim.
 * Not decided here: whether a message may leave the conversation by retyping to
 * another type with no seq named (the ruling names seq only); and `cloneNode`
 * copies a source seq onto a new row (`copiesSeq`), which can land over a
 * tombstone: an insertion at an existing position, not a reorder.
 */

import { GraphQLError } from 'graphql';

/** Node types whose `seq` is conversation order. Matches `backfillChannels`' MESSAGE_NODE_TYPES. */
export const MESSAGE_SEQ_NODE_TYPES: ReadonlySet<string> = new Set(['chat-message', 'record']);

/** The typed refusal — `extensions.code: 'SEQ_PROTECTED'`. Same message on GraphQL and MCP. */
export class LegacyMessageSeqError extends GraphQLError {
  constructor(public readonly op: string) {
    super(
      `SEQ_PROTECTED: a generic ${op} cannot set or change the seq of a chat message (nodeType chat-message or record) outside a Channel: seq is the order of the conversation and is protected history. Edit the content without naming seq, or post through a Channel.`,
      { extensions: { code: 'SEQ_PROTECTED', op } },
    );
    this.name = 'LegacyMessageSeqError';
  }
}

/** Whether `error` is the {@link LegacyMessageSeqError} refusal. */
export function isLegacyMessageSeqError(error: unknown): error is LegacyMessageSeqError {
  return error instanceof LegacyMessageSeqError;
}

/**
 * Refuse a generic write that sets or changes `seq` on a message node.
 *
 * @param prior   the row at the target loc (tombstone included), if any
 * @param nextType the `nodeType` the write names, if any (omitted keeps the prior one); a prior OR resulting message type is protected
 * @param seq     the `seq` the write names: `undefined` = not named
 */
export function assertNoGenericMessageSeqWrite(
  prior: { nodeType?: string | null; seq?: number | null } | null | undefined,
  nextType: string | null | undefined,
  seq: number | null | undefined,
  op: 'create' | 'update' | 'restore',
): void {
  // Protected when EITHER side is a message: judging only the resulting type let a message shed its type and
  // take a new seq in one write (BLIND review of #2989, P2). A prior tombstone counts, as in the comment gate.
  const resulting = nextType ?? prior?.nodeType ?? null;
  const priorProtected = prior?.nodeType != null && MESSAGE_SEQ_NODE_TYPES.has(prior.nodeType);
  const resultingProtected = resulting !== null && MESSAGE_SEQ_NODE_TYPES.has(resulting);
  if (!priorProtected && !resultingProtected) return;
  // BECOMING a message (a create, or a conversion from another type) while carrying a seq, named or stored,
  // is an insertion into the conversation: only an allocator gives a message its seq. Judging only a NAMED seq
  // let a message be moved in three single-purpose writes (retype away, set the seq, retype back) and let an
  // ordinary node with a seq be converted into a message at any position (security review of #2989, P2-1).
  if (!priorProtected) {
    const carried = seq !== undefined ? seq : (prior?.seq ?? null);
    if (carried !== null) throw new LegacyMessageSeqError(op);
    return;
  }
  if (seq === undefined) return;
  if (seq === (prior?.seq ?? null)) return;
  throw new LegacyMessageSeqError(op);
}
