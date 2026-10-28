/** #1807: standing user read grants for a live Agent system memory.
 * Reuse the licensed App fold; subscriptions and public flags grant nothing.
 * The manager arm preserves the existing Agent ownership gate.
 * Caps report existing writes; callers use presence for record admission.
 */
import type { PrismaClient } from '../../generated/prisma/index.js';
import { FULL, READ, WRITE, type GrantWithCaps } from '@hadron-memory/access-control';
import { resolveUserApps } from '../../auth/user-app-resolution.js';
import { getAppMemoryAccess, participantSystemMemoryFolds } from '../../mcp/access-control.js';
import { getManagedSystemMemoryIds } from './managedSystemMemory.js';
import { LIVE_ORG_MEMBERSHIP } from './liveOrgMembership.js';
import { installMemoryAudience, isInstallMemoryRow } from './installMemory.js';

type GrantPrincipal = { userId?: string | null; roles?: readonly string[]; impersonation?: { orgId: string } | null; clientId?: string | null };

/**
 * #1813: the principal-keyed lookups {@link systemMemoryReadGrants} repeats per record, memoized for ONE list.
 *
 * Bound to the principal at construction, so a batch cannot be handed a different caller: every memo below is
 * a pure function of (db, principal) and nothing else. It lives only as long as the list that built it (never
 * module- or request-global), so a revocation committed before the NEXT request is always seen by it.
 * Per-record rows (the memory, its Agent, its org) are deliberately not memoized here.
 */
export type SystemMemoryGrantBatch = {
  principal: GrantPrincipal;
  /** The user's Apps, resolved once. */
  apps?: ReturnType<typeof resolveUserApps>;
  /** Ids the manager helper admits, over EVERY Agent system memory; callers filter by id. Keeps restrictToOrgId. */
  managedIds?: Promise<Set<string>>;
  /** Per-App licensed fold, computed on first use by an App that survives the impersonation filter. */
  appAccess: Map<string, Promise<Map<string, string>>>;
  /** Per-App attribution rows (urn + the caller's membership role). */
  appAttribution: Map<string, Promise<{ urn: string | undefined; role: string | undefined }>>;
  participantFolds?: ReturnType<typeof participantSystemMemoryFolds>;
};

/** A fresh, empty batch for one list read by `principal`. */
export function createSystemMemoryGrantBatch(principal: GrantPrincipal): SystemMemoryGrantBatch {
  return { principal, appAccess: new Map(), appAttribution: new Map() };
}

