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
 * **Scope by FK (`owner_user_id`), not by matching the old prefix.** Rows are
 * selected purely by owner, and the prefix stripped is "everything up to the
 * first colon" — so a row whose prefix drifted from the owner's live handle
 * (a rename that predated this cascade, a direct DB edit) is HEALED, not
 * stranded. A handle is a URN atom and never contains a colon
 * (`validateUserSlug`), so the first colon is an unambiguous handle→slug
 * boundary, and keeping everything from that colon onward preserves the slug
 * (and any `::` vs legacy `:` form) verbatim.
 *
 * One bulk `UPDATE` per table inside the caller's transaction, so the handle
 * change and the URN rewrite commit (or roll back) together. The new handle is
 * already unique on `users` and entities are namespaced under their owner, so
 * no `@<new>:*` URN can pre-exist; a rewritten URN colliding with a `@unique`
 * row aborts the whole rename (fail-closed, never a partial rename).
 */

import type { Prisma } from '../generated/prisma/index.js';

/**
 * Rewrite the caller's owner-owned URNs onto the `@<newHandle>` namespace.
 * `newHandle` must be the normalized (lowercase, URN-legal) handle. Idempotent:
 * rows already at the target prefix are skipped. Must run inside the same
 * transaction as the `User.handle` update.
 */
export async function renameOwnerNamespacedUrns(
  tx: Prisma.TransactionClient,
  userId: string,
  newHandle: string,
): Promise<void> {
  const newPrefix = `@${newHandle}`;
  // `strpos(urn, ':')` is the 1-based index of the handle→slug colon;
  // `substr(urn, that)` keeps the colon + slug verbatim, so prepending the new
  // `@<handle>` prefix rewrites ANY stale prefix. `strpos > 0` skips a
  // malformed colon-less URN; `NOT starts_with(urn, newPrefix || ':')` skips
  // rows already correct (idempotent — avoids a no-op write + `@unique` index
  // churn). Table/column names are the Prisma @@map targets.
  await tx.$executeRaw`
    UPDATE memories
    SET urn = ${newPrefix} || substr(urn, strpos(urn, ':'))
    WHERE owner_user_id = ${userId} AND strpos(urn, ':') > 0
      AND NOT starts_with(urn, ${newPrefix} || ':')
  `;
  await tx.$executeRaw`
    UPDATE agents
    SET urn = ${newPrefix} || substr(urn, strpos(urn, ':'))
    WHERE owner_user_id = ${userId} AND strpos(urn, ':') > 0
      AND NOT starts_with(urn, ${newPrefix} || ':')
  `;
  await tx.$executeRaw`
    UPDATE apps
    SET urn = ${newPrefix} || substr(urn, strpos(urn, ':'))
    WHERE owner_user_id = ${userId} AND strpos(urn, ':') > 0
      AND NOT starts_with(urn, ${newPrefix} || ':')
  `;
}
