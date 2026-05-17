/**
 * AppAgent helpers — spec 023-app-shape Phase 2b.
 *
 * After spec 023 dropped `App.agentId` in favor of the N:M `AppAgent`
 * join, code that previously read "the App's Agent" needs a new path.
 * Until US1's `installAgentIntoApp` ships the multi-Agent UI flows,
 * each App still has exactly one installed Agent in practice — the
 * defensive backfill in `20260517004132_023_drop_app_agent_id` made
 * sure of that for existing rows.
 *
 * These helpers wrap the lookup so callers don't reach into the join
 * table directly:
 *
 *   - `getPrimaryAgentId(db, appId)` — returns the first installed
 *     Agent's id, or null if the App has no Agents installed.
 *   - `getPrimaryAgent(db, appId, args?)` — returns the first
 *     installed Agent record with optional `include`.
 *
 * "Primary" is a v1 convenience: there is no business concept of a
 * "primary" Agent yet. Multi-Agent semantics (returning a list, or
 * resolving by URN from the request context) ship with the US1
 * resolvers in their own PR. Callers that need the full list should
 * use `db.appAgent.findMany({ where: { appId } })` directly.
 */

import type { Agent, PrismaClient, Prisma } from '../generated/prisma/index.js';

export async function getPrimaryAgentId(
  db: PrismaClient,
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
): Promise<Agent | null> {
  const agentId = await getPrimaryAgentId(db, appId);
  if (agentId === null) return null;
  return db.agent.findUnique({
    where: { id: agentId },
    include: args?.include,
  });
}

/**
 * Check whether a specific Agent is installed in an App. Fast PK lookup.
 */
export async function isAgentInstalled(
  db: PrismaClient,
  appId: string,
  agentId: string,
): Promise<boolean> {
  const row = await db.appAgent.findUnique({
    where: { appId_agentId: { appId, agentId } },
    select: { appId: true },
  });
  return row !== null;
}