export async function systemMemoryReadGrants(
  db: PrismaClient,
  principal: GrantPrincipal,
  memoryId: string,
  batch?: SystemMemoryGrantBatch,
): Promise<GrantWithCaps[]> {
  // The memo is only sound for the principal it was built for.
  if (batch && batch.principal !== principal) throw new Error('systemMemoryReadGrants: batch built for a different principal');
  if (!principal.userId) return [];
  const memory = await db.memory.findFirst({
    where: { id: memoryId, class: 'system', deletedAt: null },
    select: { id: true, class: true, organizationId: true, ownerUserId: true, appId: true, installOfAgentId: true, isInstallMemory: true },
  });
  if (!memory) return [];
  // #2044: an App's INSTALL MEMORY has no Agent pointing at it; it takes its own
  // arm (installMemory.ts), and nothing below widens for an Agent's own memory.
  if (isInstallMemoryRow(memory)) return installMemoryGrants(db, principal, memory);
  const agent = await db.agent.findFirst({
    where: { systemMemoryId: memoryId, deletedAt: null },
    select: { organizationId: true, ownerUserId: true },
  });
  // Invalid historical pointer ownership is not an admission path.
  if (!agent || agent.organizationId !== memory.organizationId || agent.ownerUserId !== memory.ownerUserId) return [];
  if (principal.impersonation && agent.organizationId !== principal.impersonation.orgId) return [];
  const grants: GrantWithCaps[] = [];
  const managed = batch
    ? (await (batch.managedIds ??= getManagedSystemMemoryIds(db, principal.userId, undefined, principal.impersonation?.orgId).then((ids) => new Set(ids)))).has(memoryId)
    : (await getManagedSystemMemoryIds(db, principal.userId, memoryId, principal.impersonation?.orgId)).includes(memoryId);
  if (agent.ownerUserId !== null) {
    if (managed && !principal.impersonation) {
      grants.push({ source: 'MEMORY_PRINCIPAL', role: 'owner', via: null, caps: FULL });
    } else if (!principal.impersonation && (principal.roles?.includes('ADMIN') || principal.roles?.includes('OWNER'))) {
      // (#1841, Rook P3-3 — the documented inline pair, deliberately kept:)
      // the shared package's isPlatformAdmin is Role-typed
      // ((@hadron-memory/access-control).isPlatformAdmin(roles: Role[])),
      // while this principal carries plain strings from the request context;
      // widening the package helper for a no-behavior-change pin was ruled
      // out at #1841. Keep these two lines equivalent to isPlatformAdmin.
      // #1787 (cor:dmo:050:13): a platform admin who may manage the Agent
      // (requireAgentAccess) reads its definition — read-only, exactly what
      // canReadMemoryRecord admits. Every other user-owned memory stays the
      // owner's alone, and impersonation carries no platform role.
      grants.push({
        source: 'PLATFORM_ROLE',
        role: principal.roles!.includes('OWNER') ? 'OWNER' : 'ADMIN',
        via: null,
        caps: READ,
      });
    }
    return grants;
  }
  if (!agent.organizationId) return [];
  const org = await db.organization.findFirst({ where: { id: agent.organizationId, deletedAt: null }, select: { urn: true } });
  if (!org) return [];
  if (!principal.impersonation && (principal.roles?.includes('ADMIN') || principal.roles?.includes('OWNER'))) {
    grants.push({ source: 'PLATFORM_ROLE', role: principal.roles.includes('OWNER') ? 'OWNER' : 'ADMIN', via: null, caps: WRITE });
  }
  if (managed) {
    // Attribution only: authority was decided by the shared manager helper.
    const member = await db.orgMember.findFirst({
      where: { organizationId: agent.organizationId, userId: principal.userId, ...LIVE_ORG_MEMBERSHIP },
      select: { role: true },
    });
    if (member) grants.push({ source: 'ORG_ROLE', role: member.role, via: org.urn, caps: WRITE });
  }
  const userId = principal.userId;
  const memo = <T>(cache: Map<string, Promise<T>> | undefined, key: string, load: () => Promise<T>): Promise<T> => {
    if (!cache) return load();
    let hit = cache.get(key);
    if (!hit) cache.set(key, hit = load());
    return hit;
  };
  const apps = await (batch ? (batch.apps ??= resolveUserApps(userId, db)) : resolveUserApps(userId, db));
  for (const app of apps) {
    // This is the same licensed, lifecycle-checked fold used by the read gates.
    if (principal.impersonation && app.organizationId !== principal.impersonation.orgId) continue;
    const access = await memo(batch?.appAccess, app.id, () => getAppMemoryAccess(db, app.id, { callerUserId: userId, includeTeamSpace: false }));
    if (!access.has(memoryId)) continue;
    const { urn, role } = await memo(batch?.appAttribution, app.id, async () => {
      const [row, member] = await Promise.all([
        db.app.findUnique({ where: { id: app.id }, select: { urn: true } }),
        db.appMember.findUnique({ where: { appId_userId: { appId: app.id, userId } }, select: { role: true } }),
      ]);
      return { urn: row?.urn, role: member?.role };
    });
    grants.push({ source: 'APP_MEMBER', role: role ?? 'member', via: urn ?? app.id, caps: READ });
  }
  // #2206 case 3: every App the user participates in (a member, an org CONTRIBUTOR+) where this Agent is installed and
  // licensed, not only through its first-installed Agent; the same fold the content gate reads.
  const appVia = new Set(grants.filter((g) => g.source === 'APP_MEMBER').map((g) => g.via));
  const folds = await (batch ? (batch.participantFolds ??= participantSystemMemoryFolds(db, principal)) : participantSystemMemoryFolds(db, principal));
  for (const { appId } of folds.filter(({ map }) => map.has(memoryId))) {
    const { urn } = await memo(batch?.appAttribution, appId, async () => {
      const [row, member] = await Promise.all([
        db.app.findUnique({ where: { id: appId }, select: { urn: true } }),
        db.appMember.findUnique({ where: { appId_userId: { appId, userId } }, select: { role: true } }),
      ]);
      return { urn: row?.urn, role: member?.role };
    });
    if (appVia.has(urn ?? appId)) continue;
    grants.push({ source: 'APP_MEMBER', role: 'participant', via: urn ?? appId, caps: READ });
  }
  return grants;
}

/**
 * #2044: the grants on an install memory. Content (`read`) is the live App's
 * participants; a manager adds the delete (R45) and, while the App is live with
 * the Agent installed, the write. A manager of a soft-deleted App holds a grant
 * with NO read cap: the record is findable and deletable, never readable.
 */
async function installMemoryGrants(
  db: PrismaClient,
  principal: { userId?: string | null; roles?: readonly string[]; impersonation?: { orgId: string } | null },
  memory: { id: string; class: string; appId: string | null; installOfAgentId: string | null; isInstallMemory: boolean; organizationId: string | null; ownerUserId: string | null },
): Promise<GrantWithCaps[]> {
  const audience = await installMemoryAudience(db, principal, memory);
  if (!audience.record) return [];
  const [app, member] = await Promise.all([
    db.app.findUnique({ where: { id: memory.appId! }, select: { urn: true } }),
    principal.userId
      ? db.appMember.findUnique({ where: { appId_userId: { appId: memory.appId!, userId: principal.userId } }, select: { role: true } })
      : null,
  ]);
  const grants: GrantWithCaps[] = [];
  if (audience.read) grants.push({ source: 'APP_MEMBER', role: member?.role ?? 'member', via: app?.urn ?? memory.appId, caps: READ });
  if (audience.delete) {
    grants.push({
      source: 'MEMORY_PRINCIPAL', role: 'app-manager', via: app?.urn ?? memory.appId,
      caps: { read: false, write: audience.write, manage: false, delete: true },
    });
  }
  return grants;
}
