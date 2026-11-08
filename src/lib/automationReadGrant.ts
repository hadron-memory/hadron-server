/**
 * #2883 (ruling 0079 = A; hrn:node:hadronmemory.com:specs:cor:agt:010:01, the read-grant rule;
 * hrn:node:hadronmemory.com:specs:cor:acl:010:01, the system row): an automation's READ grant.
 *
 * "The automation" a grant belongs to is the run's ROOT TRIGGER: the `AgentSchedule` or `AgentWebhook` row that holds
 * the adoption pin (Vera, team chat #66533, Q1). `AutomationVersion` is the #1655 signed-JSON store and no run reads
 * it. Runs that descend from a trigger (SPAWN children, routed runs, INTEGRATION runs) carry their root trigger's
 * grant, as they are held to its adoption; a MANUAL run has no trigger and so no grant (Q2).
 *
 * Ruling 0081 = A: the grant is keyed `(appId, triggerKind, triggerId)` on that trigger row, so it carries over an
 * edit and a re-adoption (re-adoption rewrites the pin on the same row) and ends only on revoke or when the trigger is
 * soft-deleted ({@link rootTriggerOfRun} returns null for a deleted trigger, so a stale row admits nothing).
 *
 * {@link runHoldsReadGrant} is the ONE read arm. It is consulted only by the run `hadron_read_node` read, after the
 * shared gate has refused, and only ever adds: every check below can only refuse.
 */
import type { PrismaClient } from '../generated/prisma/index.js';
import type { AuthContext } from '../middleware/auth.js';
import { canReadMemory } from '../mcp/access-control.js';
import { isAgentInstalled } from './appAgent.js';
import { grantCoversLoc } from './appWriteGrant.js';
import { LINK_CAP_MEMORY_SELECT, independentReach, type LinkCapMemory } from './auth/agentMemoryLinkCap.js';

export type ReadGrantPrincipal = Pick<AuthContext, 'userId' | 'appId'>;

export type ReadGrantTriggerKind = 'SCHEDULE' | 'WEBHOOK';
export interface RootTrigger { kind: ReadGrantTriggerKind; id: string }

/** Lineage depth cap, the same bound `currentOriginPin` (src/lib/automation/pins.ts) applies to a run's ancestry. */
const MAX_LINEAGE = 100;

/**
 * The live root trigger of a run, or null. Walks `parentRunId` from the run to the first SCHEDULE or WEBHOOK run and
 * returns that trigger when its row is live (`deletedAt` null) and belongs to the run's own App. Null, never a throw,
 * for every other shape, since a grant lookup can only ever admit: a MANUAL ancestor (a manual launch acts as its own
 * trigger, and holds no grant), a missing run or trigger, a deleted trigger, a cycle or a lineage past the cap, an
 * ancestor in another App.
 */
export async function rootTriggerOfRun(
  db: Pick<PrismaClient, 'appRun' | 'agentSchedule' | 'agentWebhook'>,
  runId: string,
): Promise<RootTrigger | null> {
  const seen = new Set<string>();
  let appId: string | null = null;
  for (let id: string | null = runId; id;) {
    if (seen.has(id) || seen.size >= MAX_LINEAGE) return null;
    seen.add(id);
    const run: { appId: string; triggerKind: string; triggerId: string | null; parentRunId: string | null } | null =
      await db.appRun.findUnique({ where: { id }, select: { appId: true, triggerKind: true, triggerId: true, parentRunId: true } });
    if (!run) return null;
    if (appId === null) appId = run.appId;
    else if (run.appId !== appId) return null;
    if (run.triggerKind === 'MANUAL') return null;
    if (run.triggerKind === 'SCHEDULE' || run.triggerKind === 'WEBHOOK') {
      if (!run.triggerId) return null;
      const where = { id: run.triggerId, appId, deletedAt: null };
      const live = run.triggerKind === 'SCHEDULE'
        ? await db.agentSchedule.findFirst({ where, select: { id: true } })
        : await db.agentWebhook.findFirst({ where, select: { id: true } });
      return live ? { kind: run.triggerKind, id: live.id } : null;
    }
    id = run.parentRunId;
  }
  return null;
}

/** The App side of a target check: the run's (or the grant's) App. */
export interface ReadGrantApp { id: string; organizationId: string | null; ownerUserId: string | null }

/** Prisma `select` for {@link readGrantTargetRefusal}: the class rules plus what the cap reads. */
export const READ_GRANT_MEMORY_SELECT = {
  ...LINK_CAP_MEMORY_SELECT,
  id: true,
  isEncrypted: true,
  isInstallMemory: true,
  deletedAt: true,
  workerOf: { select: { id: true } },
} as const;

export type ReadGrantMemory = LinkCapMemory & {
  id: string;
  isEncrypted: boolean;
  isInstallMemory: boolean;
  deletedAt: Date | null;
  workerOf: Array<{ id: string }>;
};

export type ReadGrantTargetRefusal =
  | 'deleted' | 'encrypted' | 'install-memory' | 'strict-owner' | 'system-not-installed'
  | 'worker-memory' | 'session-memory' | 'other-app-team-space' | 'cap';

