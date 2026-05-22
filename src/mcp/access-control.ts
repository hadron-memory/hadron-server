/**
 * MCP access-control: which memories can the caller read/write?
 *
 * Callers authenticate via an App Key and resolve to an `appId`; access is
 * gated by the App's installed Agents (via the `AppAgent` N:M join from
 * 023-app-shape; the pre-023 direct `App.agentId` FK was dropped in Phase 2b).
 * Per Constitution Principle V (Zero-Trust Apps), every read and write is
 * checked server-side here — Apps cannot self-attest.
 *
 * After 023-app-shape Phase 2b:
 *   - App ↔ Agent is N:M via `app_agents`. This module reads the "primary"
 *     (first installed) Agent for legacy single-Agent paths; multi-Agent
 *     dispatch ships with the US1 resolvers in their own PR.
 *   - The new authorization predicate (`src/lib/auth/resolveMemoryAuthorization`)
 *     is the long-term home for these decisions. The retrofit that delegates
 *     `canReadMemory` / `canWriteToMemory` to the predicate is a separate
 *     follow-up; this module keeps its own logic for now but uses the
 *     AppAgent helpers from `src/lib/appAgent.ts`.
 *
 * Carried forward from 008-agent-installation:
 *   - System memory is universally read-only from any App context
 *     (DEVELOP-from-App is gone). Per-attached-memory write caps remain
 *     governed by AgentMemoryItem.role.
 *   - Cross-org App↔Agent uses requires an active AgentOrgGrant; same-org
 *     installs auto-pass.
 */

import type { PrismaClient } from '../generated/prisma/index.js';
import type { AuthContext } from '../middleware/auth.js';
import { isActiveAgentSubscription } from '../lib/agentSubscription.js';
import { isLifecycleActive } from '../lib/lifecycle.js';
import { isAgentInstalled } from '../lib/appAgent.js';
import { resolveUserApps } from '../auth/user-app-resolution.js';

// ---------------------------------------------------------------------------
// Shared fold algorithm
// ---------------------------------------------------------------------------

/**
 * Fold an Agent's system memory + memoryItems into an effective
 * `memoryId → READ_ONLY|READ_WRITE` map.
 *
 * After 008-agent-installation:
 *   - System memory: always READ_ONLY from an App context (DEVELOP-from-App
 *     is gone). The Agent ownership surface is the only path to edit it.
 *   - Knowledge memoryItems: governed by AgentMemoryItem.role
 *     (read | read-write); no AppAgent-level cap exists.
 */
type AgentLike = {
  systemMemoryId?: string | null;
  memoryItems: Array<{ memoryId: string; role?: 'read' | 'read-write' | string | null }>;
};

export function foldAgentIntoAccessMap(agent: AgentLike): Map<string, string> {
  const access = new Map<string, string>();

  const systemMemoryId = agent.systemMemoryId ?? null;
  if (systemMemoryId) {
    access.set(systemMemoryId, 'READ_ONLY');
  }

  for (const item of agent.memoryItems) {
    const agentRole = item.role ?? 'read';
    const effective = agentRole === 'read-write' ? 'READ_WRITE' : 'READ_ONLY';
    const existing = access.get(item.memoryId);
    if (!existing || effective === 'READ_WRITE') {
      access.set(item.memoryId, effective);
    }
  }

  return access;
}

// ---------------------------------------------------------------------------
// App-keyed resolver
// ---------------------------------------------------------------------------

/**
 * Memory access for an App principal — reads the App's primary installed
 * Agent (via the `app_agents` join from 023-app-shape Phase 2b), then folds
 * that Agent's system memory + memoryItems into the access map.
 *
 * "Primary" is the first installed Agent (ordered by AppAgent.createdAt).
 * Multi-Agent dispatch — where the URN in the request selects which
 * installed Agent to evaluate — is the US1 work; this legacy path keeps
 * single-Agent semantics until then.
 *
 * Cross-org gate: if the App's org and the Agent's org differ, an active
 * AgentOrgGrant(App.organization_id, primary-agent.id) is required.
 * Same-org installations auto-pass.
 */
