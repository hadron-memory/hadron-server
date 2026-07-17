/**
 * `mergeUsers` re-own of owner-namespaced resources (issue #695,
 * D-2026-07-15-004) — the "sneaky bulk" materialization site.
 *
 * When two accounts merge, the surviving (target) user must inherit the
 * source's spec-047 owner-owned App / Agent / Memory rows. Those rows carry an
 * `@<handle>`-rooted URN (`@source:notes`), so inheriting them re-roots the URN
 * onto the target's handle (`@target:notes`). If the target already owns a
 * resource with that slug, re-rooting would collide on the globally-unique
 * `urn` index — so the LOSER (source) side gets a **locally minted,
 * deterministic, author-derived alias** via {@link mintLocalSlug}
 * (`@target:notes-source`), never a silent overwrite of the target's resource.
 *
 * This is the merge-time analogue of {@link renameOwnerNamespacedUrns}: same
 * three URN tables, same durable-node-URN (`entry_node_urn`) rewrite. It differs
 * in three ways: (a) ownership moves (`owner_user_id` source → target) rather
 * than staying put; (b) a live-collision RE-MINTS the slug instead of failing
 * the whole operation closed — a merge must always complete; and (c) the
 * soft-deleted-holder reclaim is SURGICAL (one exact URN at a time), not
 * namespace-wide as in the rename — the merge target's `@handle:` namespace is
 * a live, populated account that legitimately holds unrelated tombstoned rows,
 * which a blanket `starts_with(urn, '@target:')` delete would destroy (with a
 * `nodes.memory_id` cascade behind it).
 *
 * Node *content* references to a re-rooted memory URN are deliberately NOT
 * rewritten here (matching `renameOwnerNamespacedUrns`): node/edge URNs are
 * composed on read from the parent memory URN, so they self-heal, and legacy
 * textual refs are covered by the accept-forever promise (#239) and the coming
 * stored alias map (#697). Runs inside the caller's `mergeUsers` transaction.
 */

import type { Prisma } from '../generated/prisma/index.js';
import { mintLocalSlug } from './mintLocalSlug.js';

export interface MergeOwnerUrnsArgs {
  sourceUserId: string;
  targetUserId: string;
  /** The surviving user's live handle — the new owner root (no `@`). */
  targetHandle: string;
  /**
   * The source user's ORIGINAL handle (captured before `mergeUsers` releases
   * it), used as the author root for deterministic re-mint disambiguation. Null
   * for a legacy source with no URN-legal handle — the target root then seeds
   * the (rare) disambiguator instead.
   */
  sourceHandle: string | null;
}

/** Strip the `@<handle>` root off an owner URN, returning the trailing slug. */
function slugOf(urn: string): string {
  const colon = urn.indexOf(':');
  return colon >= 0 ? urn.slice(colon + 1) : urn;
}

/**
 * The canonical (`@handle::slug`) spelling of a stored (`@handle:slug`) memory
 * URN — the form a memory URN takes INSIDE a fully-qualified node URN
 * (`@handle::slug::loc`), where `::` separates the handle→memory and
 * memory→loc boundaries. `Memory.urn` is stored with a single colon; node URNs
 * double the first one. Mirrors `memoryUrnForms` in cloneMemory.
 */
function canonicalMemoryUrn(storedUrn: string): string {
  const colon = storedUrn.indexOf(':');
  return colon === -1 ? storedUrn : `${storedUrn.slice(0, colon)}::${storedUrn.slice(colon + 1)}`;
}

/**
 * Re-own and re-root the source user's owner-namespaced App / Agent / Memory
 * rows onto the target's handle, re-minting any slug that would collide with a
 * live target resource, and rewrite durable node-URN references accordingly.
 */
