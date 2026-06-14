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
 * in the portal but `h-list-memories` returned nothing until they installed an
 * Agent — the Micromentor onboarding incident (2026-06-13). Routing both
 * surfaces through this one query closes that divergence by construction.
 *
 * Scope (mirrors the portal's JWT-user OR-clause, **minus** the owner-only
 * personal/private + per-user "holding" clauses — those are identity-scoped,
 * not org-scoped, and each surface gates them on its own strict-ownership
 * path):
 *   - org-owned `knowledge` / `group` memories (`userMemoryOfAgentId IS NULL`)
 *   - cross-org subscribed non-personal memories
 *   - `PUBLIC` non-personal memories (always — even for a user with no orgs)
 *
 * **Read-only by nature.** Org membership confers READ; write stays gated by
 * the App/agent-role path in each caller. `personal`/`private` memories are
 * NEVER returned here — callers gate those by strict ownership.
 */

import type { PrismaClient } from '../../generated/prisma/index.js';

export async function getOrgReadableMemoryIds(
  db: PrismaClient,
  userId: string,
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
      deletedAt: null,
      OR: [
        // Org-visible memories: knowledge (PUBLIC/ORGANIZATION) + group
        // (GROUP). Per-user "holding" memories (userMemoryOfAgentId set —
        // e.g. the startChat no-App knowledge downgrade) are owner-only and
        // excluded here (caller re-admits its own via the identity clause).
        ...(orgIds.length > 0
          ? [
              { organizationId: { in: orgIds }, class: { in: ['knowledge', 'group'] as any }, userMemoryOfAgentId: null },
              // Cross-org subscriptions never reach owner-only personal/private.
              // `deletedAt: null` on the subscription so a REVOKED (soft-deleted)
              // subscription stops granting read.
              { class: { notIn: ['personal', 'private'] as any }, userMemoryOfAgentId: null, subscriptions: { some: { organizationId: { in: orgIds }, deletedAt: null } } },
            ]
          : []),
        // PUBLIC memories — defensively excluding personal/private and
        // per-user holdings so a mis-set visibility can't expose them.
        { visibility: 'PUBLIC' as any, class: { notIn: ['personal', 'private'] as any }, userMemoryOfAgentId: null },
      ],
    },
    select: { id: true },
  });
  return memories.map((m: { id: string }) => m.id);
}
