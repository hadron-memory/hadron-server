/**
 * AppAgent helpers — spec 023-app-shape Phase 2b.
 *
 * After spec 023 dropped `App.agentId` in favor of the N:M `AppAgent`
 * join, code that previously read "the App's Agent" needs a new path.
 * Until US1's `installAgentIntoApp` ships the multi-Agent UI flows,
 * each App still has exactly one installed Agent in practice — the
 * defensive backfill in `20260517004132_023_drop_app_agent_id` made
 * sure of that for existing rows.
 *
 * These helpers wrap the lookup so callers don't reach into the join
 * table directly:
 *
 *   - `getPrimaryAgentId(db, appId)` — returns the first installed
 *     Agent's id, or null if the App has no Agents installed.
 *   - `getPrimaryAgent(db, appId, args?)` — returns the first
 *     installed Agent record with optional `include`.
 *
 * "Primary" is a v1 convenience: there is no business concept of a
 * "primary" Agent yet. Multi-Agent semantics (returning a list, or
 * resolving by URN from the request context) ship with the US1
 * resolvers in their own PR. Callers that need the full list should
 * use `db.appAgent.findMany({ where: { appId } })` directly.
 */

import type { PrismaClient, Prisma } from '../generated/prisma/index.js';
import { isLifecycleActive } from '@hadron-memory/access-control';

type Db = PrismaClient | Prisma.TransactionClient;

/** Legacy null uses the read default; unknown persisted strings grant nothing. */
export function isGrantedAgentMemoryRole(role: string | null | undefined): boolean {
  const value = role ?? 'read';
  return value === 'read' || value === 'read-write';
}

/** Resolve install licenses in bounded queries for a multi-Agent App fold. */
export async function activeAgentInstallLicenseIds(
  db: Db,
  app: { organizationId: string | null; ownerUserId: string | null },
  agents: Array<{ id: string; organizationId: string | null; ownerUserId: string | null }>,
): Promise<Set<string>> {
  const licensed = new Set<string>();
  if (agents.length === 0) return licensed;
  // Soft deletion leaves Apps, Agents, and AppAgent joins behind. A retained
  // same-org join cannot license an install after its owning org is deleted.
  const orgIds = [...new Set(
    [app.organizationId, ...agents.map((agent) => agent.organizationId)]
      .filter((id): id is string => id != null),
  )];
  const liveOrgRows = orgIds.length
    ? await db.organization.findMany({
        where: { id: { in: orgIds }, deletedAt: null }, select: { id: true },
      })
    : [];
  const liveOrgs = new Set(liveOrgRows.map((row) => row.id));
  if (app.organizationId !== null && !liveOrgs.has(app.organizationId)) return licensed;
  const now = new Date();

  if (app.organizationId == null) {
    if (app.ownerUserId == null) return licensed;
    // A personal App needs no subscription to its owner's own Agent. Every
    // other Agent is licensed by the App owner's live AgentSubscription.
    const foreignIds = agents
      .filter((agent) => agent.ownerUserId !== app.ownerUserId)
      .map((agent) => agent.id);
    const subscriptions = foreignIds.length
      ? await db.agentSubscription.findMany({
          where: { userId: app.ownerUserId, agentId: { in: foreignIds } },
        })
      : [];
    const activeSubscriptions = new Set(
      subscriptions.filter((row) => isLifecycleActive(row, now)).map((row) => row.agentId),
    );
    for (const agent of agents) {
      if (agent.organizationId !== null && !liveOrgs.has(agent.organizationId)) continue;
      if (agent.ownerUserId === app.ownerUserId || activeSubscriptions.has(agent.id)) {
        licensed.add(agent.id);
      }
    }
    return licensed;
  }
  // Same-org installations are implicit; foreign Agents need an org grant.
  const foreignIds = agents
    .filter((agent) => agent.organizationId !== app.organizationId)
    .map((agent) => agent.id);
  const grants = foreignIds.length
    ? await db.agentOrgGrant.findMany({
        where: { orgId: app.organizationId, agentId: { in: foreignIds } },
      })
    : [];
  const activeGrants = new Set(
    grants.filter((row) => isLifecycleActive(row, now)).map((row) => row.agentId),
  );
  for (const agent of agents) {
    if (agent.organizationId !== null && !liveOrgs.has(agent.organizationId)) continue;
    if (agent.organizationId === app.organizationId || activeGrants.has(agent.id)) {
      licensed.add(agent.id);
    }
  }
  return licensed;
}

/** The same cross-org install license used by the App access fold. */
export async function hasActiveAgentInstallLicense(
  db: Db,
  app: { organizationId: string | null; ownerUserId: string | null },
  agent: { id: string; organizationId: string | null; ownerUserId: string | null },
): Promise<boolean> {
  return (await activeAgentInstallLicenseIds(db, app, [agent])).has(agent.id);
}

