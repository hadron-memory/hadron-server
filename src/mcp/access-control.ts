/**
 * MCP access-control: which memories can the caller read/write?
 *
 * Callers authenticate via an App Key and resolve to an `appId`; access
 * is gated by the AppAgent rows attached to that App. Per Constitution
 * Principle V (Zero-Trust Apps), every read and write is checked
 * server-side here — Apps cannot self-attest access.
 */

import type { PrismaClient } from '../generated/prisma/index.js';
import type { AuthContext } from '../middleware/auth.js';

// ---------------------------------------------------------------------------
// Shared fold algorithm
// ---------------------------------------------------------------------------

/**
 * Fold AppAgent membership rows into an effective
 * `memoryId → READ_ONLY|READ_WRITE` map.
 */
type SubscriptionLike = {
  subscriptionType: 'READ_ONLY' | 'READ_WRITE';
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
    // Include the agent's system memory (linked via systemMemoryId,
    // not as a memoryItem). READ_WRITE on the subscription grants
    // read-write to the system memory so builders can create
    // conversations/stages.
    const systemMemoryId = sub.agent.systemMemoryId ?? null;
    if (systemMemoryId) {
      const effective = sub.subscriptionType === 'READ_WRITE' ? 'READ_WRITE' : 'READ_ONLY';
      const existing = access.get(systemMemoryId);
      if (!existing || effective === 'READ_WRITE') {
        access.set(systemMemoryId, effective);
      }
    }

    for (const item of sub.agent.memoryItems) {
      // Effective access = min(subscription type, agent memory item role).
      // READ_ONLY subscription → always read-only regardless of agent role.
      // READ_WRITE + agent role "read"        → read-only.
      // READ_WRITE + agent role "read-write"  → read-write.
      const agentRole = item.role ?? 'read';
      const effective =
        sub.subscriptionType === 'READ_WRITE' && agentRole === 'read-write'
          ? 'READ_WRITE'
          : 'READ_ONLY';
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
      subscriptionType: sub.subscriptionType as 'READ_ONLY' | 'READ_WRITE',
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
 * Platform ADMINs and OWNERs bypass subscription checks.
 */
export async function canWriteToMemory(
  db: PrismaClient,
  auth: AuthContext,
  memoryId: string,
): Promise<boolean> {
  if (auth.roles?.includes('ADMIN') || auth.roles?.includes('OWNER')) return true;
  if (!auth.appId) return false;

  const access = await getMemoryAccess(db, auth);
  return access.get(memoryId) === 'READ_WRITE';
}

/**
 * Get the set of memory IDs the caller can see.
 * Returns null to mean "all" (for ADMIN/OWNER).
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
