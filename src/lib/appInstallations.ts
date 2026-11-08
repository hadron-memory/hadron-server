import { orgAgentLicenseUsable } from './auth/orgAgentInstallLicense.js';
import { LINK_CAP_MEMORY_SELECT } from './auth/agentMemoryLinkCap.js';
/** #2168 / cor:dmo:050:06,:11: the single source of App installation membership.
 * A physical row wins. Direct imports of physically installed, live Agents count
 * only in a live org App. Never recurse, and never borrow the importer's grant:
 * callers still apply their existing App-holder license and access gates.
 */
import type {
  Prisma,
  PrismaClient,
  AppAgent,
} from '../generated/prisma/index.js';
export type UnfilteredInstallationDb = Pick<PrismaClient, 'app' | 'appAgent' | 'agentImport'>;
export type InstallationDb = UnfilteredInstallationDb & Pick<PrismaClient, 'organization' | 'agentOrgGrant'>;
const INSTALL_AGENT_SELECT = {
  id: true,
  name: true,
  urn: true,
  legacyUrn: true,
  personaRole: true,
  deletedAt: true,
  organizationId: true,
  ownerUserId: true,
  systemMemoryId: true,
  visibility: true,
  installationPolicy: true,
  registerDefaults: true,
  bootPromptNodeId: true,
  bootPromptUrn: true,
} as const;
type InstallationAgent = Prisma.AgentGetPayload<{
  select: typeof INSTALL_AGENT_SELECT;
}>;
export type AppInstallation = AppAgent & {
  installationKind: 'ROW' | 'DERIVED';
  importerAgentId: string | null;
  agent: InstallationAgent;
};
/** Read one App page and its physical/import witnesses in one Prisma operation.
 * Optional Agent fields are selected only by callers whose contract needs them;
 * all installation membership still folds through the same function below.
 */
