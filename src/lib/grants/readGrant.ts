/**
 * #5321 (hrn:node:hadronmemory.com:specs:cor:acl:140:02 `memory.read`, its two forms; cor:agt:010:01; cor:acl:010:01 and
 * :04; cor:dmo:060:22): the ONE judge of what an App that acts with no person behind it reads outside its own memories through a
 * grant. Both read surfaces call it, MCP (`getPrincipalAppMemoryAccess`, `canReadMemoryRow`) and GraphQL (`getAccessibleMemoryIds`,
 * the record gate, the memories listing), so neither re-derives the rule.
 *
 * Who it applies to: a PURE App key or a userless run of the App ({@link isPureAppKeyShape}): no user (with or without the App
 * selected), no impersonation, no session-bound key and no run that carries a user id. A person gains nothing from a grant the App
 * holds (the grant never widens what a person reads, cor:acl:140:02 "What it reaches").
 *
 *  - `memory.read` naming memories (form (b); holder: the grant's own App) reaches the App's userless runs, and a pure key ONLY
 *    while that key holds the `grant:read` scope (Holger, 2026-11-27: "Only keys whose scopes say so").
 *  - `memory.read` naming the App's own organization (form (a), Holger 2026-11-27: "The grant may be for all org memories") reaches
 *    the App's userless runs only, never a key (cor:acl:010:04: a key never reads the organization's ORGANIZATION knowledge), and
 *    opens only knowledge memories of ORGANIZATION visibility owned by that organization: never another organization's, a group,
 *    personal, private or App-scoped one. There is no `knowledge.read` action (Holger: "is to unspecific").
 *
 * Judged at EVERY read, with no cache: the grant allows by the one definition (`grantLiveSql`: signed, not revoked, departed,
 * expired or spent, started, its App not deleted); the App is live and installed; the target still qualifies
 * ({@link memoryReadTargetRefusal}); and the GIVER (`issuer_user_id`) still reads the memory in their own right (R4, Holger,
 * 2026-11-27: "Judged at every read"). A giver whose account is erased (`issuer_user_id` set NULL, or the user soft-deleted)
 * leaves the grant active (cor:acl:140:08). Read only: nothing here admits a write.
 */
import type { PrismaClient } from '../../generated/prisma/index.js';
import { isRunPrincipal } from '../auth/runPrincipal.js';
import { isPureAppKeyShape, readsInOwnRight } from '../appMemoryLinks.js';
import { isAgentInstalled } from '../appAgent.js';
import { grantLiveSql } from './live.js';
import { keyHoldsScope } from '../appKeyScopes/scopes.js';
import { LIVE_ORG_MEMBERSHIP } from '../auth/liveOrgMembership.js';

export const MEMORY_READ_ACTION = 'memory.read';
/** The App key scope a pure key needs before a `memory.read` grant held by its App reaches it. */
export const GRANT_READ_SCOPE = 'grant:read';

/** The memory columns {@link memoryReadTargetRefusal} reads. */
export const READ_GRANT_TARGET_SELECT = {
  id: true, class: true, appId: true, organizationId: true, ownerUserId: true, userId: true, deletedAt: true,
  isEncrypted: true, isInstallMemory: true, userMemoryOfAgentId: true, workerOf: { select: { id: true } },
} as const;

export interface ReadGrantTarget {
  id: string; class: string; appId: string | null; organizationId: string | null; ownerUserId: string | null; userId: string | null;
  deletedAt: Date | null; isEncrypted: boolean; isInstallMemory: boolean; userMemoryOfAgentId: string | null; workerOf: Array<{ id: string }>;
}

export type ReadGrantTargetRefusal =
  | 'deleted' | 'strict-owner' | 'encrypted' | 'install-memory' | 'system-not-installed' | 'worker-memory' | 'session-memory'
  | 'other-app-team-space' | 'own-app';

type Db = Pick<PrismaClient, 'agent' | 'appAgent' | 'app' | 'agentImport' | 'organization' | 'agentOrgGrant'>;

