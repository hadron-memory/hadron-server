/**
 * MCP access-control: which memories can the caller read/write?
 *
 * Callers authenticate via an App Key and resolve to an `appId`; access
 * is gated by the AppAgent rows attached to that App. Per Constitution
 * Principle V (Zero-Trust Apps), every read and write is checked
 * server-side here — Apps cannot self-attest access.
 *
 * After spec 005-agent-subscription:
 *   - AppAgent.role (OPERATE | DEVELOP) is the sole control for the App's
 *     access to the Agent's system memory. DEVELOP unlocks read-write;
 *     OPERATE is read-only.
 *   - AppAgent.subscription_type is gone — per-attached-memory write caps
 *     are governed by AgentMemoryItem.role.
 *   - Memory.class = 'personal' enforces strict ownership (FR-016): only
 *     Memory.userId can read, no ADMIN/OWNER bypass. App writes are
 *     additionally gated by an active AgentSubscription(user, agent).
 */

import type { PrismaClient } from '../generated/prisma/index.js';
import type { AuthContext } from '../middleware/auth.js';
import { isActiveAgentSubscription } from '../lib/agentSubscription.js';

// ---------------------------------------------------------------------------
// Shared fold algorithm
// ---------------------------------------------------------------------------

/**
 * Fold AppAgent membership rows into an effective
 * `memoryId → READ_ONLY|READ_WRITE` map.
 *
 * After 005-agent-subscription:
 *   - System memory: AppAgent.role=DEVELOP → READ_WRITE; OPERATE → READ_ONLY.
 *   - Knowledge memoryItems: governed by AgentMemoryItem.role
 *     (read | read-write); no AppAgent-level cap.
 */
type SubscriptionLike = {
  role: 'OPERATE' | 'DEVELOP';
  agent: {
    systemMemoryId?: string | null;
    memoryItems: Array<{ memoryId: string; role?: 'read' | 'read-write' | string | null }>;
  };
};

export function foldSubscriptionsIntoAccessMap(
  subs: SubscriptionLike[],
): Map<string, string> {
  const access = new Map<string, string>();
  for (const sub of subs) {
    // Include the agent's system memory (linked via systemMemoryId, not
    // as a memoryItem). DEVELOP grants read-write so builders can edit
    // the conversation design / system prompt; OPERATE is read-only.
    const systemMemoryId = sub.agent.systemMemoryId ?? null;
    if (systemMemoryId) {
      const effective = sub.role === 'DEVELOP' ? 'READ_WRITE' : 'READ_ONLY';
      const existing = access.get(systemMemoryId);
      if (!existing || effective === 'READ_WRITE') {
        access.set(systemMemoryId, effective);
      }
    }

    for (const item of sub.agent.memoryItems) {
      // Per-attached-memory cap is exclusively governed by
      // AgentMemoryItem.role after 005-agent-subscription.
      const agentRole = item.role ?? 'read';
      const effective = agentRole === 'read-write' ? 'READ_WRITE' : 'READ_ONLY';
      const existing = access.get(item.memoryId);
      if (!existing || effective === 'READ_WRITE') {
        access.set(item.memoryId, effective);
      }
    }
  }
  return access;
}

// ---------------------------------------------------------------------------
// App-keyed resolver
// ---------------------------------------------------------------------------

/**
 * Memory access for an App principal — walks AppAgent rows for the App,
 * then folds the agent's memoryItems + system memory into the access map.
 */
export async function getAppMemoryAccess(
  db: PrismaClient,
  appId: string,
): Promise<Map<string, string>> {
  const appAgents = await db.appAgent.findMany({
    where: { appId, deletedAt: null },
    include: {
      agent: {
        include: {
          memoryItems: { include: { memory: true } },
        },
      },
    },
  });
  return foldSubscriptionsIntoAccessMap(
    appAgents.map((sub) => ({
      role: sub.role as 'OPERATE' | 'DEVELOP',
      agent: {
        systemMemoryId: sub.agent.systemMemoryId,
        memoryItems: sub.agent.memoryItems.map((item) => ({
          memoryId: item.memoryId,
          role: (item as { role?: string | null }).role ?? 'read',
        })),
      },
    })),
  );
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
 * Personal-class memories (FR-016): strict ownership — only Memory.userId
 * can write, no ADMIN/OWNER bypass; App-keyed callers additionally need
 * an active AgentSubscription(user, agent) per FR-019.
 *
 * Other memory classes: ADMIN/OWNER bypass + AppAgent membership +
 * AgentMemoryItem.role caps as before.
 */
export async function canWriteToMemory(
  db: PrismaClient,
  auth: AuthContext,
  memoryId: string,
): Promise<boolean> {
  // Personal-class memories: load the memory first to check the class
  // and the strict ownership invariant before falling back to the
  // standard ADMIN/OWNER bypass.
  const memory = await db.memory.findUnique({
    where: { id: memoryId },
    select: { class: true, userId: true, userMemoryOfAgentId: true },
  });

  if (memory?.class === 'personal') {
    // Strict ownership — no role bypass allowed
    if (auth.userId !== memory.userId) return false;
    // App-keyed callers additionally need an active AgentSubscription
    if (auth.appId) {
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

  // Non-personal memory: standard checks
  if (auth.roles?.includes('ADMIN') || auth.roles?.includes('OWNER')) return true;
  if (!auth.appId) return false;

  const access = await getMemoryAccess(db, auth);
  return access.get(memoryId) === 'READ_WRITE';
}

/**
 * Check if a caller has read access to a specific memory.
 *
 * Personal-class memories enforce strict ownership (FR-016) — even
 * ADMIN/OWNER cannot read another user's personal memory.
 */
export async function canReadMemory(
  db: PrismaClient,
  auth: AuthContext,
  memoryId: string,
): Promise<boolean> {
  const memory = await db.memory.findUnique({
    where: { id: memoryId },
    select: { class: true, userId: true, userMemoryOfAgentId: true },
  });
  if (!memory) return false;

  if (memory.class === 'personal') {
    if (auth.userId !== memory.userId) return false;
    if (auth.appId) {
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

  // Non-personal memory: ADMIN/OWNER bypass + access map check
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
