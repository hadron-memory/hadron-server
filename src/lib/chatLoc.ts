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

/** The fields of a GraphQL `Context` / MCP `AuthContext` this needs. */
export interface ChatLocPrincipal {
  userId?: string | null;
  roles?: readonly string[] | null;
}

/**
 * Build the `where` for a chat-loc lookup, narrowed to nodes this principal
 * could plausibly be entitled to.
 *
 * Pair it with `orderBy: { createdAt: 'asc' }`, `take: 2`, and `pickChatNode`.
 */
export async function chatLocFilter(
  db: Pick<PrismaClient, 'appMember'>,
  chatId: string,
  principal: ChatLocPrincipal,
  opts: { includeDeleted?: boolean } = {},
): Promise<Prisma.NodeWhereInput> {
  const base: Prisma.NodeWhereInput = {
    loc: chatId,
    ...(opts.includeDeleted ? {} : { deletedAt: null }),
  };

  const isAdmin = !!principal.roles?.some((r) => r === 'ADMIN' || r === 'OWNER');
  if (isAdmin) return base;

  const userId = principal.userId;
  // No user identity (e.g. a bare App-key caller) — entitlement can only come
  // from an app-class memory, and we have no AppMember rows to match. Return a
  // filter that matches nothing rather than one that matches everything.
  if (!userId) return { ...base, id: '__no_principal__' };

  // App-class chats are shared with every member of the owning App — the branch
  // the generic read gate deliberately does not cover.
  const memberships = await db.appMember.findMany({
    where: { userId },
    select: { appId: true },
  });
  const appIds = memberships.map((m) => m.appId);

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