/**
 * May a `memory.read` grant held by App `appId` name this memory at all? Returns the refusal, or null. Judged when the grant is
 * created and again at every read, so a memory that stops qualifying stops being read. Every branch can only refuse.
 *  - personal / private: never (cor:agt:010:01, "No user attached ⇒ no personal reach"; the #2883 target rule).
 *  - encrypted: never (a userless run and a key hold no session key); an install memory never (it is not an Agent's own).
 *  - system: only the system memory of a live Agent installed in this App now (the #2883 rule).
 *  - app: a Worker's or a session memory never; another App's team space never (the #2883 narrowing); this App's own memories
 *    `own-app` (it reads them already, so a grant would name nothing new).
 *  - group and knowledge: admitted; the giver's own read (judged at every use) is what bounds them.
 */
export async function memoryReadTargetRefusal(db: Db, appId: string, memory: ReadGrantTarget): Promise<ReadGrantTargetRefusal | null> {
  if (memory.deletedAt) return 'deleted';
  if (memory.class === 'personal' || memory.class === 'private') return 'strict-owner';
  if (memory.isEncrypted) return 'encrypted';
  if (memory.isInstallMemory) return 'install-memory';
  if (memory.class === 'system') {
    const agents = await db.agent.findMany({
      where: { systemMemoryId: memory.id, deletedAt: null, organizationId: memory.organizationId, ownerUserId: memory.ownerUserId },
      select: { id: true },
    });
    for (const agent of agents) if (await isAgentInstalled(db as never, appId, agent.id)) return null;
    return 'system-not-installed';
  }
  if (memory.class === 'app') {
    if (memory.workerOf.length > 0) return 'worker-memory';
    if (memory.userMemoryOfAgentId !== null) return 'session-memory';
    return memory.appId === appId ? 'own-app' : 'other-app-team-space';
  }
  if (memory.appId === appId) return 'own-app';
  return null;
}

interface ReadGrantRow { action_values: unknown; issuer_user_id: string | null }

/** The App, live and installed, with its organization; null otherwise. */
async function liveApp(db: PrismaClient, appId: string): Promise<{ id: string; organizationId: string | null } | null> {
  const app = await db.app.findFirst({
    where: { id: appId, deletedAt: null, uninstalledAt: null },
    select: { id: true, organizationId: true, organization: { select: { deletedAt: true } } },
  });
  if (!app || app.organization?.deletedAt) return null;
  return { id: app.id, organizationId: app.organizationId };
}

/**
 * The giver still counts: erased (no row, or soft-deleted) counts (cor:acl:140:08); otherwise `reads` decides. Each giver is
 * looked up once per call.
 */
async function giverCounts(
  db: PrismaClient,
  cache: Map<string, { roles: unknown } | null>,
  issuerUserId: string | null,
  reads: (giver: { id: string; roles: unknown }) => Promise<boolean>,
): Promise<boolean> {
  if (issuerUserId === null) return true;
  if (!cache.has(issuerUserId)) {
    const user = await db.user.findUnique({ where: { id: issuerUserId }, select: { roles: true, deletedAt: true } });
    cache.set(issuerUserId, user && !user.deletedAt ? { roles: user.roles } : null);
  }
  const giver = cache.get(issuerUserId);
  if (giver === null || giver === undefined) return true;
  return reads({ id: issuerUserId, roles: giver.roles });
}

/**
 * The ids App `appId` reads through its grants right now (or among `onlyMemoryIds`). `run`: the principal is a userless run
 * (it reaches the organization form too); otherwise a pure key, which reaches the named-memory form only (its scope is checked by
 * the caller, {@link grantReadReachFor}).
 */
