/**
 * cor:acl:080:03 — the Agent-PUBLIC congruence invariant.
 *
 * An Agent may be `visibility = PUBLIC` only when every memory in its COVERED
 * SET is itself `visibility = PUBLIC`. The covered set is the memories linked
 * via an ACTIVE `AgentMemoryItem`, EXCLUDING memories that can never be part of
 * an agent's public surface:
 *   - per-user personal/private (`class IN ('personal','private')`) — owner-only
 *     by class, never PUBLIC;
 *   - app-scoped (`appId != null`) — App-internal even at `visibility=PUBLIC`
 *     (#653: `effectiveAccess` blocks public read via `!isAppScopedShared`), so
 *     it is never publicly readable regardless of its visibility value.
 * The agent's system memory is `class='system'` (visibility is always NULL —
 * `chk_memory_visibility_class`) and is governed by its class, NOT this check;
 * it is linked via `Agent.systemMemoryId`, never `AgentMemoryItem`.
 *
 * Enforced at WRITE time on both sides so a read may trust `Agent.visibility ===
 * PUBLIC` alone (Phase-3 `hasPublicResources`) without walking the agent's
 * memories:
 *   - setting an agent PUBLIC (updateAgent),
 *   - un-PUBLIC-ing a covered memory linked to a PUBLIC agent (updateMemory),
 *   - linking a covered non-PUBLIC memory to a PUBLIC agent (addMemoryToAgent).
 */
import { GraphQLError } from 'graphql';
import type { PrismaClient, Prisma } from '../generated/prisma/index.js';

type Db = PrismaClient | Prisma.TransactionClient;

const badInput = (message: string) =>
  new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });

/** True when a memory is excluded from the covered set (never publicly readable). */
function isExcludedFromCoveredSet(memory: { class: string; appId: string | null }): boolean {
  return memory.class === 'personal' || memory.class === 'private' || memory.appId != null;
}

/**
 * The agent's covered-set memories that would VIOLATE congruence — active
 * `AgentMemoryItem` links to non-excluded memories that are not PUBLIC.
 */
export async function nonPublicLinkedMemories(
  db: Db,
  agentId: string,
): Promise<{ id: string; name: string }[]> {
  return db.memory.findMany({
    where: {
      deletedAt: null,
      class: { notIn: ['personal', 'private'] }, // per-user owner-only: excluded
      appId: null, // app-scoped: App-internal even if PUBLIC (#653) — excluded
      visibility: { not: 'PUBLIC' },
      agentItems: { some: { agentId, deletedAt: null } },
    },
    select: { id: true, name: true },
  });
}

/**
 * Guard for setting an agent PUBLIC: reject if any covered-set memory is not
 * PUBLIC. Call before persisting `visibility = PUBLIC`.
 */
export async function assertAgentPublicAllowed(db: Db, agentId: string): Promise<void> {
  // #1349 (@codex, PR #1357) — the WRITE half of congruence. A PUBLIC agent's
  // audience is every org that installs it, and PUBLIC is a READ audience, so a
  // `read-write` item would hand each installer the write cap on the
  // publisher's own memory. Checked here as well as at attach time, because
  // either side can move: an agent with read-write knowledge must not become
  // PUBLIC, just as a PUBLIC agent must not be given read-write knowledge.
  const writable = await db.agentMemoryItem.findMany({
    where: { agentId, deletedAt: null, role: 'read-write' },
    select: { memory: { select: { name: true } } },
  });
  if (writable.length > 0) {
    const names = writable.map((w: { memory: { name: string } }) => w.memory.name).join(', ');
    throw badInput(
      `Cannot make this agent PUBLIC: it holds read-write knowledge (${names}). ` +
        `A PUBLIC agent may hold read-only knowledge only — every organization that ` +
        `installs it would receive that write access. Downgrade the link to read, or ` +
        `unlink it first (cor:acl:080:03).`,
    );
  }
  const bad = await nonPublicLinkedMemories(db, agentId);
  if (bad.length === 0) return;
  const names = bad.map((m) => m.name).join(', ');
  throw badInput(
    `Cannot make this agent PUBLIC: it links ${bad.length} non-public ` +
      `memor${bad.length === 1 ? 'y' : 'ies'} (${names}). Make ${bad.length === 1 ? 'it' : 'them'} ` +
      `PUBLIC first, or unlink — a PUBLIC agent may reference only PUBLIC knowledge (cor:acl:080:03).`,
  );
}

