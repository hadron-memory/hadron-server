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
import { isUserHolding } from '../auth/userHolding.js';
import { RUN_CLIENT_PREFIX } from '../auth/runPrincipal.js';
import { rootTriggerOfRun } from '../automation/rootTrigger.js';
import { grantCoversLoc } from './writeGrant.js';

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
  | 'other-app-team-space' | 'own-app' | 'user-holding' | 'user-owned';

type Db = Pick<PrismaClient, 'agent' | 'appAgent' | 'app' | 'agentImport' | 'organization' | 'agentOrgGrant'>;

/**
 * May a `memory.read` grant held by App `appId` name this memory at all? Returns the refusal, or null. Judged when the grant is
 * created and again at every read, so a memory that stops qualifying stops being read. Every branch can only refuse.
 *  - personal / private: never (cor:agt:010:01, "No user attached ⇒ no personal reach"; the #2883 target rule).
 *  - encrypted: never (a userless run and a key hold no session key); an install memory never (it is not an Agent's own).
 *  - system: only the system memory of a live Agent installed in this App now (the #2883 rule).
 *  - app: a Worker's or a session memory never; another App's team space never (the #2883 narrowing); this App's own memories
 *    `own-app` (it reads them already, so a grant would name nothing new).
 *  - group and knowledge: admitted, except a per-user chat holding (hadron-internal#88) and (#5345) a USER-OWNED one
 *    (`ownerUserId` set): GraphQL's record gate (`canReadMemoryRecord`'s ownerUserId branch) refuses such a memory to a
 *    principal with no user, so a grant that admitted it would let MCP and node reads serve what `memory(ref:)` and the list
 *    refuse (cor:api:120:03), the drift #5345 removed for links. The giver's own read (judged at every use) bounds the rest.
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
  // hadron-internal#88 (cor:cht:010:02): a per-user chat holding is its creator's alone; no grant held by an App serves it, whoever
  // gives it (as automationReadGrant.ts's #2883 judge). Refused at creation and again at every read.
  if (isUserHolding(memory)) return 'user-holding';
  if (memory.ownerUserId !== null) return 'user-owned';
  if (memory.appId === appId) return 'own-app';
  return null;
}

interface ReadGrantRow { action_values: unknown; issuer_user_id: string | null }

/**
 * #5412 (cor:acl:140:02, the two Proposed optional parameters; cor:acl:140:09, the absent-key form): a grant row's optional terms. A
 * missing key restricts nothing. A key that is present but holds anything other than one non-empty string (the creation door admits
 * nothing else) makes the row reach NOTHING: a malformed restriction is never read as no restriction.
 */
function optionalTerms(values: unknown): { branch: string | null; automation: string | null } | null {
  const v = (values ?? {}) as Record<string, unknown>;
  const one = (k: string): string | null | undefined => {
    if (!Object.prototype.hasOwnProperty.call(v, k)) return null;
    const x = v[k];
    return typeof x === 'string' && x !== '' && x !== '*' ? x : undefined;
  };
  const branch = one('branch');
  const automation = one('automation');
  if (branch === undefined || automation === undefined) return null;
  return { branch, automation };
}

/** The root trigger id of the principal's run, looked up once per call and only when a row names an automation; null for a key or a manual run. */
function rootTriggerLookup(db: PrismaClient, runId: string | null): () => Promise<string | null> {
  let cached: Promise<string | null> | undefined;
  return () => (cached ??= runId ? rootTriggerOfRun(db, runId).then((r) => r?.id ?? null) : Promise.resolve(null));
}

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
  opts: { run: boolean; runId?: string | null; onlyMemoryIds?: readonly string[] },
): Promise<Set<string>> {
  return (await appReadGrantReachDetail(db, appId, opts)).whole;
}

/**
 * The detail of {@link appReadGrantReach}: `whole`, the memories read whole (by a grant with no `branch`); and `branches`, for a memory
 * read ONLY through `branch` grants (#5412), the loc prefixes it may be read under. A memory in `whole` is never in `branches`. The
 * per-memory gates read `whole` only, so a memory opened only in part is unreadable to them (they fail closed); the node surfaces that
 * honour a branch read `branches` through {@link branchAdmitsLoc}.
 */
