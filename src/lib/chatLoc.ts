/**
 * Chat-loc resolution (#829).
 *
 * A chat is addressed by its `loc` (the "chatId"). `Node.loc` is unique per
 * MEMORY, not globally (`@@unique([loc, memoryId])`), so a loc can name more
 * than one node — and any tenant can create a node at any loc in a memory they
 * can write. Two earlier attempts at this both failed, in opposite directions:
 *
 * 1. **Scoping with the shared read gate** (`memoryAccessFilter`) breaks shared
 *    app chats. `getAccessibleMemoryIds` covers `class IN (knowledge, group)`
 *    plus the caller's own holdings and reaches app/system memories via
 *    AppMember *elsewhere* — while the spec-017 chat gate grants app-class
 *    chats to any AppMember. The shared gate is NARROWER than the chat gate.
 *
 * 2. **Refusing to guess** — fetch two, throw if two come back — is a
 *    cross-tenant denial of service. Ambiguity was detected BEFORE the access
 *    rules, so an attacker who learns a chat id (every participant of a shared
 *    chat has one) could plant a node at that loc in their own memory and
 *    permanently break the rightful caller's chat. `findFirst` is only
 *    *intermittently* wrong under that attack; throwing makes it total.
 *
 * The rule that survives both: **resolve the collision INSIDE the caller's
 * authorized set, never before it.** A planted node then fails the caller's
 * entitlement and drops out, so it can neither be picked nor block the read.
 *
 * This filter is deliberately the UNION of every chat surface's gate — author,
 * memory creator, AppMember of an app-class memory, or platform admin. Being a
 * superset, it can only ever remove rows that no call site would have accepted,
 * so it narrows the candidates without narrowing access. Each site still runs
 * its own (stricter) gate on the result, unchanged.
 *
 * Applying it in the DB rather than in memory also means `take: 2` is safe: the
 * attacker's rows never come back, so they cannot crowd the caller's own row
 * out of a capped fetch.
 */

import type { PrismaClient } from '../generated/prisma/index.js';

/** The fields of a GraphQL `Context` / MCP `AuthContext` this needs. */
export interface ChatLocPrincipal {
  userId?: string | null;
  roles?: readonly string[] | null;
}

/**
 * A chat loc matched more than one node THE CALLER IS ENTITLED TO.
 *
 * Unreachable in practice: a chat loc is `chats:<ts>-<8 hex>-<sanitized name>`,
 * and an attacker's planted node is filtered out before this can fire. It
 * exists so that if the uniqueness assumption ever breaks for real, it breaks
 * loudly instead of silently reading the wrong conversation.
 */
export class AmbiguousChatLocError extends Error {
  constructor(public readonly chatId: string, public readonly count: number) {
    super(
      `Chat "${chatId}" matches at least ${count} chat nodes you can access. ` +
        `Refusing to guess which one you meant — chat locs are expected to be unique.`,
    );
    this.name = 'AmbiguousChatLocError';
  }
}

/**
 * Build the `where` for a chat-loc lookup, narrowed to nodes this principal
 * could plausibly be entitled to.
 *
 * Pass the result straight to `findMany` with whatever `select` the call site
 * needs and `take: 2`, then hand the rows to `exactlyOneChatNode`.
 *
 * A platform admin gets no entitlement narrowing (they can read across
 * tenants), so a collision stays visible to them as an ambiguity error rather
 * than an arbitrary pick — the right answer for an operator, who can
 * disambiguate with the node's primary key.
 */
export async function chatLocFilter(
  db: Pick<PrismaClient, 'appMember'>,
  chatId: string,
  principal: ChatLocPrincipal,
  opts: { includeDeleted?: boolean } = {},
): Promise<Record<string, unknown>> {
  const base = {
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
        ? [{ memory: { class: 'app' as const, appId: { in: appIds } } }]
        : []),
    ],
  };
}

/**
 * Pick the single chat node the caller is entitled to, or refuse.
 *
 * Returns null when nothing matched, so each call site keeps its own not-found
 * message. Throws only when the caller can legitimately reach two chats at the
 * same loc — which the filter above makes unreachable for an attacker.
 */
export function exactlyOneChatNode<T>(rows: T[], chatId: string): T | null {
  if (rows.length > 1) throw new AmbiguousChatLocError(chatId, rows.length);
  return rows[0] ?? null;
}
