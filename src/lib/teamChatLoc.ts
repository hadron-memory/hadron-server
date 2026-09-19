/**
 * The canonical team-chat address, and the one rule that keeps the AGENT-chat
 * surface off it (#939 placement, #1030 collision).
 *
 * The team chat lives at loc `chats:team` in a team App's shared app-class
 * memory. That address sits inside the `chats:` namespace the agent-chatbot
 * surface enumerates and addresses by loc, so at the storage layer a team chat
 * is indistinguishable from one of the caller's own chatbot conversations —
 * same prefix, same `data.scope='shared'`. It therefore inherited every
 * affordance an agent chat has: listed in `myChats` titled from its first
 * message body, an LLM turn appended by `sendChatMessage` (bypassing the seq
 * allocator, mention extraction and the worker-authorship gate that
 * `createTeamChatMessage` owns), a rename, and a `deleteChat` that soft-deletes
 * the root and every message on it. None of those was a decision anyone made
 * about a team chat. See
 * `hrn:node:hadronmemory.com:dev:findings:well-known-loc-inside-an-enumerated-namespace`.
 *
 * The constants live here rather than in `resolvers.teamChat.ts` so the two
 * surfaces that must exclude the team chat — `myChats` (listing) and
 * `chatLocFilter` (addressing) — can import them without pulling the team-chat
 * resolver, and its transitive resolver graph, into `src/lib`. Same move as
 * `mentionTokenOf` in PR #978; `resolvers.teamChat.ts` re-exports both so
 * existing importers are unchanged.
 *
 * The team chat is not made unreachable by any of this — it is reachable
 * through the operations that own it, `teamChatMessages` and
 * `createTeamChatMessage`, which apply the team-membership gate and the seq +
 * authorship contract. What is refused here is reaching it through the
 * agent-chat surface, which applies neither.
 */

import type { Prisma } from '../generated/prisma/index.js';

/** Canonical loc of the one team chat in a team App's shared memory (#939). */
export const TEAM_CHAT_LOC = 'chats:team';

/** Loc of the message container under the team chat root. */
export const TEAM_CHAT_MESSAGES_LOC = `${TEAM_CHAT_LOC}:messages`;

/**
 * Is this loc the canonical team chat, or a node beneath it?
 *
 * The root matches EXACTLY and descendants only under the `:` separator, so a
 * user's own chat named `chats:team-retro` is untouched — a bare
 * `startsWith('chats:team')` would swallow it, which is the trap this predicate
 * exists to not fall into.
 *
 * Descendants are included because the whole subtree is the team's attribution
 * record: `chatLocFilter` takes a chat-root loc, but nothing stops a caller
 * passing `chats:team:messages`, and appending an LLM turn under it corrupts
 * the same record by a slightly longer route.
 */
export function isTeamChatLoc(loc: string): boolean {
  return loc === TEAM_CHAT_LOC || loc.startsWith(`${TEAM_CHAT_LOC}:`);
}

/**
 * The `isTeamChatLoc` rule as a Prisma clause, for the surfaces that SCAN the
 * `chats:` namespace instead of naming one loc.
 *
 * Spread into a `where` alongside the caller's own conditions. Both patterns
 * are compile-time constants containing no `_` or `%`, so the unescaped-LIKE
 * hazard in `findings:prisma-string-filters-are-unescaped-like` does not reach
 * here — keep it that way if this ever takes a runtime value.
 */
export const excludeTeamChat: Prisma.NodeWhereInput = {
  AND: [
    { NOT: { loc: TEAM_CHAT_LOC } },
    { NOT: { loc: { startsWith: `${TEAM_CHAT_LOC}:` } } },
  ],
};

/**
 * #1196 — the same rule keyed on what a node IS rather than what it is called.
 *
 * {@link excludeTeamChat} is loc-shaped, and that was sufficient only while a
 * Channel WAS `chats:team`. Spec 049 Phase 4 lets a Channel be created at any
 * address and #1196 in a memory of any class, so a Channel at `chats:release`
 * passes the loc test and would list as an agent chat — a Channel is not a
 * `cor:cht` conversation, and the chatbot surfaces must not reach one.
 *
 * Spread this ALONGSIDE `excludeTeamChat`, not instead of it: the loc rule
 * additionally covers a `chats:team` root whose Channel row has not been
 * created yet (the backfill-on-touch window, spec 049 §7.1), which this
 * relation filter cannot see.
 *
 * A relation subquery rather than a materialised id list: the database
 * evaluates it per row, so it cannot go stale between building the filter and
 * running it, and it enumerates nothing.
 */
export const excludeChannelRoots: Prisma.NodeWhereInput = { channel: null };