export async function loadUnfilteredAppInstallationPage(
  db: UnfilteredInstallationDb,
  appId: string | readonly string[],
  includeMemoryItems = false,
  agentId?: string,
  witnesses?: {
    rows: string[];
    imports: Array<{ parent_agent_id: string; imported_agent_id: string }>;
  },
) {
  const ids = typeof appId === 'string' ? [appId] : [...appId];
  const memoryItems = {
    where: { deletedAt: null, memory: { deletedAt: null } },
    select: {
      memoryId: true, role: true,
      memory: { select: { ...LINK_CAP_MEMORY_SELECT, workerOf: { select: { id: true } } } },
    },
  } as const;
  const agentSelect = { ...INSTALL_AGENT_SELECT, memoryItems: includeMemoryItems ? memoryItems : false } as const;
  const apps = await db.app.findMany({
    where: { id: { in: ids } },
    select: {
      id: true, organizationId: true, ownerUserId: true,
      deletedAt: true, uninstalledAt: true,
      organization: { select: { deletedAt: true } },
      appAgents: {
        orderBy: [{ createdAt: 'asc' }, { agentId: 'asc' }],
        include: { agent: { select: {
          ...agentSelect,
          imports: {
            where: {
              ...(agentId ? { importedAgentId: agentId } : {}),
              ...(witnesses ? { OR: witnesses.imports.map(edge => ({
                parentAgentId: edge.parent_agent_id,
                importedAgentId: edge.imported_agent_id,
              })) } : {}),
              importedAgent: { deletedAt: null },
            },
            orderBy: [{ createdAt: 'asc' }, { parentAgentId: 'asc' }, { importedAgentId: 'asc' }],
            include: { importedAgent: { select: agentSelect } },
          },
        } } },
      },
    },
  });
  // Prisma's conditional relation projection loses its nested result type.
  // The flag either omits the relation or selects exactly memoryItems above.
  type AgentRow = InstallationAgent & {
    memoryItems?: Prisma.AgentGetPayload<{ select: { memoryItems: typeof memoryItems } }>['memoryItems'];
  };
  const installations: Array<AppInstallation & { agent: AgentRow }> = [];
  for (const app of apps) {
    const physical = app.appAgents.filter(row =>
      !row.agent.deletedAt && (!agentId || row.agentId === agentId) && (!witnesses || witnesses.rows.includes(row.agentId)));
    installations.push(...physical.map(row => ({
      ...row, agent: row.agent as unknown as AgentRow, installationKind: 'ROW' as const, importerAgentId: null,
    })));
    if (!app.organizationId || app.organization?.deletedAt || app.deletedAt || app.uninstalledAt) continue;
    const seen = new Set(physical.map(row => row.agentId));
    const derived = new Map<string, AppInstallation & { agent: AgentRow }>();
    // Sort across all physical importers; tie-breaking remains deterministic.
    const edges = app.appAgents.filter(parent => !parent.agent.deletedAt)
      .flatMap(parent => parent.agent.imports.map(edge => ({ parent, edge })))
      .sort((a, b) => a.edge.createdAt.getTime() - b.edge.createdAt.getTime()
        || a.edge.parentAgentId.localeCompare(b.edge.parentAgentId)
        || a.edge.importedAgentId.localeCompare(b.edge.importedAgentId));
    for (const { parent, edge } of edges) {
      if (seen.has(edge.importedAgentId)) continue;
      const at = Math.max(edge.createdAt.getTime(), parent.createdAt.getTime());
      const best = derived.get(edge.importedAgentId);
      if (best && best.createdAt.getTime() <= at) continue;
      derived.set(edge.importedAgentId, {
        appId: app.id, agentId: edge.importedAgentId, createdAt: new Date(at),
        createdBy: null, updatedAt: null, updatedBy: null,
        bootPromptNodeId: null, bootPromptUrn: null,
        installationKind: 'DERIVED', importerAgentId: edge.parentAgentId,
        agent: edge.importedAgent as unknown as AgentRow,
      });
    }
    installations.push(...derived.values());
  }
  return { apps, installations };
}
/** Also accepts an App page; never one query per row or per chain depth. */
export async function listUnfilteredAppInstallations(
  db: UnfilteredInstallationDb,
  appId: string | readonly string[],
  agentId?: string,
  witnesses?: { rows: string[]; imports: Array<{ parent_agent_id: string; imported_agent_id: string }> },
): Promise<AppInstallation[]> {
  return (await loadUnfilteredAppInstallationPage(db, appId, false, agentId, witnesses)).installations;
}
/** Ordinary installation readers preserve ROW membership but admit DERIVED
 * entries only under the App holder's usable license. Raw witness/pointer reads
 * must opt in to the explicitly unfiltered helpers below. No recursive fold. */
export async function loadAppInstallationPage(
  db: InstallationDb,
  appId: string | readonly string[],
  includeMemoryItems = false,
  agentId?: string,
) {
  const page = await loadUnfilteredAppInstallationPage(db, appId, includeMemoryItems, agentId);
  const derived = page.installations.filter(row => row.installationKind === 'DERIVED');
  if (!derived.length) return page;
  const apps = new Map(page.apps.map(app => [app.id, app]));
  const pairs = new Map<string, {orgId:string;agentId:string}>();
  const orgIds = new Set<string>();
  for (const row of derived) {
    const app = apps.get(row.appId);
    if (app?.organizationId) {
      pairs.set(`${app.organizationId}:${row.agentId}`, {orgId:app.organizationId,agentId:row.agentId});
      orgIds.add(app.organizationId);
    }
    if (row.agent.organizationId) orgIds.add(row.agent.organizationId);
  }
  const [orgs, grants] = await Promise.all([
    db.organization.findMany({where:{id:{in:[...orgIds]},deletedAt:null},select:{id:true}}),
    pairs.size ? db.agentOrgGrant.findMany({where:{OR:[...pairs.values()]}}) : [],
  ]);
  const liveOrgs = new Set(orgs.map(org => org.id));
  const byPair = new Map(grants.map(grant => [`${grant.orgId}:${grant.agentId}`,grant]));
  const now = new Date();
  const installations = page.installations.filter(row => {
    if (row.installationKind === 'ROW') return true;
    const app = apps.get(row.appId);
    return !!app?.organizationId && !app.deletedAt && !app.uninstalledAt && liveOrgs.has(app.organizationId)
      && (!row.agent.organizationId || liveOrgs.has(row.agent.organizationId))
      && orgAgentLicenseUsable(app.organizationId,row.agent.organizationId,
        byPair.get(`${app.organizationId}:${row.agentId}`) ?? null,now);
  });
  return {...page, installations};
}