export async function mergeOwnerNamespacedUrns(
  tx: Prisma.TransactionClient,
  { sourceUserId, targetUserId, targetHandle, sourceHandle }: MergeOwnerUrnsArgs,
): Promise<void> {
  const newRoot = `@${targetHandle}`;
  const authorRoot = sourceHandle ? `@${sourceHandle}` : newRoot;

  // ── Memories ─────────────────────────────────────────────────────────────
  // Re-root each live owned memory, re-minting on a live collision, and record
  // old→new so the entry_node_urn rewrite below is precise even under a re-mint.
  const mems = await tx.memory.findMany({
    where: { ownerUserId: sourceUserId, deletedAt: null },
    select: { id: true, urn: true },
  });
  const memRemap: Array<readonly [string, string]> = [];
  for (const m of mems) {
    const { urn: newUrn } = await mintLocalSlug({
      root: newRoot,
      desiredSlug: slugOf(m.urn),
      authorRoot,
      isTaken: (u) =>
        tx.memory.findFirst({ where: { urn: u, deletedAt: null }, select: { id: true } }).then(Boolean),
    });
    // Reclaim ONLY a soft-deleted holder sitting at this EXACT target URN. The
    // `memories_urn_key` unique spans tombstones (not partial on deleted_at), so
    // a dead row here would abort the re-root — but scoping the delete to the
    // one claimed URN never touches an unrelated tombstoned resource elsewhere
    // in the target's namespace (mint already routed past every live holder).
    await tx.memory.deleteMany({ where: { urn: newUrn, deletedAt: { not: null } } });
    await tx.memory.update({
      where: { id: m.id },
      data: { urn: newUrn, ownerUserId: targetUserId },
    });
    memRemap.push([m.urn, newUrn]);
  }

  // ── Agents ───────────────────────────────────────────────────────────────
  const agents = await tx.agent.findMany({
    where: { ownerUserId: sourceUserId, deletedAt: null },
    select: { id: true, urn: true },
  });
  for (const a of agents) {
    const { urn: newUrn } = await mintLocalSlug({
      root: newRoot,
      desiredSlug: slugOf(a.urn),
      authorRoot,
      isTaken: (u) =>
        tx.agent.findFirst({ where: { urn: u, deletedAt: null }, select: { id: true } }).then(Boolean),
    });
    // Surgical reclaim of a soft-deleted holder at this exact URN — see the
    // memory loop above (agents.urn is likewise a full unique over tombstones).
    await tx.agent.deleteMany({ where: { urn: newUrn, deletedAt: { not: null } } });
    await tx.agent.update({
      where: { id: a.id },
      data: { urn: newUrn, ownerUserId: targetUserId },
    });
  }

  // ── Apps ─────────────────────────────────────────────────────────────────
  // Liveness for the urn clash is the partial-unique predicate `uninstalled_at
  // IS NULL`, not deleted_at.
  const apps = await tx.app.findMany({
    where: { ownerUserId: sourceUserId, uninstalledAt: null },
    select: { id: true, urn: true },
  });
  for (const app of apps) {
    const { urn: newUrn } = await mintLocalSlug({
      root: newRoot,
      desiredSlug: slugOf(app.urn),
      authorRoot,
      isTaken: (u) =>
        tx.app.findFirst({ where: { urn: u, uninstalledAt: null }, select: { id: true } }).then(Boolean),
    });
    await tx.app.update({
      where: { id: app.id },
      data: { urn: newUrn, ownerUserId: targetUserId },
    });
  }

  // Move ownership of any REMAINING owned rows (soft-deleted memories/agents,
  // uninstalled apps) so nothing dangles on the tombstoned source user. Their
  // URN is left as-is — a dead row holds no live namespace to re-root.
  await tx.memory.updateMany({ where: { ownerUserId: sourceUserId }, data: { ownerUserId: targetUserId } });
  await tx.agent.updateMany({ where: { ownerUserId: sourceUserId }, data: { ownerUserId: targetUserId } });
  await tx.app.updateMany({ where: { ownerUserId: sourceUserId }, data: { ownerUserId: targetUserId } });

  // ── Durable node-URN references (spec 040) ─────────────────────────────────
  // AgentSchedule / AgentWebhook / WebFetchPollBinding store a fully-qualified
  // `entry_node_urn` that embeds a memory URN in its CANONICAL form as
  // `@handle::mem-slug::<loc>`. Rewrite each re-rooted memory's refs precisely
  // (full old→new memory URN), which stays correct even when the slug was
  // re-minted — unlike renameOwnerNamespacedUrns' blanket `@old::`→`@new::`
  // prefix swap, which assumes the mem-slug is unchanged.
  for (const [oldUrn, newUrn] of memRemap) {
    if (oldUrn === newUrn) continue;
    const oldBoundary = `${canonicalMemoryUrn(oldUrn)}::`;
    const newBoundary = `${canonicalMemoryUrn(newUrn)}::`;
    await tx.$executeRaw`
      UPDATE agent_schedules SET entry_node_urn = replace(entry_node_urn, ${oldBoundary}, ${newBoundary})
      WHERE strpos(entry_node_urn, ${oldBoundary}) > 0`;
    await tx.$executeRaw`
      UPDATE agent_webhooks SET entry_node_urn = replace(entry_node_urn, ${oldBoundary}, ${newBoundary})
      WHERE strpos(entry_node_urn, ${oldBoundary}) > 0`;
    await tx.$executeRaw`
      UPDATE webfetch_poll_bindings SET entry_node_urn = replace(entry_node_urn, ${oldBoundary}, ${newBoundary})
      WHERE strpos(entry_node_urn, ${oldBoundary}) > 0`;
  }
}
