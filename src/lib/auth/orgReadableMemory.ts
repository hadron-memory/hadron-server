/**
 * Org-membership / public / subscription memory read-set — the canonical
 * "what can a User principal read by virtue of org membership, public
 * visibility, or an org subscription" query.
 *
 * Extracted so the two memory-access surfaces compute an **identical** set and
 * cannot re-diverge:
 *   - the GraphQL portal gate (`getAccessibleMemoryIds` in
 *     `src/api/graphql/schema/resolvers.ts`), and
 *   - the MCP gate (`getMemoryAccess` in `src/mcp/access-control.ts`).
 *
 * Before this helper, the portal granted org members read on org `knowledge`
 * memories (via `OrgMember`), while MCP keyed *solely* off `AppMember` rows
 * (`resolveUserApps`). A freshly-onboarded org member therefore saw memories
 * in the portal but `hadron_list_memories` returned nothing until they installed an
 * Agent — the Micromentor onboarding incident (2026-06-13). Routing both
 * surfaces through this one query closes that divergence by construction.
 *
 * Scope (mirrors the portal's JWT-user OR-clause, **minus** the owner-only
 * personal/private + per-user "holding" clauses — those are identity-scoped,
 * not org-scoped, and each surface gates them on its own strict-ownership
 * path):
 *   - org-owned `knowledge` / `group` memories (`userMemoryOfAgentId IS NULL`,
 *     `app_id IS NULL` — an app-scoped one is App-internal, not org-wide; #653)
 *   - cross-org subscribed non-personal memories (never app-scoped)
 *   - `PUBLIC` non-personal, non-app-scoped memories (always — even with no orgs)
 *
 * **Read-only by nature.** Org membership confers READ; write stays gated by
 * the App/agent-role path in each caller. `personal`/`private` memories are
 * NEVER returned here — callers gate those by strict ownership.
 */

import type { PrismaClient } from '../../generated/prisma/index.js';

export async function getOrgReadableMemoryIds(
  db: PrismaClient,
  userId: string,
  // When set, scope the memory lookup to this single id (a single-memory
  // authorization check) so it stays an indexed point-read instead of
  // enumerating the whole org-readable set. The predicate is unchanged, just
  // narrowed — the result is `[onlyMemoryId]` or `[]`.
  onlyMemoryId?: string,
): Promise<string[]> {
  // Defensive: Prisma silently DROPS an `undefined` where-filter, so a
  // `userId === undefined` slipping through (upstream widening, a bad call
  // site) would turn `where: { userId }` into "all memberships" — a
  // catastrophic cross-org read. Fail closed instead.
  if (!userId) return [];

  const memberships = await db.orgMember.findMany({
    where: { userId, deletedAt: null },
    select: { organizationId: true },
  });
  const orgIds = memberships.map((m: { organizationId: string }) => m.organizationId);

  const memories = await db.memory.findMany({
    where: {
      ...(onlyMemoryId ? { id: onlyMemoryId } : {}),
      deletedAt: null,
      OR: [
        // Org-visible memories: knowledge (PUBLIC/ORGANIZATION) + group
        // (GROUP). Per-user "holding" memories (userMemoryOfAgentId set —
        // e.g. the startChat no-App knowledge downgrade) are owner-only and
        // excluded here (caller re-admits its own via the identity clause).
        ...(orgIds.length > 0
          ? [
              // #653: `appId: null` — an APP-SCOPED knowledge/group memory is
              // NOT org-wide readable; it's reachable only through the App
              // surface (getAppMemoryAccess), like an app-class memory. Without
              // this, a knowledge memory provisioned for App A would leak to
              // every org member (codex review on #660).
              { organizationId: { in: orgIds }, class: { in: ['knowledge', 'group'] as any }, appId: null, userMemoryOfAgentId: null },
              // Cross-org subscriptions never reach owner-only personal/private.
              // `deletedAt: null` on the subscription so a REVOKED (soft-deleted)
              // subscription stops granting read. `appId: null` — app-scoped
              // memories are App-internal, never cross-org-subscription-readable.
              { class: { notIn: ['personal', 'private'] as any }, appId: null, userMemoryOfAgentId: null, subscriptions: { some: { organizationId: { in: orgIds }, deletedAt: null } } },
            ]
          : []),
        // PUBLIC memories — defensively excluding personal/private, per-user
        // holdings, and app-scoped (#653) so a mis-set visibility can't expose them.
        // #758: `ownerUserId: null` — spec 047's invariant is that a USER-owned
        // memory is strictly owner-only REGARDLESS of visibility, and this
        // clause is the one place that would otherwise admit a user-owned
        // knowledge/group memory set PUBLIC into every tenant's readable set.
        // The per-memory point reads have their own ownerUserId early-returns;
        // this is the list/search side (getAccessibleMemoryIds + MCP
        // getMemoryAccess both build on it).
        { visibility: 'PUBLIC' as any, class: { notIn: ['personal', 'private'] as any }, appId: null, userMemoryOfAgentId: null, ownerUserId: null },
      ],
    },
    select: { id: true },
  });
  return memories.map((m: { id: string }) => m.id);
}