/** Resolve one Agent's live licenses across candidate Apps in bounded queries. */
export async function activeAppInstallLicenseIdsForAgent(
  db: PrismaClient,
  agentId: string,
  appIds: string[],
): Promise<Set<string>> {
  const licensed = new Set<string>();
  if (appIds.length === 0) return licensed;
  const installs = await db.appAgent.findMany({
    where: { agentId, appId: { in: appIds } },
    select: {
      appId: true,
      app: { select: { organizationId: true, ownerUserId: true, deletedAt: true, uninstalledAt: true } },
      agent: { select: { organizationId: true, ownerUserId: true, deletedAt: true } },
    },
  });
  if (installs.length === 0 || installs[0]!.agent.deletedAt !== null) return licensed;
  const agent = installs[0]!.agent;
  const orgIds = [...new Set(
    [agent.organizationId, ...installs.map((row) => row.app.organizationId)]
      .filter((id): id is string => id !== null),
  )];
  const orgRows = orgIds.length
    ? await db.organization.findMany({
        where: { id: { in: orgIds }, deletedAt: null }, select: { id: true },
      })
    : [];
  const liveOrgs = new Set(orgRows.map((row) => row.id));
  if (agent.organizationId !== null && !liveOrgs.has(agent.organizationId)) return licensed;

  const foreignOrgIds = [...new Set(installs
    .filter((row) => row.app.organizationId !== null && row.app.organizationId !== agent.organizationId)
    .map((row) => row.app.organizationId!))];
  const foreignOwnerIds = [...new Set(installs
    .filter((row) => row.app.organizationId === null && row.app.ownerUserId !== agent.ownerUserId)
    .map((row) => row.app.ownerUserId)
    .filter((id): id is string => id !== null))];
  const [grants, subscriptions] = await Promise.all([
    foreignOrgIds.length
      ? db.agentOrgGrant.findMany({ where: { agentId, orgId: { in: foreignOrgIds } } })
      : [],
    foreignOwnerIds.length
      ? db.agentSubscription.findMany({ where: { agentId, userId: { in: foreignOwnerIds } } })
      : [],
  ]);
  const now = new Date();
  const activeOrgGrants = new Set(
    grants.filter((row) => isLifecycleActive(row, now)).map((row) => row.orgId),
  );
  const activeSubscriptions = new Set(
    subscriptions.filter((row) => isLifecycleActive(row, now)).map((row) => row.userId),
  );
  for (const { appId, app } of installs) {
    if (app.deletedAt || app.uninstalledAt) continue;
    if (app.organizationId !== null) {
      if (!liveOrgs.has(app.organizationId)) continue;
      if (app.organizationId === agent.organizationId || activeOrgGrants.has(app.organizationId)) {
        licensed.add(appId);
      }
    } else if (app.ownerUserId !== null &&
      (app.ownerUserId === agent.ownerUserId || activeSubscriptions.has(app.ownerUserId))) {
      licensed.add(appId);
    }
  }
  return licensed;
}

/** A retained AppAgent pointer is authority only while its install is live. */
export async function isAgentInstalledAndLicensed(
  db: Db,
  appId: string,
  agentId: string,
): Promise<boolean> {
  const install = await db.appAgent.findUnique({
    where: { appId_agentId: { appId, agentId } },
    select: {
      app: { select: { organizationId: true, ownerUserId: true, deletedAt: true, uninstalledAt: true } },
      agent: { select: { organizationId: true, ownerUserId: true, deletedAt: true } },
    },
  });
  if (!install || install.app.deletedAt || install.app.uninstalledAt || install.agent.deletedAt) return false;
  return hasActiveAgentInstallLicense(db, install.app, { id: agentId, ...install.agent });
}

export async function getPrimaryAgentId(
  db: PrismaClient,
  appId: string,
): Promise<string | null> {
  const row = await db.appAgent.findFirst({
    where: { appId },
    orderBy: { createdAt: 'asc' },
    select: { agentId: true },
  });
  return row?.agentId ?? null;
}

export async function getPrimaryAgent<
  TInclude extends Prisma.AgentInclude | undefined = undefined,
>(
  db: PrismaClient,
  appId: string,
  args?: { include?: TInclude },
): Promise<Prisma.AgentGetPayload<{ include: TInclude }> | null> {
  const agentId = await getPrimaryAgentId(db, appId);
  if (agentId === null) return null;
  // Cast through unknown because the conditional include shape isn't
  // narrowed by Prisma's overloads when `include` is optional/undefined.
  return (await db.agent.findUnique({
    where: { id: agentId },
    include: args?.include,
  })) as Prisma.AgentGetPayload<{ include: TInclude }> | null;
}

/**
 * Check whether a specific Agent is installed in an App. Fast PK lookup.
 */
export async function isAgentInstalled(
  db: PrismaClient,
  appId: string,
  agentId: string,
): Promise<boolean> {
  const row = await db.appAgent.findUnique({
    where: { appId_agentId: { appId, agentId } },
    select: { appId: true },
  });
  return row !== null;
}
