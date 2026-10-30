/**
 * #1885 — an Agent may extend one base Agent (cor:dmo:050:14).
 *
 * An Agent names at most one base in `Agent.extendsAgentId` and inherits its
 * base chain's system-memory nodes. This module is the ONLY writer of that
 * field. Every change goes through {@link writeAgentBase}, which checks the
 * grant, refuses a cycle and a chain longer than {@link AGENT_BASE_CHAIN_CAP},
 * and only then writes. Who may make the change (whoever manages the child,
 * cor:dmo:050:13) is the caller's to decide before calling.
 *
 * CONCURRENCY: one lock protocol for every writer of the graph.
 *
 *   1. the graph lock ({@link lockAgentBaseGraph}), exclusive, platform-wide.
 *      Two changes on disjoint rows could each pass the checks and together
 *      close a cycle (A → B while B → A) or build a chain of 5, so the checks
 *      and the write run under one lock. Bases change rarely, so one key for
 *      the whole platform costs nothing worth partitioning for.
 *   2. the child's row, FOR UPDATE: it must be live, and its value is read
 *      under the lock.
 *   3. the base's row, FOR SHARE: it must be live. Retiring an Agent takes its
 *      row FOR UPDATE before asking whether a live Agent still extends it
 *      (cor:dmo:050:14 ruling 5, with #1886's shared predicate), so a base
 *      being set and the same base being retired serialize in either order:
 *      whichever commits second sees the first.
 *
 * The database backstops all of it: `agent_base_guard`
 * (prisma/agent-base-invariants.sql) takes the same graph lock and refuses a
 * retired base, a cycle and an over-long chain for any write that bypasses
 * this module.
 */

import { GraphQLError } from 'graphql';
import type { Prisma, PrismaClient } from '../generated/prisma/index.js';
import { AgentNotFoundError } from './entityRef/errors.js';
import { planOrgAgentInstallGrant } from './auth/orgAgentInstallLicense.js';
import { ensureAgentOrgGrant } from '../controller/operations/ensureAgentOrgGrant.js';
import { hasActiveAgentInstallLicense } from './appAgent.js';

type Tx = Prisma.TransactionClient;
type Db = Pick<PrismaClient, '$queryRaw'> | Tx;

/** At most this many Agents in a chain, counting the Agent itself (cor:dmo:050:14). */
export const AGENT_BASE_CHAIN_CAP = 4;

/** Stops a walk through an already-corrupt chain; a valid chain is far shorter. */
const MAX_WALK = 8;

function refusal(code: string, message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code } });
}

/** The platform-wide base-graph lock (see the module header). Re-entrant within a transaction. */
export async function lockAgentBaseGraph(tx: Tx): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('agent-extends-base'))`;
}

/**
 * The Agents above `agentId`, nearest first: its base, its base's base, and so
 * on. Excludes `agentId` itself.
 */
export async function agentBaseChain(db: Db, agentId: string): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    WITH RECURSIVE up(id, depth) AS (
      SELECT extends_agent_id, 1 FROM agents WHERE id = ${agentId} AND extends_agent_id IS NOT NULL
      UNION ALL
      SELECT a.extends_agent_id, up.depth + 1 FROM agents a JOIN up ON a.id = up.id
      WHERE a.extends_agent_id IS NOT NULL AND up.depth < ${MAX_WALK}
    )
    SELECT id FROM up ORDER BY depth`;
  return rows.map((r) => r.id);
}

/**
 * `agentBaseChain` for many roots at once (#2608, Atilla's BLIND P2): one
 * recursive walk seeded with every root, chains kept apart by the root column.
 * Same edges, same MAX_WALK, same nearest-first order per root as the
 * singular — a roster's worth of per-agent walks becomes one statement.
 */
export async function agentBaseChains(db: Db, agentIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>(agentIds.map((id) => [id, []]));
  if (!agentIds.length) return out;
  const rows = await db.$queryRaw<Array<{ root: string; id: string }>>`
    WITH RECURSIVE up(root, id, depth) AS (
      SELECT a.id, a.extends_agent_id, 1 FROM agents a
      WHERE a.id = ANY(${agentIds}::text[]) AND a.extends_agent_id IS NOT NULL
      UNION ALL
      SELECT up.root, a.extends_agent_id, up.depth + 1 FROM agents a JOIN up ON a.id = up.id
      WHERE a.extends_agent_id IS NOT NULL AND up.depth < ${MAX_WALK}
    )
    SELECT root, id FROM up ORDER BY root, depth`;
  for (const r of rows) {
    const chain = out.get(r.root);
    if (chain) chain.push(r.id);
  }
  return out;
}

/**
 * The longest run of live Agents below `agentId`: 0 when no live Agent
 * extends it, 1 when only direct children do, and so on.
 */
export async function agentBaseHeightBelow(db: Db, agentId: string): Promise<number> {
  const rows = await db.$queryRaw<Array<{ below: number }>>`
    WITH RECURSIVE down(id, depth) AS (
      SELECT id, 1 FROM agents WHERE extends_agent_id = ${agentId} AND deleted_at IS NULL
      UNION ALL
      SELECT a.id, down.depth + 1 FROM agents a JOIN down ON a.extends_agent_id = down.id
      WHERE a.deleted_at IS NULL AND down.depth < ${MAX_WALK}
    )
    SELECT coalesce(max(depth), 0)::int AS below FROM down`;
  return rows[0]?.below ?? 0;
}

