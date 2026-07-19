/**
 * cor:acl:080:02 — non-member organization discoverability.
 *
 * A caller who is NOT a member of an org may see/discover it iff the org is
 * ACTIVATED (`isVisible === true`, the cor:acl:080:01 precondition) AND exposes a
 * public footprint — it owns a PUBLIC, non-app-scoped memory or a PUBLIC agent
 * (cor:acl:080:03 `hasPublicResources`), OR it is `listedOnMarketplace`
 * (cor:acl:080:04). A hidden org (`isVisible !== true`) is never discoverable,
 * even with a public resource. Membership is independent and always grants
 * access; this bounds only NON-member reach. The subscription branch is deferred.
 *
 * NOTE: this predicate decides only whether the org ENTITY is discoverable. It
 * must never be used to widen access to the full `Organization` object (whose
 * nested field resolvers leak members/memories/credentials). Non-members get a
 * sanitized projection (`publicOrganization` → `PublicOrganization`) or flat
 * search hits, never the full type.
 */
import type { Prisma } from '../generated/prisma/index.js';

/**
 * A Prisma `where` fragment matching exactly the orgs a non-member may discover.
 * Compose it (e.g. OR it with the caller's member orgs) in a read surface.
 */
export function discoverableOrgWhere(): Prisma.OrganizationWhereInput {
  return {
    deletedAt: null,
    isVisible: true, // activation precondition (cor:acl:080:01)
    OR: [
      { listedOnMarketplace: true }, // cor:acl:080:04
      // A genuinely public-readable memory — mirrors the canonical predicate in
      // orgReadableMemory.ts (the `PUBLIC` clause): app-scoped (#653), per-user
      // holdings (`userMemoryOfAgentId` set), and personal/private are excluded
      // even if their visibility is mis-set to PUBLIC.
      { memories: { some: { deletedAt: null, visibility: 'PUBLIC', appId: null, userMemoryOfAgentId: null, class: { notIn: ['personal', 'private'] } } } },
      { agents: { some: { deletedAt: null, visibility: 'PUBLIC' } } },
    ],
  };
}
