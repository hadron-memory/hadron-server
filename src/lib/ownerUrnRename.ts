/**
 * spec 047 — re-namespace a user's owner-owned entity URNs after a handle
 * change. The user-facing analogue of {@link propagateOrgUrnRename} (issue
 * #337); it deliberately mirrors that helper's shape and rationale.
 *
 * A user-owned App / Agent / Memory stores a URN rooted on the owner's BARE
 * handle: `<handle>:<slug>` (#697 v2 — no `@` sigil; the principal pool makes
 * handle/org names disjoint). When the owner renames their handle, every such
 * URN must move in lockstep `<old>:<slug>` → `<new>:<slug>` — including a
 * user-owned agent's `<old>:<agent>-system` memory. Node/Edge URNs are COMPOSED
 * on read from the memory URN + loc (no stored `Node.urn`), so they self-heal
 * once the parent memory URN is fixed.
 *
 * **Durable node-URN references** (spec 040 triggers — AgentSchedule /
 * AgentWebhook / WebFetchPollBinding) store a fully-qualified `entry_node_urn`
 * in the v2 flat form (`hrn:node:<handle>:<mem>:<loc>`) when it points at a
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
import { assertNoMintedCorpusCascade } from './mintedSpecPermanence.js';

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
  // #697 v2: user-owned roots are the BARE handle — no `@` sigil (the principal
  // pool makes handle/org names disjoint). Existing rows are already bare (Task A
  // backfill dropped the sigil) and creation mints bare, so the rewrite heals any
  // row onto the bare `<handle>` root.
  const newPrefix = newHandle; // e.g. `new`
  const newColon = `${newPrefix}:`; // e.g. `new:`

  // Reclaim any SOFT-DELETED holder already parked in the target namespace so
  // the globally-unique `urn` index can't abort the rewrite. App.urn is only
  // partial-unique (active rows), so apps need no reclaim.
  await tx.$executeRaw`
    DELETE FROM agents
    WHERE deleted_at IS NOT NULL AND starts_with(urn, ${newColon})
  `;
  // #1468 — the reclaim erases each tombstone's nodes by FK cascade, so a
  // deleted mint-stamped corpus still holding a protected spec refuses it.
  const reclaimed = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM memories WHERE deleted_at IS NOT NULL AND starts_with(urn, ${newColon})`;
  await assertNoMintedCorpusCascade(
    tx,
    reclaimed.map((m) => m.id),
    'rename the handle over the deleted corpus holding',
    'Choose a different handle; the deleted corpus keeps its address.',
  );
  await tx.$executeRaw`
    DELETE FROM memories
    WHERE deleted_at IS NOT NULL AND starts_with(urn, ${newColon})
  `;

  // #1079 — record what each row USED to be called, BEFORE the rewrite derives
  // the new URN from it and the old value is gone. Same ordering rule, same
  // mirror-the-WHERE-exactly rule, and the same reason as the org cascade in
  // `propagateOrgUrnRename`: an alias for a row the UPDATE skips claims a rename
  // that never happened, and a row rewritten without one is a silent 404 on
  // every URN published under the old handle.
  //
  // The reclaim DELETEs above run first and take their aliases with them, which
  // is correct: those rows are soft-deleted tombstones being hard-deleted, and
  // an alias to a row that no longer exists resolves to nothing anyway.
  // Three explicit statements rather than a loop over table names: a table name
  // cannot be a bound parameter, so a loop needs `$executeRawUnsafe` and string
  // interpolation. Spelling them out keeps every statement a parameterized
  // `$executeRaw` and matches `propagateOrgUrnRename` next door.
  // `replace(urn, '::', ':')` normalizes the alias KEY the way
  // `normalizeUrnForLookup` does for a bare stored urn (PR #1080 review,
  // Copilot P2). Rows may still hold the canonical `::` spelling from the
  // spec-021 migration window, while every resolver queries the single-colon
  // form — so an un-normalized key would be stored somewhere nothing ever looks.
  // Bulk SQL cannot call the TypeScript normalizer, hence the inline mirror.
  // #3196: created_at is written explicitly as UTC. The column is a naive
  // timestamp holding UTC, and its DEFAULT CURRENT_TIMESTAMP would land as the
  // session's wall time, hours off under a non-UTC session.
  await tx.$executeRaw`
    INSERT INTO urn_aliases (id, urn, entity_type, entity_id, reason, replaced_by_urn, created_at)
    SELECT gen_random_uuid()::text, replace(m.urn, '::', ':'), 'MEMORY'::"UrnAliasEntityType", m.id,
           'RENAME'::"UrnAliasReason", replace(${newPrefix} || substr(m.urn, strpos(m.urn, ':')), '::', ':'),
           (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3)
    FROM memories m
    WHERE m.owner_user_id = ${userId} AND strpos(m.urn, ':') > 0
      AND NOT starts_with(m.urn, ${newColon})
    ON CONFLICT (urn, entity_type, entity_id)
      DO UPDATE SET replaced_by_urn = EXCLUDED.replaced_by_urn
  `;
  await tx.$executeRaw`
    INSERT INTO urn_aliases (id, urn, entity_type, entity_id, reason, replaced_by_urn, created_at)
    SELECT gen_random_uuid()::text, replace(a.urn, '::', ':'), 'AGENT'::"UrnAliasEntityType", a.id,
           'RENAME'::"UrnAliasReason", replace(${newPrefix} || substr(a.urn, strpos(a.urn, ':')), '::', ':'),
           (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3)
    FROM agents a
    WHERE a.owner_user_id = ${userId} AND strpos(a.urn, ':') > 0
      AND NOT starts_with(a.urn, ${newColon})
    ON CONFLICT (urn, entity_type, entity_id)
      DO UPDATE SET replaced_by_urn = EXCLUDED.replaced_by_urn
  `;
  await tx.$executeRaw`
    INSERT INTO urn_aliases (id, urn, entity_type, entity_id, reason, replaced_by_urn, created_at)
    SELECT gen_random_uuid()::text, replace(ap.urn, '::', ':'), 'APP'::"UrnAliasEntityType", ap.id,
           'RENAME'::"UrnAliasReason", replace(${newPrefix} || substr(ap.urn, strpos(ap.urn, ':')), '::', ':'),
           (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3)
    FROM apps ap
    WHERE ap.owner_user_id = ${userId} AND strpos(ap.urn, ':') > 0
      AND NOT starts_with(ap.urn, ${newColon})
    ON CONFLICT (urn, entity_type, entity_id)
      DO UPDATE SET replaced_by_urn = EXCLUDED.replaced_by_urn
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

  // Durable node-URN references (spec 040). `entry_node_urn` is stored VERBATIM
  // (validated, not normalized — resolvers.appRun.ts), so it can be any accepted
  // v2 node form: bare `<handle>:<mem>:<loc…>` OR scheme-prefixed
  // `hrn:node:`/`urn:node:<handle>:…`. In every form the owner handle is the ROOT
  // atom at the front (after the optional prefix). A rename never re-mints the
  // memory slug (it fails closed on a live collision), so this is a pure ROOT
  // swap — a `^`-anchored regex rewrite so it can't touch a `<handle>` substring
  // inside the loc. A LEGACY `@<handle>::…` ref is deliberately NOT rewritten:
  // post-v2 the target memory is bare-stored and resolves that ref through its
  // `legacyUrn` alias (#697, set by the Task A backfill, unchanged by a rename),
  // and rewriting it to `@<new>::` would break it. Skipped when the old handle
  // isn't URN-legal (nothing was namespaced under it).
  if (oldHandle) {
    const pattern = `^((hrn|urn):node:)?${reEscape(oldHandle)}:`;
    const replacement = `\\1${newHandle}:`;
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

/** Escape POSIX-regex metacharacters in a dynamic root/URN atom (a slug may
 *  legally contain `.`). Keeps the `^`-anchored rewrites from mis-matching. */
function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
