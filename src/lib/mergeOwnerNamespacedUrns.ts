/**
 * `mergeUsers` re-own of owner-namespaced resources (issue #695,
 * D-2026-07-15-004) — the "sneaky bulk" materialization site.
 *
 * When two accounts merge, the surviving (target) user must inherit the
 * source's owner-owned App / Agent / Memory rows. Those rows carry a
 * handle-rooted URN (`source:notes` — v2 bare handle, no `@` sigil), so
 * inheriting them re-roots the URN onto the target's handle (`target:notes`). If
 * the target already owns a resource with that slug, re-rooting would collide on
 * the globally-unique `urn` index — so the LOSER (source) side gets a **locally
 * minted, deterministic, author-derived alias** via {@link mintLocalSlug}
 * (`target:notes-source`), never a silent overwrite of the target's resource.
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
 * textual refs to the old `@source:slug` are covered by the stored alias map
 * (#697) — each re-rooted row records its pre-merge URN in `legacyUrn`, so
 * `resolve{Memory,Agent,App}Ref` redirects an old reference to the re-owned row.
 * (Single-column caveat: a row later re-normalized by the #697 v2 backfill keeps
 * only its most-recent legacy form.) Runs inside the caller's `mergeUsers`
 * transaction.
 */

import type { Prisma } from '../generated/prisma/index.js';
import { mintLocalSlug } from './mintLocalSlug.js';
import { recordUrnRename } from './urnAlias.js';

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

/** Strip the root (everything up to the first colon) off an owner URN. */
function slugOf(urn: string): string {
  const colon = urn.indexOf(':');
  return colon >= 0 ? urn.slice(colon + 1) : urn;
}

/** Escape POSIX-regex metacharacters in a dynamic URN atom (a slug may legally
 *  contain `.`), keeping the `^`-anchored entry_node_urn rewrite precise. */
function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
  // #697 v2: user-owned roots are the BARE handle — no `@` sigil (the principal
  // pool makes handle/org names disjoint). Existing rows are already bare (the
  // Task A backfill dropped the sigil); creation mints bare too.
  const newRoot = targetHandle;
  const authorRoot = sourceHandle ?? newRoot;

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
      // Record the pre-merge URN so old `@source:slug` references still resolve
      // through the #697 alias map after the re-root.
      data: { urn: newUrn, ownerUserId: targetUserId, legacyUrn: m.urn },
    });
    // #1079 (PR #1080 review, Copilot P2) — a merge RE-ROOTS a urn, which is a
    // rename by any other name, so it owes an alias. `legacyUrn` alone is not
    // enough for two reasons: it is a single column, so a second merge
    // overwrites the first source's urn and that published URN 404s forever;
    // and node/edge refs reach the alias map rather than that column, so
    // without this a merge stranded every published node URN under a re-rooted
    // memory.
    await recordUrnRename(tx, {
      entityType: 'MEMORY',
      entityId: m.id,
      oldUrn: m.urn,
      newUrn,
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
      data: { urn: newUrn, ownerUserId: targetUserId, legacyUrn: a.urn },
    });
    // #1079 (PR #1080 review, Copilot P2) — a merge RE-ROOTS a urn, which is a
    // rename by any other name, so it owes an alias. `legacyUrn` alone is not
    // enough for two reasons: it is a single column, so a second merge
    // overwrites the first source's urn and that published URN 404s forever;
    // and node/edge refs reach the alias map rather than that column, so
    // without this a merge stranded every published node URN under a re-rooted
    // memory.
    await recordUrnRename(tx, {
      entityType: 'AGENT',
      entityId: a.id,
      oldUrn: a.urn,
      newUrn,
    });
  }

  // ── Apps ─────────────────────────────────────────────────────────────────
  // Liveness for the urn clash is the partial-unique predicate `uninstalled_at
  // IS NULL`; also skip soft-deleted rows (`deletedAt: null`), matching the
  // Memory/Agent loops — a dead row holds no live namespace to re-root, and its
  // ownership is moved by the sweep at the end.
  const apps = await tx.app.findMany({
    where: { ownerUserId: sourceUserId, uninstalledAt: null, deletedAt: null },
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
      data: { urn: newUrn, ownerUserId: targetUserId, legacyUrn: app.urn },
    });
    // #1079 (PR #1080 review, Copilot P2) — a merge RE-ROOTS a urn, which is a
    // rename by any other name, so it owes an alias. `legacyUrn` alone is not
    // enough for two reasons: it is a single column, so a second merge
    // overwrites the first source's urn and that published URN 404s forever;
    // and node/edge refs reach the alias map rather than that column, so
    // without this a merge stranded every published node URN under a re-rooted
    // memory.
    await recordUrnRename(tx, {
      entityType: 'APP',
      entityId: app.id,
      oldUrn: app.urn,
      newUrn,
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
  // `entry_node_urn` VERBATIM (validated, not normalized — resolvers.appRun.ts),
  // so it can be any accepted v2 node form: bare `<root>:<mem>:<loc…>` OR
  // scheme-prefixed `hrn:node:`/`urn:node:<root>:<mem>:…`. The re-rooted memory
  // URN sits at the front (after the optional prefix). Swap the FULL old→new
  // memory URN (correct even when the slug was re-minted) via a `^`-anchored
  // regex, so it can't touch a matching substring inside the loc. A legacy
  // v1-form ref (`@old::mem::loc`) is NOT rewritten — it resolves through the
  // re-rooted row's `legacyUrn` alias (#697), set above.
  for (const [oldUrn, newUrn] of memRemap) {
    if (oldUrn === newUrn) continue;
    const pattern = `^((hrn|urn):node:)?${reEscape(oldUrn)}:`;
    const replacement = `\\1${newUrn}:`;
    await tx.$executeRaw`
      UPDATE agent_schedules SET entry_node_urn = regexp_replace(entry_node_urn, ${pattern}, ${replacement})
      WHERE entry_node_urn ~ ${pattern}`;
    await tx.$executeRaw`
      UPDATE agent_webhooks SET entry_node_urn = regexp_replace(entry_node_urn, ${pattern}, ${replacement})
      WHERE entry_node_urn ~ ${pattern}`;
    await tx.$executeRaw`
      UPDATE webfetch_poll_bindings SET entry_node_urn = regexp_replace(entry_node_urn, ${pattern}, ${replacement})
      WHERE entry_node_urn ~ ${pattern}`;
  }
}
