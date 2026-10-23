import { withIncludeHistoryClientTransaction } from './includes/includeHistoryFence.js';
/**
 * Agent ↔ system-memory tenancy (#949).
 *
 * Every Agent owns a `class='system'` memory (`cor:dmo:050:01`), and that
 * memory MUST share the Agent's owner — org XOR user (`chk_agent_owner_xor` /
 * `chk_memory_owner_xor`). A mismatch is a cross-tenant leak, not a cosmetic
 * URN quirk: access to a memory follows the MEMORY's owner, so a foreign-owned
 * system memory puts one tenant's Agent design (and, for a Team Agent, its
 * `roles:<role>` definitions and name registers — `cor:agt:020:01`) inside
 * another tenant's read/write audience.
 *
 * This module is the one place that:
 *   1. states the invariant (`sameOwner` / `assertSystemMemoryOwner`), so the
 *      two write paths (`createAgentCore`'s promote branch and `updateAgent`'s
 *      first-attach branch) can't drift apart;
 *   2. finds rows that already violate it (`findSystemMemoryOwnerMismatches`);
 *   3. repairs one (`repairAgentSystemMemoryOwner`) — the supported recovery
 *      that #949 lacked, where the only option was to recreate the Agent.
 *
 * Why an owner COMPARISON needs a helper at all: spec 047 added `ownerUserId`
 * as a second tenancy axis, so a bare `a.organizationId !== b.organizationId`
 * reads `null !== null` ⇒ false for two DIFFERENT users' entities and admits
 * exactly the cross-tenant case it exists to block
 * (findings:org-xor-owner-null-comparison-bypass). Branch on the ownership
 * CLASS first, then apply that class's rule.
 */
import { GraphQLError } from 'graphql';
import type { Prisma, PrismaClient } from '../generated/prisma/index.js';
import { recordUrnRename } from './urnAlias.js';
import { reclaimTombstonedMemory } from './mintedSpecPermanence.js';

/** The owner columns every tenanted row carries (exactly one is non-null). */
export interface OwnerColumns {
  organizationId: string | null;
  ownerUserId: string | null;
}

/**
 * Do these two rows have the SAME owner? Class-first: a user-owned subject is
 * matched only by the same user, an org-owned subject only by the same org.
 * An ownerless row (both columns null — unreachable while the XOR CHECKs hold)
 * matches nothing, so a broken row fails closed rather than matching another
 * broken row.
 */
export function sameOwner(a: OwnerColumns, b: OwnerColumns): boolean {
  if (a.ownerUserId !== null) {
    return b.ownerUserId === a.ownerUserId && b.organizationId === null;
  }
  if (a.organizationId !== null) {
    return b.organizationId === a.organizationId && b.ownerUserId === null;
  }
  return false;
}

/** Human-readable owner for error messages / audit output. */
export function describeOwner(o: OwnerColumns): string {
  if (o.ownerUserId !== null) return `user ${o.ownerUserId}`;
  if (o.organizationId !== null) return `org ${o.organizationId}`;
  return 'no owner';
}

/**
 * Typed refusal for an attempted Agent↔system-memory owner mismatch. Extends
 * `GraphQLError` so `extensions.code` survives Apollo's formatter (a bare
 * `Error` would reach the client as INTERNAL_SERVER_ERROR).
 */
export class SystemMemoryOwnerMismatchError extends GraphQLError {
  constructor(agent: OwnerColumns, memory: OwnerColumns & { id?: string }) {
    super(
      `A system memory must have the same owner as its agent — the agent is owned by ${describeOwner(agent)}, the memory by ${describeOwner(memory)}.`,
      {
        extensions: {
          code: 'SYSTEM_MEMORY_OWNER_MISMATCH',
          ...(memory.id ? { memoryId: memory.id } : {}),
        },
      },
    );
    this.name = 'SystemMemoryOwnerMismatchError';
  }
}

/** Throwing form of {@link sameOwner} for the two system-memory write paths. */
export function assertSystemMemoryOwner(
  agent: OwnerColumns,
  memory: OwnerColumns & { id?: string },
): void {
  if (!sameOwner(agent, memory)) throw new SystemMemoryOwnerMismatchError(agent, memory);
}

