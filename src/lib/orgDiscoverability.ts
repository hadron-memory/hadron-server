/**
 * cor:acl:080:02 — non-member organization discoverability.
 *
 * A caller who is NOT a member of an org may see/discover it iff the org exposes
 * a public footprint — it owns a PUBLIC, non-app-scoped memory or a PUBLIC agent
 * (cor:acl:080:03 `hasPublicResources`), OR it is `listedOnMarketplace`
 * (cor:acl:080:04). Membership is independent and always grants access; this
 * bounds only NON-member reach. The subscription branch is deferred.
 *
 * Spec 048: the `isVisible` activation precondition was dropped with the
 * auto-personal org — every remaining org is a real (activated) org, so
 * `listedOnMarketplace` + public resources are the sole discovery axes.
 *
 * NOTE: this predicate decides only whether the org ENTITY is discoverable. It
 * must never be used to widen access to the full `Organization` object (whose
 * nested field resolvers leak members/memories/credentials). Non-members get a
 * sanitized projection (`publicOrganization` → `PublicOrganization`) or flat
 * search hits, never the full type.
 */
import type { Prisma } from '../generated/prisma/index.js';

/**
 * A Prisma `where` fragment matching a genuinely PUBLIC-READABLE memory —
 * mirrors the canonical `PUBLIC` clause in `orgReadableMemory.ts`. App-scoped
 * memories (#653), per-user holdings (`userMemoryOfAgentId` set), and
 * personal/private are excluded even if their visibility is mis-set to PUBLIC.
 * The single source of truth for "which memories are publicly readable", reused
 * by the discoverability predicate and the sanitized public projections.
 */
export function publicReadableMemoryWhere(): Prisma.MemoryWhereInput {
  return {
    deletedAt: null,
    visibility: 'PUBLIC',
    appId: null,
    userMemoryOfAgentId: null,
    class: { notIn: ['personal', 'private'] },
  };
}

/**
 * A Prisma `where` fragment matching exactly the orgs a non-member may discover.
 * Compose it (e.g. OR it with the caller's member orgs) in a read surface.
 */
export function discoverableOrgWhere(): Prisma.OrganizationWhereInput {
  return {
    deletedAt: null,
    OR: [
      { listedOnMarketplace: true }, // cor:acl:080:04
      { memories: { some: publicReadableMemoryWhere() } }, // cor:acl:080:03
      { agents: { some: { deletedAt: null, visibility: 'PUBLIC' } } },
    ],
  };
}