export async function appReadGrantReachDetail(
  db: PrismaClient,
  appId: string,
  opts: { run: boolean; runId?: string | null; onlyMemoryIds?: readonly string[] },
): Promise<{ whole: Set<string>; branches: Map<string, string[]> }> {
  const out = new Set<string>();
  const branches = new Map<string, string[]>();
  const result = { whole: out, branches };
  if (opts.onlyMemoryIds && opts.onlyMemoryIds.length === 0) return result;
  // Grants first: most Apps hold none, and this runs for every read of a pure key or a userless run.
  const rows = await db.$queryRaw<ReadGrantRow[]>`
    SELECT g.action_values, g.issuer_user_id FROM grants g
    WHERE g.app_id = ${appId} AND g.grantee_app_id = ${appId} AND g.user_id IS NULL AND g.agent_id IS NULL AND g.worker_id IS NULL
      AND g.action = ${MEMORY_READ_ACTION} AND ${grantLiveSql('g')}`;
  if (rows.length === 0) return result;
  const app = await liveApp(db, appId);
  if (!app) return result;
  const rootTrigger = rootTriggerLookup(db, opts.run ? (opts.runId ?? null) : null);
  const givers = new Map<string, { roles: unknown } | null>();
  const only = opts.onlyMemoryIds ? new Set(opts.onlyMemoryIds) : null;

  // Split the rows by form. (a): the value is the App's own organization id, a single string. (b): one or more memory ids.
  // #5412: a row bound to one automation reaches only a userless run whose live root trigger it is (a key, a manual run, another
  // automation's run: nothing); a row with a `branch` reaches its one memory under that loc only.
  const orgIssuers: Array<string | null> = [];
  const byMemory = new Map<string, Array<{ issuer: string | null; branch: string | null }>>();
  for (const r of rows) {
    const terms = optionalTerms(r.action_values);
    if (!terms) continue;
    if (terms.automation !== null && (!opts.run || (await rootTrigger()) !== terms.automation)) continue;
    const v = (r.action_values as { memory?: unknown } | null)?.memory;
    if (typeof v === 'string' && app.organizationId !== null && v === app.organizationId) {
      if (terms.branch === null) orgIssuers.push(r.issuer_user_id); // a branch never rides form (a): such a row reaches nothing
      continue;
    }
    if (terms.branch !== null && typeof v !== 'string') continue; // nor a list
    for (const memoryId of Array.isArray(v) ? v : [v]) {
      if (typeof memoryId !== 'string' || (only && !only.has(memoryId))) continue;
      byMemory.set(memoryId, [...(byMemory.get(memoryId) ?? []), { issuer: r.issuer_user_id, branch: terms.branch }]);
    }
  }

  // (b): each named memory, the target judged now, the giver's own read judged now.
  if (byMemory.size > 0) {
    const memories = await db.memory.findMany({ where: { id: { in: [...byMemory.keys()] } }, select: READ_GRANT_TARGET_SELECT });
    for (const memory of memories) {
      if ((await memoryReadTargetRefusal(db, appId, memory)) !== null) continue;
      const prefixes = new Set<string>();
      for (const { issuer, branch } of byMemory.get(memory.id) ?? []) {
        if (branch !== null && prefixes.has(branch)) continue;
        if (!(await giverCounts(db, givers, issuer, (g) => readsInOwnRight(db, g.id, g.roles, memory.id)))) continue;
        if (branch === null) { out.add(memory.id); break; }
        prefixes.add(branch);
      }
      if (!out.has(memory.id) && prefixes.size > 0) branches.set(memory.id, [...prefixes].sort());
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
      for (const k of knowledge) { out.add(k.id); branches.delete(k.id); }
    }
  }
  return result;
}

/** #5412: is `loc` inside one of a memory's branch prefixes (the prefix itself, or below it on a `:` boundary, as `memory.write` judges)? */
export function branchAdmitsLoc(prefixes: readonly string[] | undefined, loc: string): boolean {
  return (prefixes ?? []).some((p) => grantCoversLoc(p, loc));
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
  return (await grantReadReachDetailFor(db, auth, onlyMemoryIds)).whole;
}

function runIdOf(auth: { clientId?: string | null }): string | null {
  return isRunPrincipal(auth) ? auth.clientId!.slice(RUN_CLIENT_PREFIX.length) : null;
}

/**
 * #5412: {@link grantReadReachFor}'s detail (whole memories and branch-only memories), for the node surfaces that honour a `branch`.
 * Empty for every shape {@link grantReadReachFor} gives nothing.
 */
export async function grantReadReachDetailFor(
  db: PrismaClient,
  auth: Parameters<typeof grantReadReachFor>[1],
  onlyMemoryIds?: readonly string[],
): Promise<{ whole: Set<string>; branches: Map<string, string[]> }> {
  const none = { whole: new Set<string>(), branches: new Map<string, string[]>() };
  if (!isPureAppKeyShape(auth)) return none;
  const run = isRunPrincipal(auth);
  if (!run) {
    if (!auth.appKeyId || !(await keyHoldsScope(db, { appKeyId: auth.appKeyId, appId: auth.appId! }, GRANT_READ_SCOPE))) return none;
  }
  return appReadGrantReachDetail(db, auth.appId!, { run, runId: runIdOf(auth), onlyMemoryIds });
}
