/**
 * spec 047 — re-namespace a user's owner-owned entity URNs after a handle
 * change. The user-facing analogue of {@link propagateOrgUrnRename} (issue
 * #337); it deliberately mirrors that helper's shape and rationale.
 *
 * A user-owned App / Agent / Memory stores a bare URN namespaced under the
 * owner's handle: `@<handle>:<slug>` (canonicalizes to
 * `hrn:<type>:@<handle>::<slug>`). When the owner renames their handle, every
 * such URN must move in lockstep `@<old>:<slug>` → `@<new>:<slug>` — including a
 * user-owned agent's `@<old>:<agent>-system` memory. Node/Edge URNs are COMPOSED
 * on read from the memory URN + loc (no stored `Node.urn`), so they self-heal
 * once the parent memory URN is fixed.
 *
 * **Durable node-URN references** (spec 040 triggers — AgentSchedule /
 * AgentWebhook / WebFetchPollBinding) store a fully-qualified `entry_node_urn`
 * that embeds the handle (`@<handle>::<mem>::<loc>`) when it points at a
 * user-owned memory's node. Those are rewritten too, or an active schedule /
 * webhook / poll would fail to resolve its target after a rename (#686 review).
 *
 * **Scope by FK (`owner_user_id`), not by matching the old prefix.** The three
 * URN tables are selected purely by owner, and the prefix stripped is
 * "everything up to the first colon" — so a row whose prefix drifted from the
 * owner's live handle (a rename that predated this cascade, a direct DB edit) is
 * HEALED, not stranded. A handle is a URN atom and never contains a colon
 * (`validateUserSlug`), so the first colon is an unambiguous handle→slug
 * boundary. The `entry_node_urn` tables have no `owner_user_id`, so they are
 * scoped by the handle substring itself — which uniquely identifies the owner's
 * namespace (handles are unique).
 *
 * One bulk statement per table inside the caller's transaction, so the handle
 * change and every URN rewrite commit (or roll back) together. Agent/Memory
 * `urn` is GLOBALLY unique, so a holder already sitting in the TARGET `@<new>:`
 * namespace can exist — e.g. the SAME user's own rows from a rename that
 * predated this propagation. Live rows already at the target are skipped by the
 * `NOT starts_with(urn, newColon)` guard (idempotent); a SOFT-DELETED holder is
 * reclaimed first (hard-delete before the rewrite), mirroring the create paths,
 * so the unique index can't abort the rewrite. A collision with a still-LIVE
 * row that ISN'T already correct is a genuine conflict and rightly aborts the
 * whole rename (fail-closed, never a partial rename).
 */

import type { Prisma } from '../generated/prisma/index.js';

/**
 * Rewrite the caller's owner-owned URNs onto the `@<newHandle>` namespace.
 * `oldHandle` / `newHandle` must be normalized (lowercase, URN-legal); a null
 * `oldHandle` (legacy row with no URN-legal handle) skips the handle-substring-
 * scoped `entry_node_urn` rewrites — nothing was ever namespaced under it — but
 * still runs the FK-scoped `urn` rewrites (which heal drift). Idempotent, and
 * must run inside the same transaction as the `User.handle` update.
 */
export async function renameOwnerNamespacedUrns(
  tx: Prisma.TransactionClient,
  userId: string,
  oldHandle: string | null,
  newHandle: string,
): Promise<void> {
  const newPrefix = `@${newHandle}`; // e.g. `@new`
  const newColon = `${newPrefix}:`; // e.g. `@new:`

  // Reclaim any SOFT-DELETED holder already parked in the target namespace so
  // the globally-unique `urn` index can't abort the rewrite. App.urn is only
  // partial-unique (active rows), so apps need no reclaim.
  await tx.$executeRaw`
    DELETE FROM agents
    WHERE deleted_at IS NOT NULL AND starts_with(urn, ${newColon})
  `;
  await tx.$executeRaw`
    DELETE FROM memories
    WHERE deleted_at IS NOT NULL AND starts_with(urn, ${newColon})
  `;

  // `strpos(urn, ':')` is the 1-based index of the handle→slug colon;
  // `substr(urn, that)` keeps the colon + slug verbatim, so prepending the new
  // `@<handle>` prefix rewrites ANY stale prefix. `strpos > 0` skips a
  // malformed colon-less URN; `NOT starts_with(urn, newColon)` skips rows
  // already correct (idempotent — avoids a no-op write + `@unique` index churn).
  await tx.$executeRaw`
    UPDATE memories
    SET urn = ${newPrefix} || substr(urn, strpos(urn, ':'))
    WHERE owner_user_id = ${userId} AND strpos(urn, ':') > 0
      AND NOT starts_with(urn, ${newColon})
  `;
  await tx.$executeRaw`
    UPDATE agents
    SET urn = ${newPrefix} || substr(urn, strpos(urn, ':'))
    WHERE owner_user_id = ${userId} AND strpos(urn, ':') > 0
      AND NOT starts_with(urn, ${newColon})
  `;
  await tx.$executeRaw`
    UPDATE apps
    SET urn = ${newPrefix} || substr(urn, strpos(urn, ':'))
    WHERE owner_user_id = ${userId} AND strpos(urn, ':') > 0
      AND NOT starts_with(urn, ${newColon})
  `;

  // Durable node-URN references (spec 040). The handle appears as `@<handle>::`
  // (the handle→memory boundary of a fully-qualified node URN); replace that
  // literal — anchored by the trailing `::` so it can't match a bare handle
  // prefix — everywhere it occurs. No owner_user_id here, but the handle
  // substring uniquely identifies this owner's namespace. Skipped when the old
  // handle isn't URN-legal (nothing was namespaced under it).
  if (oldHandle) {
    const oldBoundary = `@${oldHandle}::`;
    const newBoundary = `@${newHandle}::`;
    await tx.$executeRaw`
      UPDATE agent_schedules
      SET entry_node_urn = replace(entry_node_urn, ${oldBoundary}, ${newBoundary})
      WHERE strpos(entry_node_urn, ${oldBoundary}) > 0
    `;
    await tx.$executeRaw`
      UPDATE agent_webhooks
      SET entry_node_urn = replace(entry_node_urn, ${oldBoundary}, ${newBoundary})
      WHERE strpos(entry_node_urn, ${oldBoundary}) > 0
    `;
    await tx.$executeRaw`
      UPDATE webfetch_poll_bindings
      SET entry_node_urn = replace(entry_node_urn, ${oldBoundary}, ${newBoundary})
      WHERE strpos(entry_node_urn, ${oldBoundary}) > 0
    `;
  }
}
