/**
 * The URN alias map (#1079) — every URN an entity used to answer to.
 *
 * Implements `cor:urn:030` — URN stability across renames:
 *   - `cor:urn:030:01` — a published URN keeps resolving after a rename
 *     (record atomically with the rename; a live URN beats an alias; ambiguity
 *     refuses; repetition does not accumulate).
 *   - `cor:urn:030:02` — an alias is not an access bypass (no liveness or
 *     authority is stored here; the caller re-queries under its own filters).
 *
 * ## The defect this closes
 *
 * A URN is the platform's publishable identifier. It goes into commit trailers,
 * PR descriptions, issue signatures, chat messages and exported documents —
 * artifacts nobody can rewrite afterwards. Four entities store their URN in a
 * column (`Organization`, `Memory`, `Agent`, `App`) and **all four can be
 * renamed**, but no rename path recorded the old value, so a rename silently
 * turned every published reference into a 404 with no record that the old URN
 * had ever meant anything.
 *
 * The blast radius is much wider than four rows, because most URNs in the
 * platform are **composed on read** from one of them — a node URN carries its
 * memory's slug, a worker URN its App's slug, an apprun URN likewise. Renaming
 * one memory therefore orphans every published *node* URN beneath it, which is
 * the platform's most-cited identifier.
 *
 * A derived URN heals **when** it resolves THROUGH its parent's ref resolver:
 * `hrn:worker:<root>:<app-slug>:<slug>` is resolved by looking up
 * `hrn:app:<root>:<app-slug>` first, so `workerRef` needed no change at all.
 * But that is not universal, and assuming it was cost a false claim here that a
 * test caught: `resolveNodeRef` and `resolveEdgeRef` do NOT call
 * `resolveMemoryRef` — they pick the memory prefix out of a compound URN with
 * their own lookup — so node and edge URNs need the explicit arm in
 * {@link findMemoryByAliasedUrn}. Before adding an alias source, check whether
 * the derived resolver actually delegates, rather than assuming it does.
 *
 * ## Three rules that keep an alias from becoming a hole
 *
 * 1. **A live URN always wins.** An old URN becomes free on rename and may be
 *    taken by a new entity. Every resolver queries the `urn` column first and
 *    consults this map only on a miss, so a re-used URN addresses its current
 *    owner and never the historical one.
 * 2. **Liveness is never stored here.** A row records only that a URN once
 *    addressed an entity. Whether that entity is still readable — soft-deleted,
 *    uninstalled — is answered by re-querying it under the caller's own filters,
 *    so an alias can neither resurrect a dead row nor route around its gate.
 * 3. **Ambiguity fails loudly.** Two entities may legitimately have held the
 *    same URN at different times, so the alias URN is not unique. More than one
 *    live match raises rather than guessing — the same rule, and the same helper,
 *    as the `legacy_urn` fallback this map supersedes.
 *
 * ## Relationship to `legacy_urn`
 *
 * The per-table `legacy_urn` columns hold the #697 v1→v2 migration aliases. They
 * are backfilled into this table as `V1_MIGRATION` rows, and for now both are
 * read (deduplicated by entity id) so a row the backfill somehow missed still
 * resolves. Retiring the columns is a follow-up; nothing here depends on it.
 */
import type { Prisma, PrismaClient } from '../generated/prisma/index.js';
import { normalizeUrnForLookup } from './urn.js';

/**
 * The entities whose URN is a stored, renameable column. Deliberately closed:
 * everything else composes its URN on read from one of these, so adding a member
 * means a new column somewhere, not a new derived shape.
 */
export type UrnAliasEntityType = 'ORGANIZATION' | 'MEMORY' | 'AGENT' | 'APP';

/** Why an alias row exists. See the Prisma enum for the authoritative list. */
export type UrnAliasReason = 'RENAME' | 'ORG_RENAME_CASCADE' | 'V1_MIGRATION';

/** The narrow slice of the client this module needs — a tx client satisfies it. */
type AliasDb = Pick<PrismaClient, 'urnAlias'>;

/**
 * Runaway guard on how many historical holders of ONE urn a lookup will examine.
 * Not a semantic bound — liveness and ambiguity are decided across everything
 * fetched, so this only caps a pathological map (see `findUrnAliasTargetIds`).
 */
const ALIAS_CANDIDATE_CAP = 100;