/**
 * #2044 (Andi P2-1): an App's INSTALL MEMORY is `class='system'` but never an
 * Agent's brain. Promoting it would put an App-only compile override into
 * ordinary inheritance (cor:agt:040:16, #1840) and let deleting the "Agent"
 * tombstone the App's customisation. Both promotion doors (createAgent's
 * `systemMemoryId`, updateAgent's first attach and its locked recheck) ask this.
 */
export function assertNotInstallMemory(memory: { installOfAgentId?: string | null; isInstallMemory?: boolean; appId?: string | null }): void {
  if (memory.isInstallMemory || memory.installOfAgentId || memory.appId) {
    throw new GraphQLError(
      "An App's install memory cannot be an Agent's system memory.",
      { extensions: { code: 'BAD_USER_INPUT' } },
    );
  }
}

/** One agent whose system memory is owned by somebody else. */
export interface SystemMemoryOwnerMismatch {
  agentId: string;
  agentUrn: string;
  agentName: string;
  agentOrganizationId: string | null;
  agentOwnerUserId: string | null;
  memoryId: string;
  memoryUrn: string;
  memoryOrganizationId: string | null;
  memoryOwnerUserId: string | null;
}

/**
 * Audit: every LIVE agent whose system memory is owned by a different tenant.
 * `Agent.systemMemoryId` carries no FK (see deleteUser.ts), so this is two
 * queries rather than a join — and a DANGLING pointer (no memory row at all)
 * is reported too, with the memory owner columns left null.
 */
export async function findSystemMemoryOwnerMismatches(
  db: PrismaClient,
): Promise<SystemMemoryOwnerMismatch[]> {
  const agents = await db.agent.findMany({
    where: { deletedAt: null, systemMemoryId: { not: null } },
    select: {
      id: true,
      urn: true,
      name: true,
      organizationId: true,
      ownerUserId: true,
      systemMemoryId: true,
    },
    orderBy: { createdAt: 'asc' },
  });
  if (agents.length === 0) return [];
  const memories = await db.memory.findMany({
    where: { id: { in: agents.map((a) => a.systemMemoryId!) } },
    select: { id: true, urn: true, organizationId: true, ownerUserId: true },
  });
  const byId = new Map(memories.map((m) => [m.id, m]));

  const out: SystemMemoryOwnerMismatch[] = [];
  for (const agent of agents) {
    const memory = byId.get(agent.systemMemoryId!);
    if (memory && sameOwner(agent, memory)) continue;
    out.push({
      agentId: agent.id,
      agentUrn: agent.urn,
      agentName: agent.name,
      agentOrganizationId: agent.organizationId,
      agentOwnerUserId: agent.ownerUserId,
      memoryId: agent.systemMemoryId!,
      memoryUrn: memory?.urn ?? '(missing)',
      memoryOrganizationId: memory?.organizationId ?? null,
      memoryOwnerUserId: memory?.ownerUserId ?? null,
    });
  }
  return out;
}

/** Outcome of a repair attempt on one agent. */
export interface SystemMemoryRepairResult {
  agentId: string;
  agentUrn: string;
  memoryId: string;
  /** False when the pair was already consistent (the idempotent no-op). */
  changed: boolean;
  /** Owner the memory now carries, described for logging. */
  owner: string;
  /** URN the memory now carries. */
  urn: string;
  /** Set when the derived URN was NOT taken because something else holds it. */
  urnNote?: string;
}

/**
 * Re-own an agent's system memory to the agent's OWN owner — the supported
 * repair for a row that predates the invariant above (#949). Idempotent: an
 * already-consistent pair is a no-op.
 *
 * Two writes, one transaction:
 *   - owner columns ⇒ the agent's (org XOR user), which is the actual leak;
 *   - urn ⇒ `${agent.urn}-system`, the shape auto-provisioning derives, so the
 *     memory stops advertising the foreign root. A soft-deleted holder of that
 *     URN is hard-deleted first (the createAgentCore reclaim pattern); a LIVE
 *     holder means somebody else legitimately owns the name, so the owner move
 *     still happens and the URN is left alone with a note — a stale URN is
 *     cosmetic, the ownership is not.
 *
 * NOT authorization — the caller gates. Moving a memory OUT of an org is a
 * cross-tenant act, so the GraphQL surface restricts it to platform admins.
 */
