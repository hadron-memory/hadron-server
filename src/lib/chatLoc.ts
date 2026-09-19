/**
 * Chat-loc resolution (#829).
 *
 * A chat is addressed by its `loc` (the "chatId"). `Node.loc` is unique per
 * MEMORY, not globally (`@@unique([loc, memoryId])`), so a loc can name more
 * than one node — and any tenant can create a node at any loc in a memory they
 * can write. Three attempts, and the two failure modes worth remembering:
 *
 * 1. **Scoping with the shared read gate** (`memoryAccessFilter`) breaks shared
 *    app chats. `getAccessibleMemoryIds` covers `class IN (knowledge, group)`
 *    plus the caller's own holdings and reaches app/system memories via
 *    AppMember *elsewhere* — while the spec-017 chat gate grants app-class
 *    chats to any AppMember. The shared gate is NARROWER than the chat gate.
 *
 * 2. **Treating a collision as an error** is a denial of service, and narrowing
 *    who can trigger it only shrinks the blast radius. Planting a node at a
 *    known chat loc made the rightful caller's read throw — first from any
 *    tenant (PR #828 review), then, once entitlement filtering landed, from any
 *    CO-MEMBER of one of the caller's Apps, who can write the loc into a second
 *    app-class memory the caller also belongs to (PR #830 review). Any rule
 *    that lets a stranger's row decide whether YOUR read succeeds is the bug.
 *
 * So this does two independent things:
 *
 * - **`chatLocFilter` bounds what can be READ.** It is the UNION of every chat
 *   surface's gate — author, memory creator, AppMember of an app-class memory,
 *   platform admin. Being a superset it can only remove rows no call site would
 *   have accepted, so it narrows candidates without narrowing access, and each
 *   site's own (stricter) gate still runs on the result.
 *
 * - **`pickChatNode` makes the choice DETERMINISTIC and unforgeable**, instead
 *   of erroring. Callers order by `createdAt ASC` and the oldest wins. A plant
 *   is always NEWER than the chat it imitates: the attacker must learn the chat
 *   id before they can copy it, which requires the chat to already exist, and
 *   `createdAt` is `@default(now())` — server-set, not caller-supplied. Locs
 *   carry a timestamp plus 8 random hex, so pre-creating a future chat's loc is
 *   not feasible either. The original therefore always wins, and a planted row
 *   can neither be selected nor prevent selection.
 *
 * Together: a stranger's row can't be read (filter) and can't interfere
 * (ordering). Availability beats loudness here — an error would have handed an
 * attacker exactly the outcome they wanted.
 */

import type { Prisma, PrismaClient } from '../generated/prisma/index.js';
import { isTeamChatLoc } from './teamChatLoc.js';
import { participantAppIds } from './auth/appParticipation.js';
import { ancestorLocs } from './nodeSubtreeLock.js';

/** The fields of a GraphQL `Context` / MCP `AuthContext` this needs. */
export interface ChatLocPrincipal {
  userId?: string | null;
  roles?: readonly string[] | null;
  /**
   * #1196 — carried so `participantAppIds`' org arm stays BOUNDED to the
   * support session's one shared org. Without it that arm would answer a
   * question about the TARGET's memberships anywhere, which is the #876 shape:
   * `userId` is the target under impersonation, so an identity-keyed predicate
   * fails OPEN. Every caller passes its `Context`/`AuthContext` whole, so this
   * arrives by structural typing rather than needing a new argument.
   */
  impersonation?: { orgId: string } | null;
}

/**
 * A filter that matches no row, for the two cases where the answer is "nothing"
 * rather than "everything": a principal with no identity to match on, and the
 * team chat (#1030). Returning it — rather than throwing — keeps each call site
 * on its own not-found path, exactly as an unknown chat id already behaves.
 *
 * `id: { in: [] }` compiles to a false condition. It replaces the earlier
 * `id: '__no_principal__'` sentinel, which was NOT unsatisfiable: `Node.id` is
 * a forced primary key a caller supplies verbatim through `CreateNodeInput.id`
 * (the importer/sync case), so the sentinel is an ordinary, guessable value and
 * a row could simply BE it (Codex P2 on PR #1042 — verified by planting one).
 * That made the refusal above bypassable exactly where it matters: plant
 * `chats:team` with that PK in a team memory you can write, let the first real
 * post adopt it as the team-chat root, and the agent-chat operations reach the
 * team's own record again. It cost the no-identity branch the same property,
 * which is why the fix belongs here rather than in the team-chat branch alone.
 *
 * Keep this predicate logically contradictory. A specific value — however
 * unlikely-looking — is a value someone can write.
 */