export async function listAppInstallations(db:InstallationDb,appId:string|readonly string[],agentId?:string):Promise<AppInstallation[]> {
  return (await loadAppInstallationPage(db,appId,false,agentId)).installations;
}

export async function resolveAppInstallation(db:InstallationDb,appId:string,agentId:string):Promise<AppInstallation|null> {
  const row = await db.appAgent.findUnique({where:{appId_agentId:{appId,agentId}},include:{agent:{select:INSTALL_AGENT_SELECT}}});
  if (row && !row.agent.deletedAt) return {...row,installationKind:'ROW',importerAgentId:null};
  return (await listAppInstallations(db,appId,agentId))[0] ?? null;
}

/** Candidate App filter for reverse lookups. The source resolver still judges
 * liveness and returns the installation kind; this only bounds candidate Apps. */
export function appInstallationWhere(agentId: string): Prisma.AppWhereInput {
  const membership: Prisma.AppWhereInput = {
    OR: [
      { appAgents: { some: { agentId } } },
      {
        organizationId: { not: null },
        deletedAt: null,
        uninstalledAt: null,
        organization: { deletedAt: null },
        appAgents: {
          some: {
            agent: {
              deletedAt: null,
              imports: { some: { importedAgentId: agentId } },
            },
          },
        },
      },
    ],
  };
  // Do not replace a caller's tenant/owner OR when this filter is spread.
  return { AND: [membership] };
}
export async function resolveUnfilteredAppInstallation(
  db: UnfilteredInstallationDb,
  appId: string,
  agentId: string,
): Promise<AppInstallation | null> {
  // Preserve the common physical-install PK read; derivation is the fallback,
  // never an extra roster scan on every existing installed-agent check.
  const row = await db.appAgent.findUnique({
    where: { appId_agentId: { appId, agentId } },
    include: { agent: { select: INSTALL_AGENT_SELECT } },
  });
  if (row && !row.agent.deletedAt)
    return { ...row, installationKind: 'ROW', importerAgentId: null };
  return (await listUnfilteredAppInstallations(db, appId, agentId))[0] ?? null;
}
/** Fence the deciding witness, not a preflight snapshot. Deletion of either a
 * join or an import conflicts with these row locks. Re-read after waits, under
 * READ COMMITTED, so a remover that won cannot leave stale derived authority.
 * Call before content/Worker writes, with the caller's authority anchors held.
 */