export async function repairAgentSystemMemoryOwner(
  db: PrismaClient,
  agentId: string,
  opts: {
    actorId?: string | null;
    /** Public callers recheck current authority inside the prepared repair root. */
    authorize?: (tx: Prisma.TransactionClient, selected: OwnerColumns & { id: string; systemMemoryId: string | null }) => Promise<void>;
  } = {},
): Promise<SystemMemoryRepairResult> {
  const agent = await db.agent.findUniqueOrThrow({
    where: { id: agentId },
    select: { id: true, urn: true, organizationId: true, ownerUserId: true, systemMemoryId: true },
  });
  if (!agent.systemMemoryId) {
    throw new GraphQLError(
      `Agent ${agent.urn} has no system memory, so there is nothing to repair.`,
      { extensions: { code: 'AGENT_HAS_NO_SYSTEM_MEMORY', agentId: agent.id } },
    );
  }
  const memory = await db.memory.findUnique({
    where: { id: agent.systemMemoryId },
    select: { id: true, urn: true, organizationId: true, ownerUserId: true },
  });
  if (!memory) {
    throw new GraphQLError(
      `Agent ${agent.urn} points at system memory ${agent.systemMemoryId}, which does not exist.`,
      { extensions: { code: 'SYSTEM_MEMORY_NOT_FOUND', agentId: agent.id } },
    );
  }
  if (sameOwner(agent, memory)) {
    return {
      agentId: agent.id,
      agentUrn: agent.urn,
      memoryId: memory.id,
      changed: false,
      owner: describeOwner(memory),
      urn: memory.urn,
    };
  }

  const derivedUrn = `${agent.urn}-system`;
  const actor = opts.actorId ?? null;
  return withIncludeHistoryClientTransaction(db, async (tx) => {
    await opts.authorize?.(tx, agent);
    const currentAgent = await tx.agent.findUnique({ where: { id: agentId }, select: { urn: true, organizationId: true, ownerUserId: true, systemMemoryId: true } });
    const currentMemory = await tx.memory.findUnique({ where: { id: memory.id }, select: { urn: true, organizationId: true, ownerUserId: true } });
    if (!currentAgent || !sameOwner(agent, currentAgent) || currentAgent.systemMemoryId !== agent.systemMemoryId || currentAgent.urn !== agent.urn ||
        !currentMemory || currentMemory.urn !== memory.urn || !sameOwner(memory, currentMemory)) {
      throw new GraphQLError('Agent repair scope changed; retry.', { extensions: { code: 'MEMORY_WRITE_CONFLICT' } });
    }
    let urn = memory.urn;
    let urnNote: string | undefined;
    if (memory.urn !== derivedUrn) {
      const holder = await tx.memory.findUnique({
        where: { urn: derivedUrn },
        select: { id: true, deletedAt: true },
      });
      // #1468 — reclaim through the shared guard: a deleted mint-stamped
      // corpus holding a protected spec refuses. A holder revived since the
      // read above stays, and is reported like any live holder.
      const reclaimed = !!holder?.deletedAt && await reclaimTombstonedMemory(tx, holder.id);
      if (holder && !reclaimed) {
        urnNote = `URN left as "${memory.urn}" — "${derivedUrn}" is held by live memory ${holder.id}.`;
      } else {
        urn = derivedUrn;
      }
    }
    // #1079 (PR #1080 third review, Codex P2) — this repair can REPLACE the
    // memory's urn, which is a rename and owes an alias. Without one the repair
    // silently 404s every node and edge URN published under that system memory.
    // Same transaction as the update, so the two cannot diverge.
    if (urn && urn !== memory.urn) {
      await recordUrnRename(tx, {
        entityType: 'MEMORY',
        entityId: memory.id,
        oldUrn: memory.urn,
        newUrn: urn,
        createdBy: actor ?? null,
      });
    }
    const updated = await tx.memory.update({
      where: { id: memory.id },
      data: {
        organizationId: agent.organizationId,
        ownerUserId: agent.ownerUserId,
        urn,
        updatedBy: actor,
      },
      select: { id: true, urn: true, organizationId: true, ownerUserId: true },
    });
    return {
      agentId: agent.id,
      agentUrn: agent.urn,
      memoryId: updated.id,
      changed: true,
      owner: describeOwner(updated),
      urn: updated.urn,
      ...(urnNote ? { urnNote } : {}),
    };
  });
}
