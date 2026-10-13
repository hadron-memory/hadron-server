/**
 * THE team-space predicate — "is this app-class row the App's TEAM SPACE, whose
 * audience is App participation?" — in one place, as both a Prisma `where`
 * fragment and an in-memory test over an already-loaded row.
 *
 * [`cor:acl:010:01`](hrn:node:hadronmemory.com:specs:cor:acl:010:01) says it
 * outright, and the sentence is the reason this module exists:
 *
 * > `app` is a **tenancy bucket, not an audience**. One App owns up to four
 * > kinds of app-class row … `chk_memory_class_app_id` makes `app_id` REQUIRED
 * > for the app class, **which is why `appId + class='app'` selects all four
 * > roles and must be narrowed**.
 *
 * | kind | discriminator | audience |
 * |---|---|---|
 * | **Team space** | none of the below | **App participants** |
 * | Worker working memory | a `Worker` points at it (`workerOf`) | the worker-internals audience |
 * | Session memory | `userMemoryOfAgentId` set | only through its session binding |
 * | Free-standing app memory | none of the below | App participants, as the team space |
 *
 * …plus spec 047's orthogonal axis: a **user-owned** row (`ownerUserId`) is
 * strictly owner-only whatever its class — EXCEPT the team space of a user-owned
 * App, the App owner's own app-class row, whose audience is the App's
 * participants (its owner and its members, #1764).
 *
 * **Why a module and not four inline copies.** PR #1207 wrote this narrowing
 * out once, in `resolveChannelTarget`, over four review rounds — and left the
 * three sibling call sites keyed on `class='app' + appId`, which is the trap
 * the spec paragraph names. `locateTeamChatRoot` could then select a Channel at
 * `chats:team` in a Worker's memory and hand the App-ref conveniences the
 * participation gate; `chatLocFilter`'s app-class arm let a participant reach
 * another user's SESSION transcript, which `saveChatSummary` writes to. Every
 * one of those is the same missing clause. A predicate restated per call site
 * is a predicate that will be narrowed per call site, one review round at a
 * time — see `review:narrow-to-every-discriminator-the-spec-names`.
 *
 * NOT to be confused with the team-space IDENTITY predicate (#1031, "which
 * memory IS the team space") — that one must pick exactly ONE row and so
 * requires the #723 shared key, which excludes legacy and name-addressable
 * rows. This is the READ-ACCESS question and is legitimately broader:
 * over-admitting is right here and wrong there, which is why they must not
 * share a definition.
 */

import type { Prisma } from '../../generated/prisma/index.js';

/**
 * The `where` fragment selecting an App's team-space-audience rows. Spread it
 * alongside an `appId` condition — this fragment deliberately does NOT name the
 * App, so a caller cannot forget to scope it and silently match every App's.
 */
export const teamSpaceAudienceFilter = {
  class: 'app',
  deletedAt: null,
  workerOf: { none: {} },
  userMemoryOfAgentId: null,
} as const satisfies Prisma.MemoryWhereInput;

/** The columns {@link isTeamSpaceRow} needs — select these on the memory. */
export interface TeamSpaceRowShape {
  class: string;
  appId: string | null;
  ownerUserId: string | null;
  userMemoryOfAgentId: string | null;
  /** Any non-empty array means a Worker claims this memory. `take: 1` is enough. */
  workerOf: readonly unknown[];
}

/**
 * The same rule over an already-loaded row, for a caller that has the memory in
 * hand rather than a query to constrain.
 *
 * **The ownership discriminator is the APP's, not the caller's** (@copilot round
 * 6). "Is this row the App's team space?" is a question about the App; keying it
 * on `callerUserId` alone meant a user-owned app-class memory attached to an
 * ORG-owned App classified as that App's team space for whoever happened to own
 * it — and under impersonation `ctx.userId` is the TARGET, so a row owned by the
 * target took the participation path and `hostMemoryReadable` returned true on
 * `app` alone, bypassing the shared gate's rule that user-owned memories are
 * invisible to support sessions. Fifth instance of the #876 class in this PR's
 * review, and the first inside a predicate I had just extracted to stop exactly
 * this.
 *
 * So a user-owned row is a team space only when it is owned by the APP's owner
 * (an org-owned App's team space is `ownerUserId: null`, full stop) and the
 * context is not an impersonated support session. WHO may open it is the
 * participation gate's question, asked after this classification: since #1764
 * (Holger "A", #8151/#8155) a user-owned App's participants are its owner AND
 * its members, so the caller is no longer part of the classification — the
 * earlier "the CALLER is that owner" clause answered an access question inside
 * a classification.
 */
export function isTeamSpaceRow(
  mem: TeamSpaceRowShape,
  opts: {
    /** `App.ownerUserId` — null for an org-owned App. */
    appOwnerUserId: string | null;
    /** True when the context is an impersonated support session. */
    impersonating: boolean;
  },
): boolean {
  if (mem.class !== 'app' || mem.appId === null) return false;
  if (mem.userMemoryOfAgentId !== null || mem.workerOf.length > 0) return false;
  if (mem.ownerUserId === null) return true;
  // spec 047: the App owner's row is the team space of a user-owned App, and no support-session path reaches it.
  // Everyone else's user-owned row is not (strict owner-only memories, whatever their class).
  if (opts.impersonating) return false;
  return mem.ownerUserId === opts.appOwnerUserId;
}

/**
 * The ownership half of {@link teamSpaceAudienceFilter}, as a `where` fragment —
 * for the query-shaped callers, which must apply the same rule as
 * {@link isTeamSpaceRow}.
 *
 * An org-owned App's team space is `ownerUserId: null`. A user-owned App's is
 * its owner's row; whether the caller may open it is the participation gate's
 * question (#1764), so the fragment no longer depends on who asks.
 */
export function teamSpaceOwnerFilter(opts: {
  appOwnerUserId: string | null;
  impersonating: boolean;
}): Prisma.MemoryWhereInput {
  return !opts.impersonating && opts.appOwnerUserId !== null
    ? { OR: [{ ownerUserId: null }, { ownerUserId: opts.appOwnerUserId }] }
    : { ownerUserId: null };
}