/**
 * Guard for the reverse side (un-PUBLIC-ing a memory): reject if a COVERED
 * memory whose visibility is about to become non-PUBLIC is linked to any PUBLIC
 * agent. Excluded memories (per-user, app-scoped) never block. Pass the memory
 * row (class + appId) and its INTENDED next visibility.
 */
export async function assertMemoryVisibilityChangeAllowed(
  db: Db,
  memory: { id: string; class: string; appId: string | null },
  nextVisibility: string | null | undefined,
): Promise<void> {
  if (isExcludedFromCoveredSet(memory)) return; // not part of any public surface
  if (nextVisibility === 'PUBLIC') return; // still public — congruence preserved
  const publicAgent = await db.agent.findFirst({
    where: {
      deletedAt: null,
      visibility: 'PUBLIC',
      memoryItems: { some: { memoryId: memory.id, deletedAt: null } },
    },
    select: { name: true },
  });
  if (publicAgent) {
    throw badInput(
      `Cannot make this memory non-public: it is knowledge of the PUBLIC agent ` +
        `"${publicAgent.name}". Make the agent non-public first, or unlink the memory ` +
        `(cor:acl:080:03).`,
    );
  }
}

/**
 * Narrowing a memory out of PUBLIC revokes the FOREIGN-tenant agent links that
 * only PUBLIC ever justified (#1349, @codex on PR #1357).
 *
 * `requireAgentMemoryGrant` lets another tenant attach a PUBLIC memory
 * read-only, because a public audience is exactly what PUBLIC means. That
 * permission is evaluated once, at attach time — so when the owner later makes
 * the memory ORGANIZATION-visible, every access fold keeps trusting the stored
 * row and the foreign App keeps reading nodes that are no longer public.
 * Measured before this sweep: a foreign App key read the content unchanged
 * after the owner narrowed it.
 *
 * The owner's change WINS rather than being blocked: refusing the narrowing
 * would hand a foreign tenant a veto over the publisher's own visibility
 * setting. (That is why this is not simply another clause in
 * `assertMemoryVisibilityChangeAllowed`, whose PUBLIC-agent rule is a genuine
 * refusal.) Same-tenant links are untouched — they never depended on PUBLIC.
 *
 * Soft-delete, not hard: the row is an audit record of a grant that once
 * existed, and `addMemoryToAgent` resurrects it if the memory becomes PUBLIC
 * again and someone re-attaches deliberately.
 */
export async function revokeForeignLinksOnVisibilityNarrowing(
  db: Db,
  memory: { id: string; organizationId: string | null; ownerUserId: string | null },
  nextVisibility: string | null | undefined,
  actor: string | null,
): Promise<number> {
  if (nextVisibility === 'PUBLIC') return 0;
  const links = await db.agentMemoryItem.findMany({
    where: { memoryId: memory.id, deletedAt: null },
    select: { id: true, agent: { select: { organizationId: true, ownerUserId: true } } },
  });
  const foreign = links.filter((l: { agent: { organizationId: string | null; ownerUserId: string | null } }) => {
    const sameTenant =
      (l.agent.organizationId != null && l.agent.organizationId === memory.organizationId) ||
      (l.agent.ownerUserId != null && l.agent.ownerUserId === memory.ownerUserId);
    return !sameTenant;
  });
  if (foreign.length === 0) return 0;
  const result = await db.agentMemoryItem.updateMany({
    where: { id: { in: foreign.map((f: { id: string }) => f.id) }, deletedAt: null },
    data: { deletedAt: new Date(), deletedBy: actor },
  });
  return result.count;
}

/**
 * Guard for linking a memory to an agent: reject if the target agent is PUBLIC
 * and the memory is a COVERED, non-PUBLIC memory. Excluded memories (per-user,
 * app-scoped) may always be linked. `memory` is the row being linked.
 */
export async function assertLinkAllowedForPublicAgent(
  agentVisibility: string | null,
  memory: { class: string; appId: string | null; visibility: string | null },
): Promise<void> {
  if (agentVisibility !== 'PUBLIC') return;
  if (isExcludedFromCoveredSet(memory)) return; // per-user / app-scoped: allowed
  if (memory.visibility === 'PUBLIC') return;
  throw badInput(
    `Cannot link a non-public memory to a PUBLIC agent — a PUBLIC agent may ` +
      `reference only PUBLIC knowledge. Make the memory PUBLIC first, or make the ` +
      `agent non-public (cor:acl:080:03).`,
  );
}