export async function getAppMemoryAccess(
  db: PrismaClient,
  appId: string,
): Promise<Map<string, string>> {
  const app = await db.app.findUnique({
    where: { id: appId },
    select: {
      id: true,
      organizationId: true,
      appAgents: {
        orderBy: { createdAt: 'asc' },
        take: 1,
        select: {
          agent: {
            select: {
              id: true,
              organizationId: true,
              systemMemoryId: true,
              deletedAt: true,
              memoryItems: {
                where: { deletedAt: null, memory: { deletedAt: null } },
                select: { memoryId: true, role: true },
              },
            },
          },
        },
      },
    },
  });

  const primary = app?.appAgents[0]?.agent ?? null;
  if (!app || !primary || primary.deletedAt) return new Map();

  // Cross-org gate: require active AgentOrgGrant when App and Agent live in
  // different orgs. Same-org installs auto-pass — the Agent owner has implicit
  // license to deploy it. The active-status predicate is shared across
  // AgentSubscription + AgentOrgGrant via isLifecycleActive (008 R-2).
  if (app.organizationId !== primary.organizationId) {
    const grant = await db.agentOrgGrant.findUnique({
      where: { orgId_agentId: { orgId: app.organizationId, agentId: primary.id } },
    });
    if (!grant || !isLifecycleActive(grant)) return new Map();
  }

  return foldAgentIntoAccessMap({
    systemMemoryId: primary.systemMemoryId,
    memoryItems: primary.memoryItems.map((item) => ({
      memoryId: item.memoryId,
      role: (item as { role?: string | null }).role ?? 'read',
    })),
  });
}

// ---------------------------------------------------------------------------
// Public API used by MCP tool handlers
// ---------------------------------------------------------------------------

export async function getMemoryAccess(
  db: PrismaClient,
  auth: AuthContext,
): Promise<Map<string, string>> {
  if (auth.appId) return getAppMemoryAccess(db, auth.appId);

  // Spec 026 / D-2026-05-21-003 advisory branch: when no active App is
  // selected but the caller is an authenticated user (OAuth-issued or
  // portal-issued bearer token), return the union of memory access across
  // every App the user is a member of. App identity is a focusing concern,
  // not access control — the user's total access is bounded by their
  // AppMember rows regardless of which App is currently in focus.
  // Personal-class memories are still strictly owned by Memory.userId
  // (per the canReadMemory / canWriteToMemory predicates above) — this
  // map only includes memories the user can reach via App membership;
  // personal-class authorization is enforced separately.
  if (auth.userId) {
    const apps = await resolveUserApps(auth.userId, db);
    if (apps.length === 0) return new Map();
    const perAppMaps = await Promise.all(
      apps.map((app) => getAppMemoryAccess(db, app.id)),
    );
    const merged = new Map<string, string>();
    for (const perApp of perAppMaps) {
      for (const [memoryId, level] of perApp) {
        const existing = merged.get(memoryId);
        // READ_WRITE wins over READ when the same memory appears via
        // multiple App memberships (defensive — the data model makes
        // this unlikely but not impossible if a user has two roles
        // across two Apps that share a memory item).
        if (!existing || (existing === 'READ' && level === 'READ_WRITE')) {
          merged.set(memoryId, level);
        }
      }
    }
    return merged;
  }

  return new Map();
}

/**
 * Check if a caller has write access to a specific memory.
 *
 * Personal-class memories (FR-016 + 008 FR-011): strict ownership — only
 * Memory.userId can write, no ADMIN/OWNER bypass; App-keyed callers
 * additionally need (a) Memory.app_id === auth.appId (per-App isolation),
 * and (b) an active AgentSubscription(user, app.agent_id).
 *
 * Other memory classes: ADMIN/OWNER bypass + App.agent_id-derived membership +
 * AgentMemoryItem.role caps.
 */