export async function appReadGrantReach(
  db: PrismaClient,
  appId: string,
  opts: { run: boolean; onlyMemoryIds?: readonly string[] },
): Promise<Set<string>> {
  const out = new Set<string>();
  if (opts.onlyMemoryIds && opts.onlyMemoryIds.length === 0) return out;
  // Grants first: most Apps hold none, and this runs for every read of a pure key or a userless run.
  const rows = await db.$queryRaw<ReadGrantRow[]>`
    SELECT g.action_values, g.issuer_user_id FROM grants g
    WHERE g.app_id = ${appId} AND g.grantee_app_id = ${appId} AND g.user_id IS NULL AND g.agent_id IS NULL AND g.worker_id IS NULL
      AND g.action = ${MEMORY_READ_ACTION} AND ${grantLiveSql('g')}`;
  if (rows.length === 0) return out;
  const app = await liveApp(db, appId);
  if (!app) return out;
  const givers = new Map<string, { roles: unknown } | null>();
  const only = opts.onlyMemoryIds ? new Set(opts.onlyMemoryIds) : null;

  // Split the rows by form. (a): the value is the App's own organization id, a single string. (b): one or more memory ids.
  const orgIssuers: Array<string | null> = [];
  const byMemory = new Map<string, Array<string | null>>();
  for (const r of rows) {
    const v = (r.action_values as { memory?: unknown } | null)?.memory;
    if (typeof v === 'string' && app.organizationId !== null && v === app.organizationId) { orgIssuers.push(r.issuer_user_id); continue; }
    for (const memoryId of Array.isArray(v) ? v : [v]) {
      if (typeof memoryId !== 'string' || (only && !only.has(memoryId))) continue;
      byMemory.set(memoryId, [...(byMemory.get(memoryId) ?? []), r.issuer_user_id]);
    }
  }

  // (b): each named memory, the target judged now, the giver's own read judged now.
  if (byMemory.size > 0) {
    const memories = await db.memory.findMany({ where: { id: { in: [...byMemory.keys()] } }, select: READ_GRANT_TARGET_SELECT });
    for (const memory of memories) {
      if ((await memoryReadTargetRefusal(db, appId, memory)) !== null) continue;
      for (const issuer of byMemory.get(memory.id) ?? []) {
        if (await giverCounts(db, givers, issuer, (g) => readsInOwnRight(db, g.id, g.roles, memory.id))) { out.add(memory.id); break; }
      }
    }
  }

  // (a), runs only: the App's OWN organization's ORGANIZATION knowledge, while the giver is still a live member of it.
  if (opts.run && app.organizationId && orgIssuers.length > 0) {
    let open = false;
    for (const issuer of orgIssuers) {
      const member = (giver: { id: string }) => db.orgMember.findFirst({
        where: { organizationId: app.organizationId!, userId: giver.id, ...LIVE_ORG_MEMBERSHIP }, select: { userId: true },
      }).then((m) => m !== null);
      if (await giverCounts(db, givers, issuer, member)) { open = true; break; }
    }
    if (open) {
      const knowledge = await db.memory.findMany({
        where: {
          organizationId: app.organizationId, class: 'knowledge', visibility: 'ORGANIZATION', appId: null, userMemoryOfAgentId: null,
          deletedAt: null, isEncrypted: false, ...(only ? { id: { in: [...only] } } : {}),
        },
        select: { id: true },
      });
      for (const k of knowledge) out.add(k.id);
    }
  }
  return out;
}

/**
 * Every id the pure-key shape reads through its App's grants, for a fold, a listing or a point read; empty for any other shape,
 * and for a pure key that is not a run unless the key holds {@link GRANT_READ_SCOPE} now (read from the database at every call,
 * never from the auth context, so a revoked scope holds from the key's next call).
 */
export async function grantReadReachFor(
  db: PrismaClient,
  auth: {
    appId?: string | null; appKeyId?: string | null; userId?: string | null; sessionId?: string | null; impersonation?: unknown;
    sessionBindingRefused?: boolean; clientId?: string | null;
  },
  onlyMemoryIds?: readonly string[],
): Promise<Set<string>> {
  if (!isPureAppKeyShape(auth)) return new Set();
  const run = isRunPrincipal(auth);
  if (!run) {
    if (!auth.appKeyId || !(await keyHoldsScope(db, { appKeyId: auth.appKeyId, appId: auth.appId! }, GRANT_READ_SCOPE))) return new Set();
  }
  return appReadGrantReach(db, auth.appId!, { run, onlyMemoryIds });
}
