/**
 * MCP access-control: which memories can the caller read/write?
 *
 * Callers authenticate via an App Key and resolve to an `appId`; access is
 * gated by the App's direct `agent_id` FK (no longer an AppAgent join, after
 * 008-agent-installation). Per Constitution Principle V (Zero-Trust Apps),
 * every read and write is checked server-side here — Apps cannot self-attest.
 *
 * After 008-agent-installation:
 *   - AppAgent.role (OPERATE | DEVELOP) is gone. System memory is universally
 *     read-only from any App context (DEVELOP-from-App is no longer supported;
 *     edits happen in the Agent ownership surface). Per-attached-memory write
 *     caps remain governed by AgentMemoryItem.role.
 *   - Memory.class = 'personal' addresses on (app_id, user_id). The gate
 *     additionally requires Memory.app_id === auth.appId so a session through
 *     App A cannot read the personal memory at (B.id, user.id) for some other
 *     App B of the same Agent.
 *   - Cross-org App↔Agent uses requires an active AgentOrgGrant; same-org
 *     installs (App.organization_id === Agent.organization_id) auto-pass.
 */

import type { PrismaClient } from '../generated/prisma/index.js';
import type { AuthContext } from '../middleware/auth.js';
import { isActiveAgentSubscription } from '../lib/agentSubscription.js';

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
 * Memory access for an App principal — reads App.agent_id directly (the
 * AppAgent join is gone), then folds the Agent's system memory + memoryItems
 * into the access map.
 *
 * Cross-org gate: if the App's org and the Agent's org differ, an active
 * AgentOrgGrant(App.organization_id, App.agent_id) is required. Same-org
 * installations auto-pass.
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
      agentId: true,
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
  });

  if (!app || !app.agent || app.agent.deletedAt) return new Map();

  // Cross-org gate: require active AgentOrgGrant when App and Agent live in
  // different orgs. Same-org installs auto-pass — the Agent owner has implicit
  // license to deploy it.
  if (app.organizationId !== app.agent.organizationId) {
    const grant = await db.agentOrgGrant.findUnique({
      where: { orgId_agentId: { orgId: app.organizationId, agentId: app.agent.id } },
    });
    const active =
      !!grant &&
      grant.activatedAt !== null &&
      grant.revokedAt === null &&
      (grant.expiresAt === null || grant.expiresAt > new Date());
    if (!active) return new Map();
  }

  return foldAgentIntoAccessMap({
    systemMemoryId: app.agent.systemMemoryId,
    memoryItems: app.agent.memoryItems.map((item) => ({
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
      // Existing rows that pre-date the migration may have appId = NULL — accept
      // them when the agent matches via App.agentId for backward compat.
      if (memory.appId !== null && memory.appId !== auth.appId) return false;

      // Resolve the Agent for the AgentSubscription check via App.agentId.
      const app = await db.app.findUnique({
        where: { id: auth.appId },
        select: { agentId: true },
      });
      const agentId = app?.agentId ?? memory.userMemoryOfAgentId;
      if (!agentId || !memory.userId) return false;
      const sub = await db.agentSubscription.findUnique({
        where: {
          userId_agentId: {
            userId: memory.userId,
            agentId,
          },
        },
      });
      if (!sub || !isActiveAgentSubscription(sub)) return false;
    }
    return true;
  }

  // Non-personal memory: standard checks.
  if (auth.roles?.includes('ADMIN') || auth.roles?.includes('OWNER')) return true;
  if (!auth.appId) return false;

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
      if (memory.appId !== null && memory.appId !== auth.appId) return false;

      const app = await db.app.findUnique({
        where: { id: auth.appId },
        select: { agentId: true },
      });
      const agentId = app?.agentId ?? memory.userMemoryOfAgentId;
      if (!agentId || !memory.userId) return false;
      const sub = await db.agentSubscription.findUnique({
        where: {
          userId_agentId: {
            userId: memory.userId,
            agentId,
          },
        },
      });
      if (!sub || !isActiveAgentSubscription(sub)) return false;
    }
    return true;
  }

  // Non-personal memory: ADMIN/OWNER bypass + access map check.
  if (auth.roles?.includes('ADMIN') || auth.roles?.includes('OWNER')) return true;
  if (!auth.appId) return false;
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
  if (!auth.appId) return [];

  const access = await getMemoryAccess(db, auth);
  return [...access.keys()];
}