/**
 * Record that `oldUrn` no longer addresses `entityId` directly.
 *
 * Call this from inside the SAME transaction as the rename. If the alias write
 * and the `urn` update can commit separately, the window between them is exactly
 * the failure this map exists to prevent: the old URN stops resolving and nothing
 * remembers it.
 *
 * Idempotent by the `(urn, entityType, entityId)` unique index — a rename back
 * and forth re-records the same pair rather than accumulating duplicates, which
 * would read as an ambiguous lookup and start refusing a URN that resolves to
 * exactly one entity.
 *
 * A no-op when the URN did not actually change, or when either side is blank:
 * recording `'' → x` would insert an alias nothing can match, and a rename that
 * renamed nothing has no history to keep.
 *
 * **Normalizes both URNs itself** (PR #1080 review, Codex + Copilot P2). An
 * earlier draft required callers to pass the normalized form and stored what it
 * was given, on the reasoning that a stored `urn` column already IS the lookup
 * form. That is not guaranteed: a row may still hold the canonical `::` spelling
 * from the spec-021 migration window — `resolveNodeRef` builds BOTH spellings as
 * candidates precisely because of it — and an alias stored as `org::slug` is
 * unreachable from resolvers that query `org:slug`. Normalizing in the one place
 * every TypeScript writer goes through is what makes the storage invariant true
 * rather than merely documented. (The bulk SQL cascades cannot call this, so they
 * normalize inline; see `propagateOrgUrnRename`.)
 */
export async function recordUrnRename(
  db: AliasDb,
  params: {
    entityType: UrnAliasEntityType;
    entityId: string;
    oldUrn: string;
    newUrn: string;
    reason?: UrnAliasReason;
    createdBy?: string | null;
  },
): Promise<void> {
  const rawOld = params.oldUrn?.trim();
  const rawNew = params.newUrn?.trim();
  if (!rawOld || !rawNew) return;
  const oldUrn = normalizeUrnForLookup(rawOld);
  const newUrn = normalizeUrnForLookup(rawNew);
  // Compare AFTER normalizing: `org::slug` → `org:slug` is a spelling change,
  // not a rename, and recording it would create an alias pointing at itself.
  if (!oldUrn || !newUrn || oldUrn === newUrn) return;
  await db.urnAlias.upsert({
    where: {
      urn_entityType_entityId: {
        urn: oldUrn,
        entityType: params.entityType as never,
        entityId: params.entityId,
      },
    },
    // Refresh the successor on a repeat rename through the same old URN, so the
    // provenance points at what actually replaced it most recently.
    update: { replacedByUrn: newUrn },
    create: {
      urn: oldUrn,
      entityType: params.entityType as never,
      entityId: params.entityId,
      reason: (params.reason ?? 'RENAME') as never,
      replacedByUrn: newUrn,
      createdBy: params.createdBy ?? null,
    },
  });
}

/**
 * The entity ids this URN used to address, for one entity kind.
 *
 * Returns ids ONLY — never a liveness verdict. The caller re-queries its own
 * table with its own filters (soft-delete, `uninstalled_at`, visibility), which
 * is what stops an alias resurrecting a dead row or routing around a gate. Rule
 * 2 in the module docstring.
 *
 * Deliberately NOT limited to two or three rows (PR #1080 review, Codex +
 * Copilot P2). An earlier draft took 3, which is wrong twice over once a URN has
 * had more than three historical holders — legal, because aliases outlive the
 * entities they name: the take is UNORDERED, so it can return three dead holders
 * and report a live fourth as missing, or drop one of two live holders and turn
 * an ambiguity into a confident wrong answer. Liveness has to be evaluated
 * across ALL candidates and the bound applied to the LIVE set, which is what
 * `findLiveUrnAliasTargets` now does.
 *
 * The cap here is a runaway guard, not a semantic bound: it sits far above any
 * plausible number of historical holders of one URN, so reaching it means the
 * map is corrupt rather than that a caller is unlucky.
 */
export async function findUrnAliasTargetIds(
  db: AliasDb,
  entityType: UrnAliasEntityType,
  lookupUrn: string,
): Promise<string[]> {
  const urn = lookupUrn?.trim();
  if (!urn) return [];
  const rows = await db.urnAlias.findMany({
    where: { urn: normalizeUrnForLookup(urn), entityType: entityType as never },
    select: { entityId: true },
    take: ALIAS_CANDIDATE_CAP,
  });
  return rows.map((r: { entityId: string }) => r.entityId);
}

