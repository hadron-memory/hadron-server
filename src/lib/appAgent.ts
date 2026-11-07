import { personalOrgAgentLicenseBatch } from './auth/personalOrgAgentInstall.js';
import { orgAgentLicenseUsable } from './auth/orgAgentInstallLicense.js';
import { listAppInstallations, resolveAppInstallation, type InstallationDb } from './appInstallations.js';
/**
 * AppAgent convenience and license helpers. Installation membership includes
 * one-hop imports through appInstallations.ts. "Primary" remains the oldest
 * physical install: an audit-order convenience, never a membership test.
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
    const candidates = agents.filter(agent =>
      !(agent.organizationId !== null && !liveOrgs.has(agent.organizationId)) &&
      (agent.ownerUserId === app.ownerUserId || activeSubscriptions.has(agent.id)));
    // #3655: one licence batch for the roster, not a check per Agent.
    const holds = await personalOrgAgentLicenseBatch(db, candidates.map(agent => ({ app, agentId: agent.id })));
    candidates.forEach((agent, i) => { if (holds[i]) licensed.add(agent.id); });
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
  const rows = await listAppInstallations(db, appIds, agentId);
  const apps = await db.app.findMany({where:{id:{in:rows.map(row=>row.appId)}},select:{id:true,organizationId:true,ownerUserId:true,deletedAt:true,uninstalledAt:true}});
  const byId = new Map(apps.map(app=>[app.id,app]));
  const installs = rows.flatMap(row=>{
    const app = byId.get(row.appId);
    return app ? [{...row,app}] : [];
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
  const personal: Array<{ appId: string; app: (typeof installs)[number]['app'] }> = [];
  for (const { appId, app } of installs) {
    if (app.deletedAt || app.uninstalledAt) continue;
    if (app.organizationId !== null) {
      if (!liveOrgs.has(app.organizationId)) continue;
      if (app.organizationId === agent.organizationId || activeOrgGrants.has(app.organizationId)) {
        licensed.add(appId);
      }
    } else if (app.ownerUserId !== null &&
      (app.ownerUserId === agent.ownerUserId || activeSubscriptions.has(app.ownerUserId))) {
      personal.push({ appId, app });
    }
  }
  // #3655: one licence batch across the personal Apps, not a check per App.
  const holds = await personalOrgAgentLicenseBatch(db, personal.map(({ app }) => ({ app, agentId: agent.id })));
  personal.forEach(({ appId }, i) => { if (holds[i]) licensed.add(appId); });
  return licensed;
}

/** Preserve these readers' physical-row membership contract. New DERIVED
 * entries additionally require the App holder's license, never the importer's.
 * Readers that already required licenses for ROW must retain that stricter gate. */
export async function listAppInstallationsWithDerivedLicense(db: Db, appId: string) {
  return listAppInstallations(db, appId);
}

/** A retained AppAgent pointer is authority only while its install is live. */
export async function isAgentInstalledAndLicensed(
  db: Db,
  appId: string,
  agentId: string,
): Promise<boolean> {
  const install = await resolveAppInstallation(db, appId, agentId);
  if (!install) return false;
  const app = await db.app.findUnique({where:{id:appId},select:{organizationId:true,ownerUserId:true,deletedAt:true,uninstalledAt:true}});
  if (!app || app.deletedAt || app.uninstalledAt) return false;
  if (!(await hasActiveAgentInstallLicense(db, app, install.agent))) return false;
  if (install.installationKind==='DERIVED' && app.organizationId && install.agent.organizationId===app.organizationId) {
    const grant=await db.agentOrgGrant.findUnique({where:{orgId_agentId:{orgId:app.organizationId,agentId}}});
    return orgAgentLicenseUsable(app.organizationId,install.agent.organizationId,grant);
  }
  return true;
}

/** Existing operation doors used ROW membership. Keep that contract; only
 * newly derived entries add the App-holder license check. Existing licensed
 * memory readers continue using isAgentInstalledAndLicensed directly. */
export async function isAgentInstalledForAppOperation(db:Db,appId:string,agentId:string):Promise<boolean> {
  const install=await resolveAppInstallation(db,appId,agentId);
  if(!install)return false;
  return install.installationKind==='ROW' || isAgentInstalledAndLicensed(db,appId,agentId);
}

/** Primary is an audit-order convenience over physical rows, not an installation-membership test. */
export async function getPrimaryAgentId(
  db: Pick<PrismaClient, 'appAgent'>,
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
  db: InstallationDb,
  appId: string,
  agentId: string,
): Promise<boolean> {
  return (await resolveAppInstallation(db, appId, agentId)) !== null;
}