type AgentOwner = { id: string; organizationId: string | null; ownerUserId: string | null };

/**
 * May `child`'s owner extend `base`? The grant a cross-organisation include
 * needs (cor:dmo:050:14 ruling 3, by way of cor:agt:040:08):
 *
 * - an org-owned child: the org's active AgentOrgGrant for the base. A
 *   same-org base provisions a missing grant here, never reactivating a
 *   revoked one; another org's base needs the grant already (a subscription,
 *   which only a PUBLIC Agent allows). Shared with installs through
 *   `planOrgAgentInstallGrant`, so the two gates can't drift.
 * - a user-owned child: its own owner's Agents need nothing; any other base
 *   needs the owner's active AgentSubscription, the stand-in for the grant.
 *
 * A base the caller holds no licence to and couldn't subscribe to (not
 * PUBLIC) is concealed as not found.
 */
async function authorizeAgentBaseGrant(
  tx: Tx,
  child: AgentOwner,
  base: AgentOwner & { visibility: string },
  baseRef: string,
  createdBy: string | null,
): Promise<void> {
  if (child.organizationId !== null) {
    const provision = await planOrgAgentInstallGrant(tx, child.organizationId, base.id, baseRef);
    if (provision) await ensureAgentOrgGrant(tx, child.organizationId, base.id, { createdBy });
    return;
  }
  if (child.ownerUserId === null) throw new AgentNotFoundError(baseRef);
  if (base.ownerUserId === child.ownerUserId) return;
  if (await hasActiveAgentInstallLicense(tx, { organizationId: null, ownerUserId: child.ownerUserId }, base)) return;
  if (base.visibility === 'PUBLIC') {
    throw refusal('AGENT_SUBSCRIPTION_REQUIRED', 'Subscribe to the PUBLIC Agent before extending it.');
  }
  throw new AgentNotFoundError(baseRef);
}

export type AgentBaseChange = { agentId: string; from: string | null; to: string | null; changed: boolean };

/**
 * Set, change or clear `childId`'s base inside the caller's transaction. A
 * no-op (the value already) writes nothing and returns `changed: false`.
 * Refusals, each changing nothing:
 *
 * - `AGENT_NOT_FOUND`: the child or the base doesn't exist or is retired, or
 *   the base is concealed (see {@link authorizeAgentBaseGrant});
 * - `AGENT_ORG_GRANT_REQUIRED`, `AGENT_ORG_GRANT_INACTIVE`,
 *   `AGENT_SUBSCRIPTION_REQUIRED`: the child's owner holds no licence to the base;
 * - `AGENT_BASE_CYCLE`: the base is the child or one of its descendants;
 * - `AGENT_BASE_CHAIN_TOO_LONG`: a chain through the child, its own or any
 *   descendant's, would hold more than {@link AGENT_BASE_CHAIN_CAP} Agents.
 *
 * The grant is checked before the chain, so a refusal about the chain only
 * ever answers a caller licensed to the base.
 */
export async function writeAgentBase(
  tx: Tx,
  args: { childId: string; childRef: string; baseId: string | null; baseRef: string | null; createdBy: string | null },
): Promise<AgentBaseChange> {
  await lockAgentBaseGraph(tx);

  const [child] = await tx.$queryRaw<Array<{ id: string; organization_id: string | null; owner_user_id: string | null; extends_agent_id: string | null; deleted_at: Date | null }>>`
    SELECT id, organization_id, owner_user_id, extends_agent_id, deleted_at FROM agents WHERE id = ${args.childId} FOR UPDATE`;
  if (!child || child.deleted_at) throw new AgentNotFoundError(args.childRef);
  const from = child.extends_agent_id;
  if (from === args.baseId) return { agentId: child.id, from, to: from, changed: false };

  if (args.baseId !== null) {
    const baseRef = args.baseRef ?? args.baseId;
    const [base] = await tx.$queryRaw<Array<{ id: string; organization_id: string | null; owner_user_id: string | null; visibility: string; deleted_at: Date | null }>>`
      SELECT id, organization_id, owner_user_id, visibility::text AS visibility, deleted_at FROM agents WHERE id = ${args.baseId} FOR SHARE`;
    if (!base || base.deleted_at) throw new AgentNotFoundError(baseRef);

    await authorizeAgentBaseGrant(
      tx,
      { id: child.id, organizationId: child.organization_id, ownerUserId: child.owner_user_id },
      { id: base.id, organizationId: base.organization_id, ownerUserId: base.owner_user_id, visibility: base.visibility },
      baseRef,
      args.createdBy,
    );

    const above = [base.id, ...(await agentBaseChain(tx, base.id))];
    if (above.includes(child.id)) {
      throw refusal('AGENT_BASE_CYCLE', 'An Agent cannot extend itself or an Agent that extends it.');
    }
    const longest = (await agentBaseHeightBelow(tx, child.id)) + 1 + above.length;
    if (longest > AGENT_BASE_CHAIN_CAP) {
      throw refusal(
        'AGENT_BASE_CHAIN_TOO_LONG',
        `A chain of base Agents holds at most ${AGENT_BASE_CHAIN_CAP} Agents; this change would make one of ${longest}.`,
      );
    }
  }

  await tx.agent.update({ where: { id: child.id }, data: { extendsAgentId: args.baseId } });
  return { agentId: child.id, from, to: args.baseId, changed: true };
}