/**
 * Alias-map candidates, re-queried for liveness by the caller's own filter.
 *
 * `findLive` receives the ids this URN used to address and must apply the SAME
 * liveness and visibility predicates the resolver's primary lookup applies —
 * that is rule 2 (liveness is never stored in the map), and keeping it a callback
 * is what makes it structurally impossible for this module to answer a liveness
 * question it has no business answering.
 *
 * Skips the second query entirely when the map has nothing, so the added cost on
 * the overwhelmingly common path — a URN that is simply not found — is one
 * indexed lookup that returns no rows.
 */
export async function findLiveUrnAliasTargets<T extends { id: string }>(
  db: AliasDb,
  entityType: UrnAliasEntityType,
  lookupUrn: string,
  findLive: (ids: string[]) => Promise<T[]>,
): Promise<T[]> {
  const ids = await findUrnAliasTargetIds(db, entityType, lookupUrn);
  if (ids.length === 0) return [];
  return findLive(ids);
}

/**
 * Merge candidate rows from several sources, keeping the first of each id.
 *
 * Needed because the alias map and the `legacy_urn` columns are read together
 * during the transition and OVERLAP by construction — the migration backfilled
 * one from the other. Concatenating them would hand the same entity to the
 * ambiguity check twice and refuse a URN that resolves to exactly one thing.
 */
export function dedupeById<T extends { id: string }>(
  ...groups: ReadonlyArray<ReadonlyArray<T>>
): T[] {
  const seen = new Map<string, T>();
  for (const group of groups) {
    for (const row of group) if (!seen.has(row.id)) seen.set(row.id, row);
  }
  return [...seen.values()];
}

/** A transaction client, for callers that record a rename inside one. */
export type UrnAliasTx = Pick<Prisma.TransactionClient, 'urnAlias'>;

/**
 * The memory a possibly-renamed URN prefix names, or null (#1079).
 *
 * `resolveNodeRef` and `resolveEdgeRef` do NOT go through `resolveMemoryRef` —
 * they resolve the memory prefix out of a compound URN with their own lookup,
 * against several candidate spellings. So node and edge URNs do not inherit the
 * memory resolver's alias fallback for free, and this is the shared arm that
 * gives it to them. That matters more than any other arm of #1079: a node URN
 * is the platform's most-cited identifier, and every one of them carries its
 * memory's slug.
 *
 * Tries each candidate spelling in order and stops at the first that the alias
 * map knows, applying the same ambiguity rule as everywhere else. Returns the
 * row (with `deletedAt`) rather than just an id, because both callers need to
 * apply their own soft-delete decision to it.
 */
export async function findMemoryByAliasedUrn(
  db: Pick<PrismaClient, 'urnAlias' | 'memory'>,
  candidateUrns: ReadonlyArray<string>,
  onAmbiguous: (candidate: string, rows: ReadonlyArray<{ id: string }>) => never,
  options?: { includeDeleted?: boolean },
): Promise<{ id: string; deletedAt: Date | null } | null> {
  for (const candidate of candidateUrns) {
    const ids = await findUrnAliasTargetIds(db, 'MEMORY', candidate);
    if (ids.length === 0) continue;
    // Liveness BEFORE ambiguity (PR #1080 review, Codex + Copilot P2). An
    // earlier draft fetched every claimant unfiltered and raised on more than
    // one, so a live memory sharing an old URN with a soft-deleted one made a
    // node or edge lookup FAIL — while `resolveMemoryRef`, which filters first,
    // resolved the live row happily. Two surfaces, two answers, for the same
    // URN. It also returned an arbitrary row, which could be the dead one.
    //
    // This is `cor:urn:030:02` in its exact form: a dead claimant is not a
    // claimant, so it must not be able to make a resolvable URN ambiguous.
    const rows = await db.memory.findMany({
      where: { id: { in: ids }, ...(options?.includeDeleted ? {} : { deletedAt: null }) },
      select: { id: true, deletedAt: true },
      take: 2,
    });
    if (rows.length === 0) continue;
    // Ambiguity is the caller's error type to throw, so this helper stays free
    // of any one resolver's vocabulary.
    if (rows.length > 1) onAmbiguous(candidate, rows);
    return rows[0]!;
  }
  return null;
}