/**
 * May this App's automation hold a read grant on this memory at all, whoever gives it? Returns the refusal, or null.
 * Judged when a grant is given and again, live, at every read, so a memory that stops qualifying (its Agent
 * uninstalled, the memory encrypted or deleted) stops being read through the grant. Every branch can only refuse.
 *
 *  - personal / private: never (cor:agt:010:01, the class rules hold).
 *  - encrypted: never (Vera Q7a, team chat #66572; a userless run holds no session key, and the write grant refuses it too).
 *  - an install memory (class system, `isInstallMemory`): never (Q7b); it is not an Agent's system memory.
 *  - system: only the system memory of a live Agent INSTALLED in this App now (cor:acl:010:01 system row; no licence
 *    check, Vera Q5 #66533).
 *  - app: a Worker's working memory and a session memory never (Q7c, their own owner rules); another App's team space
 *    never, a v1 narrowing the spec does not require (Q7c: the PR states it; Built line "except another App's team
 *    space"). This App's own team space is allowed (redundant: the run already reads it).
 *  - any other class: never past the cap (cor:dmo:050:09), the App's tenant's independent reach
 *    ({@link independentReach}, Q7e): a group memory, or a knowledge memory outside the tenant's reach, is refused.
 */
export async function readGrantTargetRefusal(
  db: Pick<PrismaClient, 'agent' | 'appAgent' | 'app' | 'agentImport' | 'organization' | 'agentOrgGrant'>,
  app: ReadGrantApp,
  memory: ReadGrantMemory,
): Promise<ReadGrantTargetRefusal | null> {
  if (memory.deletedAt) return 'deleted';
  if (memory.class === 'personal' || memory.class === 'private') return 'strict-owner';
  if (memory.isEncrypted) return 'encrypted';
  if (memory.isInstallMemory) return 'install-memory';
  if (memory.class === 'system') {
    // The memory must be a live Agent's OWN definition: an Agent whose pointer names it AND whose exact tenant owns it
    // (the #2233 invariant, participantSystemMemoryFolds). A retained pointer at another tenant's row admits nothing.
    const agents = await db.agent.findMany({
      where: { systemMemoryId: memory.id, deletedAt: null, organizationId: memory.organizationId, ownerUserId: memory.ownerUserId },
      select: { id: true },
    });
    for (const agent of agents) if (await isAgentInstalled(db, app.id, agent.id)) return null;
    return 'system-not-installed';
  }
  if (memory.class === 'app') {
    if (memory.workerOf.length > 0) return 'worker-memory';
    if (memory.userMemoryOfAgentId !== null) return 'session-memory';
    return memory.appId === app.id ? null : 'other-app-team-space';
  }
  const reach = independentReach({ organizationId: app.organizationId, ownerUserId: app.ownerUserId, appId: app.id }, memory);
  return reach === null ? 'cap' : null;
}

/**
 * May the run `runId` read `loc` of `memoryId` through its root trigger's read grant? True only when ALL hold:
 *  1. the run descends from a live trigger of its own App ({@link rootTriggerOfRun}; a MANUAL run, a deleted trigger
 *     or a foreign ancestor is false);
 *  2. a live (unrevoked) row of THAT trigger covers the memory and the loc (a NULL prefix is the whole memory, else
 *     the prefix matches the loc and its `:`-boundary descendants, {@link grantCoversLoc});
 *  3. the App is live and the target still qualifies ({@link readGrantTargetRefusal}, judged now, not when given);
 *  4. a user-backed run ALSO passes the user layer: the grant widens the App layer only, so the on-behalf-of user must
 *     be able to read the memory acting as themselves (no App fold, no run principal).
 * Read only. A caller with no run principal, no App, or a run of another App is false.
 */
export async function runHoldsReadGrant(
  db: PrismaClient,
  principal: ReadGrantPrincipal,
  runId: string,
  memoryId: string,
  loc: string,
): Promise<boolean> {
  const appId = principal.appId;
  if (!appId) return false;
  const root = await rootTriggerOfRun(db, runId);
  if (!root) return false;
  const rows = await db.appAutomationReadGrant.findMany({
    where: { appId, triggerKind: root.kind, triggerId: root.id, memoryId, revokedAt: null },
    select: { prefix: true },
  });
  if (!rows.some((row) => row.prefix === null || grantCoversLoc(row.prefix, loc))) return false;
  const app = await db.app.findFirst({
    where: { id: appId, deletedAt: null, uninstalledAt: null },
    select: { id: true, organizationId: true, ownerUserId: true },
  });
  if (!app) return false;
  const memory = await db.memory.findFirst({ where: { id: memoryId }, select: READ_GRANT_MEMORY_SELECT });
  if (!memory || (await readGrantTargetRefusal(db, app, memory)) !== null) return false;
  if (!principal.userId) return true;
  const user = await db.user.findFirst({ where: { id: principal.userId, deletedAt: null }, select: { id: true, roles: true } });
  if (!user) return false;
  return canReadMemory(db, { userId: user.id, roles: user.roles }, memoryId);
}
