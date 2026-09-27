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

/** The same cross-org install license used by the App access fold. */
export async function hasActiveAgentInstallLicense(
  db: PrismaClient,
  appOrganizationId: string | null,
  agentOrganizationId: string | null,
  agentId: string,
): Promise<boolean> {
  // User-owned Apps have no org grant; same-org installs are implicit.
  if (appOrganizationId == null || appOrganizationId === agentOrganizationId) return true;
  const grant = await db.agentOrgGrant.findUnique({
    where: { orgId_agentId: { orgId: appOrganizationId, agentId } },
  });
  return grant != null && isLifecycleActive(grant);
}

/** A retained AppAgent pointer is authority only while its install is live. */
export async function isAgentInstalledAndLicensed(
  db: PrismaClient,
  appId: string,
  agentId: string,
): Promise<boolean> {
  const install = await db.appAgent.findUnique({
    where: { appId_agentId: { appId, agentId } },
    select: {
      app: { select: { organizationId: true, deletedAt: true, uninstalledAt: true } },
      agent: { select: { organizationId: true, deletedAt: true } },
    },
  });
  if (!install || install.app.deletedAt || install.app.uninstalledAt || install.agent.deletedAt) return false;
  return hasActiveAgentInstallLicense(
    db, install.app.organizationId, install.agent.organizationId, agentId,
  );
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