const matchesNothing = (base: Prisma.NodeWhereInput): Prisma.NodeWhereInput => ({
  ...base,
  id: { in: [] },
});

/**
 * Build the `where` for a chat-loc lookup, narrowed to nodes this principal
 * could plausibly be entitled to.
 *
 * Pair it with `orderBy: { createdAt: 'asc' }`, `take: 2`, and `pickChatNode`.
 */
export async function chatLocFilter(
  // Widened for `participantAppIds` (#1196): the audience is no longer
  // answerable from the member table alone.
  db: Pick<PrismaClient, 'appMember' | 'orgMember' | 'app'>,
  chatId: string,
  principal: ChatLocPrincipal,
  opts: { includeDeleted?: boolean } = {},
): Promise<Prisma.NodeWhereInput> {
  const base: Prisma.NodeWhereInput = {
    loc: chatId,
    ...(opts.includeDeleted ? {} : { deletedAt: null }),
  };

  // #1030: the team chat is NOT an agent chat, and this is the one gate every
  // surface that addresses a chat by loc already runs — sendChatMessage,
  // processChatResponse, saveChatSummary, updateChatTitle, deleteChat,
  // chatHistory, and their MCP twins. Refusing here means none of them can
  // reach `chats:team`, and a chat surface added later inherits the refusal
  // instead of having to remember it. It sits ABOVE the admin branch on
  // purpose: platform admins skip entitlement narrowing, so the one principal
  // who could delete another team's chat outright would otherwise be the only
  // one still able to. The team chat's own operations are unaffected — they
  // never come through here.
  if (isTeamChatLoc(chatId)) return matchesNothing(base);
  // #1196 — the loc-shaped half of that rule stopped being sufficient. A
  // Channel used to be `chats:team` in an app-class memory, so its LOC
  // identified it; since spec 049 Phase 4 a Channel may be created at any
  // address, and since #1196 in a memory of any class. `isTeamChatLoc` is kept
  // rather than replaced because it is a cheap pre-check that needs no query
  // AND it covers a `chats:team` root that has no Channel row yet — the
  // backfill-on-touch window (spec 049 §7.1).
  //
  // Expressed as RELATION filters rather than an id list: a subquery the
  // database evaluates per row cannot go stale between building the filter and
  // running it, and it does not enumerate. A Channel is not a `cor:cht`
  // conversation, so no chatbot surface may reach one — the same refusal as
  // above, keyed on what the node IS rather than on what it is called.
  //
  // TWO clauses, because the root is not the whole Channel (@copilot round 3).
  // `channel: null` uses the `ChannelRoot` back-relation and therefore excludes
  // ONLY the root: the `:messages` container and the message rows beneath it
  // have no such relation. This filter matches an EXACT loc the caller supplies,
  // and `chats:team:messages` is a documented shape — so a Channel at
  // `chats:release` was still reachable as `chats:release:messages`, where
  // `deleteChat` would soft-delete the transcript container of a chat the chatbot
  // surfaces are not supposed to be able to see at all.
  //
  // The subtree clause closes it by asking whether any ANCESTOR of this loc (or
  // the loc itself) is a Channel's address IN THE SAME MEMORY — the relation
  // supplies that scoping, so it is not a cross-memory loc match
  // (findings:unscoped-loc-lookup-crosses-memories). A bounded `IN` over the
  // loc's own prefixes, never a `startsWith`, so the unescaped-LIKE hazard in
  // `findings:prisma-string-filters-are-unescaped-like` cannot reach a caller
  // value.
  base.channel = null;
  base.memory = { channels: { none: { loc: { in: [...ancestorLocs(chatId), chatId] } } } };

  // Platform ADMIN/OWNER skip entitlement narrowing — EXCEPT into the
  // strict-owner classes, where `cor:acl:010:02` gives them no bypass at all
  // (@copilot round 3). Without this carve-out the admin branch selected a chat
  // in another user's `personal`/`private` memory, the site gate then refused
  // it, and the admin learned the chat EXISTS: a random loc answers "not
  // found", a real one answered `Forbidden`. That is the existence oracle #829
  // built this filter to remove, so it belongs here — narrowing the candidate
  // set — rather than as a collapse of the refusal at the call site, which
  // would also have cost the entitled-but-unauthorized caller their
  // (deliberate, documented) `Forbidden`.
  //
  // Mirrors `getAccessibleMemoryIds`' admin branch, which returns an explicit
  // id list rather than "no filter" for exactly this reason.
  //
  // TWO strict-ownership axes, not one (@copilot round 4). `class IN
  // (personal, private)` keyed on `Memory.userId` is the 034 axis; spec 047
  // added `ownerUserId` as a SECOND, ORTHOGONAL one — a user-owned memory of
  // ANY class is owner-only and a platform admin gets no bypass into it either.
  // `getAccessibleMemoryIds`' admin branch excludes both, so covering only the
  // first left the same oracle alive for a user-owned knowledge or system
  // memory.
  const self = principal.userId ?? '__no_principal__';
  const strictOwnerOk: Prisma.NodeWhereInput = {
    AND: [
      { memory: { OR: [{ class: { notIn: ['personal', 'private'] as never } }, { userId: self }] } },
      { memory: { OR: [{ ownerUserId: null }, { ownerUserId: self }] } },
    ],
  };
  const isAdmin = !!principal.roles?.some((r) => r === 'ADMIN' || r === 'OWNER');
  if (isAdmin) return { ...base, AND: [strictOwnerOk] };

  const userId = principal.userId;
  // No user identity (e.g. a bare App-key caller) — entitlement can only come
  // from an app-class memory, and we have no AppMember rows to match. Return a
  // filter that matches nothing rather than one that matches everything.
  if (!userId) return matchesNothing(base);

  // App-class chats are shared with every PARTICIPANT of the owning App.
  //
  // This used to be `appMember.findMany` alone, and the header above claims the
  // filter is a SUPERSET of every chat surface's gate — "it can only remove
  // rows no call site would have accepted". #1196 broke that claim from the
  // other end: `chatHistory` now gates on the shared participation audience, so
  // an org CONTRIBUTOR who is not an AppMember passed the real gate and was
  // filtered out HERE, before reaching it, receiving "not found" for a chat
  // they may read (@copilot on PR #1207).
  //
  // Fixed by sharing the rule rather than by copying it again
  // (`participantAppIds`): a set copy and a predicate copy of one audience is
  // the drift #1196 exists to remove. `includeMemberships` puts the AppMember
  // arm back, which this caller needs and the access-control fold does not.
  const appIds = await participantAppIds(db, principal, { includeMemberships: true });

  return {
    ...base,
    OR: [
      // The caller wrote this chat.
      { createdBy: userId },
      // The caller owns the memory holding it (per-user agent holdings, and the
      // defensive personal-class fallback the read gate keeps).
      { memory: { createdBy: userId } },
      // A shared app chat in an App the caller belongs to.
      ...(appIds.length > 0
        ? [{ memory: { class: 'app', appId: { in: appIds } } } as Prisma.NodeWhereInput]
        : []),
    ],
  };
}

/**
 * Pick the chat node from an entitled, `createdAt ASC`-ordered candidate list.
 *
 * The OLDEST wins — see the header for why that is unforgeable. Returns null
 * when nothing matched, so each call site keeps its own not-found message.
 *
 * Deliberately does NOT throw on multiple rows. An error here would let anyone
 * who can write one node decide whether someone else's chat is readable; that
 * was the #828 and #830 review findings, in two different disguises. A
 * collision is still worth knowing about, so it is logged and moved past.
 */
export function pickChatNode<T extends { id: string }>(rows: T[], chatId: string): T | null {
  if (rows.length > 1) {
    console.warn(
      `[chatLoc] loc "${chatId}" matches ${rows.length}+ nodes this caller may access; ` +
        `taking the oldest (${rows[0].id}). Chat locs are expected to be unique — ` +
        `if this is not a planted duplicate, something upstream is minting colliding locs.`,
    );
  }
  return rows[0] ?? null;
}
