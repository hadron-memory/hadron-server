/**
 * #5398 (hrn:node:hadronmemory.com:specs:cor:api:120:03, App-key line, Decided 2026-11-27, Holger "Add an own-memory read"):
 * a pure App key READS its own App's shared `app`-class memories, and so lists them.
 *
 * This module is the ONE predicate for that arm. Its callers are the three places the App's reach is assembled, the same
 * three that take #5321's `grantReadReachFor` (which replaced #5185's link reach):
 *  - `getPrincipalAppMemoryAccess` (src/mcp/access-control.ts): the MCP access map (`hadron_list_memories`), and through
 *    `appDerivedMemoryIds` the GraphQL accessible set behind `memory(ref:)`, `node(ref:)`, `findNodes`/search and
 *    `resolveUrn`;
 *  - `canReadMemoryRow` (the same file): the MCP point gate and its batch (`filterReadableMemoryIds`);
 *  - the App-key branch of GraphQL `memories` (src/api/graphql/schema/resolvers.query.memory.ts), so the list follows the read.
 *
 * Who holds it: a pure App key and nothing else. Any key of the App, with no key scope (Holger, 2026-11-27, "Any key of the
 * App"). Not a user (with or without the App selected), not a session-bound key (session isolation stays whole), not an
 * impersonation, not a run (the ruling names the key; a run keeps exactly what it had).
 *
 * Which memories: a live row with `class = 'app'` and `app_id` = the key's App, while that App is live and installed, and only
 * the App's SHARED memory:
 *  - not a per-user anonymous row (`userMemoryOfAgentId` set; Holger, 2026-11-27, "Out");
 *  - not a Worker's working memory (its audience is the holder and the App's managers, cor:acl:010:01);
 *  - owned by the App's own tenant: organization-owned (`ownerUserId` null) for an organization's App, or owned by the App's
 *    owner for a user-owned App. A user-owned row of somebody else that carries the App's id is never the App's (spec 047).
 * These are the team-space fold's exclusions (`getAppTeamSpaceAccess`), so for an organization's App this arm adds nothing to
 * the reads, only to the list; for a user-owned App it is the read that rule 2 of `admissibleFoldRows` (no strict-owner row
 * for a credential-only principal) withheld.
 *
 * READ only: every caller folds it as READ_ONLY, and no write gate consults it. It is neither an attachment nor a grant, so
 * #5321's removal of link reads does not touch it (and a read grant never names the App's own memories). An encrypted memory changes nothing: its content still needs a cached session key.
 */
import type { PrismaClient } from '../generated/prisma/index.js';
import { isPureAppKeyShape } from './appMemoryLinks.js';
import { appTenantRowFilter } from './auth/teamSpace.js';
import { isRunPrincipal } from './auth/runPrincipal.js';

type OwnMemoryPrincipal = {
  appId?: string | null; userId?: string | null; sessionId?: string | null; impersonation?: unknown;
  sessionBindingRefused?: boolean; clientId?: string | null;
};

/** The principal shape the own-memory arm applies to: a pure App key, never a run. */
export function readsOwnAppMemory(auth: OwnMemoryPrincipal): boolean {
  return isPureAppKeyShape(auth) && !isRunPrincipal(auth);
}

/** A cheap pre-check on a loaded row, so a point gate queries only for a row that could be in the arm. */
export function mayBeOwnAppMemory(
  auth: OwnMemoryPrincipal,
  memory: { class: string; appId: string | null; userMemoryOfAgentId: string | null },
): boolean {
  return readsOwnAppMemory(auth) && memory.class === 'app' && memory.appId === auth.appId && memory.userMemoryOfAgentId == null;
}

/**
 * The ids of the key's own App's shared app-class memories (or of `onlyMemoryIds` among them). Empty for any other principal,
 * and for an App that is deleted, uninstalled or whose organization is deleted.
 */
export async function ownAppMemoryIds(
  db: PrismaClient,
  auth: OwnMemoryPrincipal,
  onlyMemoryIds?: readonly string[],
): Promise<Set<string>> {
  if (!readsOwnAppMemory(auth) || (onlyMemoryIds && onlyMemoryIds.length === 0)) return new Set();
  const app = await db.app.findUnique({
    where: { id: auth.appId! },
    select: { deletedAt: true, uninstalledAt: true, ownerUserId: true, organizationId: true, organization: { select: { deletedAt: true } } },
  });
  if (!app || app.deletedAt || app.uninstalledAt || app.organization?.deletedAt) return new Set();
  const rows = await db.memory.findMany({
    where: {
      ...(onlyMemoryIds ? { id: { in: [...onlyMemoryIds] } } : {}),
      ...appTenantRowFilter({ id: auth.appId!, organizationId: app.organizationId }),
      class: 'app',
      deletedAt: null,
      userMemoryOfAgentId: null,
      workerOf: { none: {} },
      // The App's own tenant, both halves: owner (org-owned rows for an org App, the App owner's for a user-owned App) and
      // organization (an org App's; none for a user-owned App). Deliberately STRICTER than the shared comparison on the
      // organization half (main's behaviour kept): a user-owned App's own-memory arm lists only organization-less rows.
      ownerUserId: app.ownerUserId ?? null,
      organizationId: app.organizationId ?? null,
    },
    select: { id: true },
  });
  return new Set(rows.map((row) => row.id));
}
