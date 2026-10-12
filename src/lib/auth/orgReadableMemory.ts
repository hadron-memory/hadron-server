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
 *   - a live Agent's matching system memory for its manager (#8995/#1808),
 *     through the shared batched manager predicate; ordinary membership is
 *     insufficient. Installed/licensed App reach remains in the App fold.
 *
 * **Read-only by nature.** These grants confer READ; write stays gated by
 * the App/agent-role path in each caller. `personal`/`private` memories are
 * NEVER returned here — callers gate those by strict ownership.
 */

import type { PrismaClient } from '../../generated/prisma/index.js';
import { getManagedSystemMemoryIds } from './managedSystemMemory.js';
import { LIVE_ORG_MEMBERSHIP } from './liveOrgMembership.js';

export async function getOrgReadableMemoryIds(
  db: PrismaClient,
  userId: string,
  // When set, scope the memory lookup to this single id (a single-memory
  // authorization check) so it stays an indexed point-read instead of
  // enumerating the whole org-readable set. The predicate is unchanged, just
  // narrowed — the result is `[onlyMemoryId]` or `[]`.
  onlyMemoryId?: string,
  // Admin impersonation: narrow the membership set to the session's ONE
  // shared org (see getMemberOrgIds — same pattern). The PUBLIC clause is
  // membership-independent and deliberately unchanged: public stays public.
  restrictToOrgId?: string,
): Promise<string[]> {
  // Defensive: Prisma silently DROPS an `undefined` where-filter, so a
  // `userId === undefined` slipping through (upstream widening, a bad call
  // site) would turn `where: { userId }` into "all memberships" — a
  // catastrophic cross-org read. Fail closed instead.
  if (!userId) return [];

  const memberships = await db.orgMember.findMany({
    where: {
      userId,
      ...LIVE_ORG_MEMBERSHIP,
      ...(restrictToOrgId ? { organizationId: restrictToOrgId } : {}),
    },
    select: { organizationId: true },
  });
  const orgIds = memberships.map((m: { organizationId: string }) => m.organizationId);

  const memories = await db.memory.findMany({
    where: {
      ...(onlyMemoryId ? { id: onlyMemoryId } : {}),
      deletedAt: null,
      OR: [
        // Org-visible memories: knowledge (PUBLIC/ORGANIZATION) stays
        // org-member-readable. Per-user "holding" memories
        // (userMemoryOfAgentId set — e.g. the startChat no-App knowledge
        // downgrade) are owner-only and excluded here (caller re-admits its
        // own via the identity clause).
        ...(orgIds.length > 0
          ? [
              // #653: `appId: null` — an APP-SCOPED knowledge memory is
              // NOT org-wide readable; it's reachable only through the App
              // surface (getAppMemoryAccess), like an app-class memory. Without
              // this, a knowledge memory provisioned for App A would leak to
              // every org member (codex review on #660).
              { organizationId: { in: orgIds }, class: 'knowledge' as any, appId: null, userMemoryOfAgentId: null },
              // Cross-org subscriptions never reach owner-only personal/private,
              // and never GROUP or SYSTEM (#1807): createMemorySubscription only admits
              // PUBLIC memories while group visibility is CHECK-forced to
              // GROUP, so a group-subscription row is API-invalid legacy state,
              // not a grant cor:acl:010:01's exclusive MemoryMember audience
              // should honor. `deletedAt: null` on the subscription so a
              // REVOKED (soft-deleted) subscription stops granting read.
              // `appId: null` — app-scoped memories are App-internal, never
              // cross-org-subscription-readable.
              { class: { notIn: ['personal', 'private', 'group', 'system'] as any }, appId: null, userMemoryOfAgentId: null, subscriptions: { some: { organizationId: { in: orgIds }, deletedAt: null } } },
            ]
          : []),
        // #1208 / cor:acl:010:01 — group memories are readable ONLY through
        // MemoryMember (reader/writer/owner), the symmetric counterpart of
        // MemoryShare. Split out of the org clause for two reasons at once:
        // org membership alone no longer reaches a group memory (it used to,
        // via `group` riding the knowledge clause), and a MemoryMember with
        // NO org role now DOES reach one (the join table's whole purpose —
        // the shape the org arm could never admit). The relation filter is
        // deliberately NOT nested under orgIds: a cross-org MemoryMember
        // reaches its group memory the same way a cross-org MemoryShare
        // reaches a shared one. MemoryMember has no deletedAt (removal is a
        // hard delete, FR-038), so `some: { userId }` is liveness. App-scoped
        // and per-user-holding group rows stay excluded (#653 parity).
        //
        // #3595: under `restrictToOrgId` (an impersonation session's ONE
        // shared org) the membership clause is BOUND to that org — the
        // target's MemoryMember rows in OTHER orgs must not ride the
        // impersonation session's readable set. Ordinary calls stay
        // unbounded: that is the cross-org reach described above.
        {
          class: 'group' as any,
          appId: null,
          userMemoryOfAgentId: null,
          ownerUserId: null,
          ...(restrictToOrgId ? { organizationId: restrictToOrgId } : {}),
          memberships: { some: { userId } },
        },
        // PUBLIC memories — defensively excluding personal/private, per-user
        // holdings, and app-scoped (#653) so a mis-set visibility can't expose them.
        // #758: `ownerUserId: null` — spec 047's invariant is that a USER-owned
        // memory is strictly owner-only REGARDLESS of visibility, and this
        // clause is the one place that would otherwise admit a user-owned
        // knowledge/group memory set PUBLIC into every tenant's readable set.
        // The per-memory point reads have their own ownerUserId early-returns;
        // this is the list/search side (getAccessibleMemoryIds + MCP
        // getMemoryAccess both build on it).
        { visibility: 'PUBLIC' as any, class: { notIn: ['personal', 'private', 'system'] as any }, appId: null, userMemoryOfAgentId: null, ownerUserId: null },
      ],
    },
    select: { id: true },
  });
  // #1808: a live Agent's manager reads its matching system definition.
  // Shared by GraphQL search/scope projection and MCP, never org-member-wide.
  const managed = await getManagedSystemMemoryIds(db, userId, onlyMemoryId, restrictToOrgId);
  return [...new Set([...memories.map((m: { id: string }) => m.id), ...managed])];
}