export async function lockAppInstallations(
  tx: Prisma.TransactionClient,
  appId: string,
  agentIds?: string[],
): Promise<AppInstallation[]> {
  await tx.$queryRaw`SELECT id FROM apps WHERE id=${appId} FOR SHARE`;
  const targets = agentIds ?? [];
  const rows = await tx.$queryRaw<Array<{ agent_id: string }>>`
    SELECT aa.agent_id FROM app_agents aa WHERE aa.app_id=${appId}
      AND (${agentIds === undefined} OR aa.agent_id=ANY(${targets}::text[]) OR EXISTS (
        SELECT 1 FROM agent_imports ai WHERE ai.parent_agent_id=aa.agent_id
          AND ai.imported_agent_id=ANY(${targets}::text[])))
    ORDER BY aa.agent_id FOR SHARE OF aa`;
  const rowIds = rows.map((row) => row.agent_id);
  const edges = await tx.$queryRaw<
    Array<{ parent_agent_id: string; imported_agent_id: string }>
  >`
    SELECT parent_agent_id,imported_agent_id FROM agent_imports
    WHERE parent_agent_id=ANY(${rowIds}::text[])
      AND (${agentIds === undefined} OR imported_agent_id=ANY(${targets}::text[]))
    ORDER BY parent_agent_id,imported_agent_id FOR SHARE`;
  const ids = [
    ...new Set([...rowIds, ...edges.map((edge) => edge.imported_agent_id)]),
  ].sort();
  if (!ids.length) return [];
  await tx.$queryRaw`SELECT id FROM agents WHERE id = ANY(${ids}) ORDER BY id FOR SHARE`;
  // No witness introduced after the fences can contribute to the decision.
  // Re-read only these exact held rows/edges after all waits and lifecycle locks.
  const installs = await listUnfilteredAppInstallations(tx, appId, undefined, {
    rows: rowIds,
    imports: edges,
  });
  return agentIds
    ? installs.filter((row) => agentIds.includes(row.agentId))
    : installs;
}
export async function lockAppInstallation(
  tx: Prisma.TransactionClient,
  appId: string,
  agentId: string,
): Promise<AppInstallation | null> {
  return (await lockAppInstallations(tx, appId, [agentId]))[0] ?? null;
}

/** Physical rows retain reinstall/reset semantics. Derived customisation lives
 * independently of its target memory, so hard-deleting a target cannot erase
 * the deciding pointer and silently fall through to the Agent's prompt. */
export async function readInstallBootPrompt(
  db: UnfilteredInstallationDb & Pick<PrismaClient, 'appAgentCustomization'>,
  appId: string,
  agentId: string,
): Promise<{
  bootPromptNodeId: string | null;
  bootPromptUrn: string | null;
} | null> {
  // A pointer read is about the stored deciding pointer, not a second
  // membership/license gate. Retain the existing physical pointer semantics.
  const physical = await db.appAgent.findUnique({
    where: { appId_agentId: { appId, agentId } },
    select: { bootPromptNodeId: true, bootPromptUrn: true },
  });
  if (physical) return physical;
  const install = await resolveUnfilteredAppInstallation(db, appId, agentId);
  if (!install) return null;
  if (install.installationKind === 'ROW') return install;
  return (
    (await db.appAgentCustomization.findUnique({
      where: { appId_agentId: { appId, agentId } },
      select: { bootPromptNodeId: true, bootPromptUrn: true },
    })) ?? { bootPromptNodeId: null, bootPromptUrn: null }
  );
}

/** Agent-side candidate filter, for relational scopes and invitation queries.
 * No inherited/derived parent can satisfy this: the witness is a physical row. */
export function agentInstallationWhere(appId: string): Prisma.AgentWhereInput {
  const liveApp = { id: appId, deletedAt: null, uninstalledAt: null };
  return {
    deletedAt: null,
    OR: [
      { appAgents: { some: { appId } } },
      {
        importedBy: {
          some: {
            parentAgent: {
              deletedAt: null,
              appAgents: {
                some: {
                  appId,
                  app: {
                    ...liveApp,
                    organizationId: { not: null },
                    organization: { deletedAt: null },
                  },
                },
              },
            },
          },
        },
      },
    ],
  };
}

/** A row-less prompt write and conversion to an explicit install share this
 * fence. Acquire before pointer/compiled-node writes so the conversion cannot
 * copy a stale pointer over a concurrent set/clear. Not an installation lock. */
export async function lockAppAgentCustomization(
  tx: Prisma.TransactionClient,
  appId: string,
  agentId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`app-agent-customization:${appId}:${agentId}`}, 0))`;
}