export async function canWriteToMemory(
  db: PrismaClient,
  auth: AuthContext,
  memoryId: string,
): Promise<boolean> {
  const memory = await db.memory.findUnique({
    where: { id: memoryId },
    select: { class: true, userId: true, userMemoryOfAgentId: true, appId: true },
  });

  if (memory?.class === 'personal') {
    if (auth.userId !== memory.userId) return false;
    if (auth.appId) {
      // Per-App isolation: a session through App A cannot write the personal
      // memory at (B.id, user.id) for some other App B of the same Agent.
      // Existing rows that pre-date the migration may have appId = NULL —
      // accept them ONLY when the calling App has the memory's Agent
      // installed via AppAgent. Without that guard, an App for Agent Y could
      // satisfy the AgentSubscription check (using one of its installed
      // Agents) and then touch a legacy memory that was actually created
      // for Agent X.
      if (memory.appId !== null) {
        if (memory.appId !== auth.appId) return false;
      } else {
        // Legacy row: require the calling App to have the memory's Agent
        // installed. If userMemoryOfAgentId is null (pre-005 ghost row) we
        // can't prove the match, so deny — backfilling app_id is the path
        // forward.
        //
        // Perf note: this branch performs an extra PK lookup per check
        // (N+1 for bulk operations). The cost is bounded — it only fires
        // for legacy rows with `memory.appId IS NULL`, a strictly
        // shrinking set as new writes always populate app_id. Adding a
        // request-scoped (appId, agentId) cache on AuthContext is the
        // long-term answer; deferred until the predicate retrofit
        // (Phase 2c) lands its own cache.
        if (
          !memory.userMemoryOfAgentId ||
          !(await isAgentInstalled(db, auth.appId, memory.userMemoryOfAgentId))
        ) {
          return false;
        }
      }

      // AgentSubscription check uses the memory's own Agent (chk_memory_personal_agent_id
      // guarantees `userMemoryOfAgentId` is non-null for personal-class rows
      // created post-023; legacy null rows already denied above).
      if (!memory.userMemoryOfAgentId || !memory.userId) return false;
      const sub = await db.agentSubscription.findUnique({
        where: {
          userId_agentId: {
            userId: memory.userId,
            agentId: memory.userMemoryOfAgentId,
          },
        },
      });
      if (!sub || !isActiveAgentSubscription(sub)) return false;
    }
    return true;
  }

  // Non-personal memory: standard checks. Per D-2026-05-21-003, when
  // auth.appId is unset (multi-App OAuth caller without selection),
  // getMemoryAccess unions across all the user's accessible Apps —
  // the access map answers the question "does the caller have RW on
  // this memory via *any* of their App memberships?"
  if (auth.roles?.includes('ADMIN') || auth.roles?.includes('OWNER')) return true;

  const access = await getMemoryAccess(db, auth);
  return access.get(memoryId) === 'READ_WRITE';
}

/**
 * Check if a caller has read access to a specific memory.
 *
 * Personal-class memories enforce strict ownership (FR-016) — even ADMIN/OWNER
 * cannot read another user's personal memory. The 008 per-App isolation
 * (Memory.app_id === auth.appId) also applies.
 */
export async function canReadMemory(
  db: PrismaClient,
  auth: AuthContext,
  memoryId: string,
): Promise<boolean> {
  const memory = await db.memory.findUnique({
    where: { id: memoryId },
    select: { class: true, userId: true, userMemoryOfAgentId: true, appId: true },
  });
  if (!memory) return false;

  if (memory.class === 'personal') {
    if (auth.userId !== memory.userId) return false;
    if (auth.appId) {
      // Same legacy guard as canWriteToMemory: when memory.appId is NULL,
      // require the calling App to have the memory's Agent installed via
      // AppAgent.
      if (memory.appId !== null) {
        if (memory.appId !== auth.appId) return false;
      } else {
        if (
          !memory.userMemoryOfAgentId ||
          !(await isAgentInstalled(db, auth.appId, memory.userMemoryOfAgentId))
        ) {
          return false;
        }
      }

      if (!memory.userMemoryOfAgentId || !memory.userId) return false;
      const sub = await db.agentSubscription.findUnique({
        where: {
          userId_agentId: {
            userId: memory.userId,
            agentId: memory.userMemoryOfAgentId,
          },
        },
      });
      if (!sub || !isActiveAgentSubscription(sub)) return false;
    }
    return true;
  }

  // Non-personal memory: ADMIN/OWNER bypass + access map check.
  // Per D-2026-05-21-003, when auth.appId is unset (multi-App OAuth caller
  // without selection), getMemoryAccess unions across all the user's
  // accessible Apps — the access map answers "does the caller have read
  // on this memory via *any* of their App memberships?"
  if (auth.roles?.includes('ADMIN') || auth.roles?.includes('OWNER')) return true;
  const access = await getMemoryAccess(db, auth);
  return access.has(memoryId);
}

/**
 * Get the set of memory IDs the caller can see.
 * Returns null to mean "all" (for ADMIN/OWNER) — but personal-class
 * memories never appear in an ADMIN/OWNER's "see all" list (FR-016
 * strict ownership applies), so callers MUST additionally apply the
 * personal-class filter when iterating memories.
 */
export async function getAccessibleMemoryIds(
  db: PrismaClient,
  auth: AuthContext,
): Promise<string[] | null> {
  if (auth.roles?.includes('ADMIN') || auth.roles?.includes('OWNER')) return null;

  // Per D-2026-05-21-003 advisory branch: when no active App is selected
  // but the caller is an authenticated user, getMemoryAccess unions across
  // all the user's accessible Apps. Returns [] for unauthenticated callers
  // and for users with no App memberships.
  const access = await getMemoryAccess(db, auth);
  return [...access.keys()];
}
