/**
 * URN grammar-v2 online migration — the backfill sweep (#697, Task A).
 *
 * Populates the stored alias map so the (already-wired, currently inert)
 * `resolve{Memory,Agent,App}Ref` legacy fallback comes alive: for each
 * not-yet-normalized LIVE Memory/Agent/App row it computes the flat v2 `urn`,
 * stashes the old value in `legacyUrn`, and marks `urnNormalizedAt`. Follows the
 * spec-021 online-migration invariants (`cor:urn:010:02`): idempotent, resumable,
 * no downtime, and a genuine failure records `urnMigrationFailedReason` and is
 * skipped on later passes (never an infinite retry, never a crashed sweep).
 *
 * DEPENDS ON THE #692 POOL BEING DEPLOYED — every root must resolve to a live
 * `Principal`. Build now; run in prod only after #692 ships (see the epic #691
 * rollout). Node/Edge/NodeRevision URNs are COMPUTED from the memory URN and
 * self-heal, so they need no backfill.
 *
 * Slug reassignment for compound marker memories, collision handling, and the
 * root/owner decomposition all live in {@link planV2Urn} + {@link mintLocalSlug};
 * this module is the DB-facing driver around them.
 */

import type { PrismaClient } from '../../generated/prisma/index.js';
import { composeUrnV2, normalizeUrnForLookup } from '../urn.js';
import { mintLocalSlug } from '../mintLocalSlug.js';
import { planV2Slug, type EntityUrnType } from './planV2Urn.js';

/** How many rows a single fetch pulls; each row is processed in its own txn. */
const BATCH_SIZE = 500;

/** Per-entity outcome tally the script prints. */
export interface EntityBackfillStats {
  entity: EntityUrnType;
  /** Rows whose v2 urn differed and were re-rooted (legacyUrn populated). */
  migrated: number;
  /** Rows already byte-identical in v1/v2 — only `urnNormalizedAt` set. */
  unchanged: number;
  /** Rows that recorded a `urnMigrationFailedReason` and were skipped. */
  failed: number;
}

/** Options controlling a backfill run. */
export interface BackfillOptions {
  /** When true, compute + log every row but write nothing (a dry run). */
  dryRun?: boolean;
  /** Structured line logger; defaults to `console.log`. */
  log?: (msg: string) => void;
}

/**
 * A fetched row: its id + stored URN, plus the OWNER FKs and their names. The
 * root comes from the owner (org name / user handle), NOT the URN string — a
 * stored URN root can diverge from the real owner (see {@link planV2Slug}).
 */
interface OwnedRow {
  id: string;
  urn: string;
  ownerUserId: string | null;
  organization: { urn: string } | null;
  ownerUser: { handle: string | null } | null;
}

/**
 * The subset of a Prisma delegate (memory/agent/app) the sweep touches. Kept
 * structural so all three entities share one driver despite distinct models.
 */
interface EntityDelegate {
  findMany(args: unknown): Promise<OwnedRow[]>;
  count(args: unknown): Promise<number>;
  update(args: unknown): Promise<unknown>;
}

/** Static per-entity wiring: the delegate, its liveness predicates, its v2 type. */
interface EntityConfig {
  entity: EntityUrnType;
  delegate: (db: PrismaClient) => EntityDelegate;
  /**
   * The predicate matching the entity's URN unique constraint — what the
   * collision probe (`isTaken`) keys on so it detects exactly the rows that
   * would throw P2002. Memory/Agent have a full `@unique` spanning tombstones;
   * the probe stays live-only (`deletedAt: null`) by design and the P2002 catch
   * covers a tombstone clash (#695). App's unique is the partial
   * `apps_urn_active_uniq WHERE uninstalled_at IS NULL`, so its probe keys on
   * `uninstalledAt`.
   */
  probeWhere: Record<string, unknown>;
  /**
   * Extra filter (beyond `probeWhere`) narrowing which rows the sweep PROCESSES,
   * so a logically-deleted row is skipped even if it still satisfies the unique.
   * App is uninstall-keyed for its unique but should still skip `deletedAt` rows.
   */
  pendingExtra: Record<string, unknown>;
}

const ENTITY_CONFIGS: EntityConfig[] = [
  { entity: 'mem', delegate: (db) => db.memory as unknown as EntityDelegate, probeWhere: { deletedAt: null }, pendingExtra: {} },
  { entity: 'agent', delegate: (db) => db.agent as unknown as EntityDelegate, probeWhere: { deletedAt: null }, pendingExtra: {} },
  { entity: 'app', delegate: (db) => db.app as unknown as EntityDelegate, probeWhere: { uninstalledAt: null }, pendingExtra: { deletedAt: null } },
];

/**
 * Confirm `root` names a LIVE pool principal of the expected kind (#692). A
 * missing / released / reserved / wrong-kind principal means the row cannot be
 * safely re-rooted, so the caller records it as a failure instead of guessing.
 * The name is lowercased (principals store lowercase; the index is case-folded).
 */
async function rootIsLivePrincipal(
  db: PrismaClient,
  root: string,
  ownerKind: 'org' | 'user',
): Promise<boolean> {
  const principal = await db.principal.findUnique({
    where: { name: root.toLowerCase() },
    select: { status: true, kind: true },
  });
  return principal?.status === 'active' && principal.kind === ownerKind;
}

/**
 * Resolve a row's authoritative root principal from its OWNER FK. All three
 * entities enforce a DB-level XOR (`chk_{memory,agent,app}_owner_xor`:
 * `(organization_id IS NULL) <> (owner_user_id IS NULL)`), so EXACTLY ONE of the
 * two FKs is set — a reliable, DB-guaranteed owner signal. A `ownerUserId` row
 * roots on the user's handle; otherwise the row is org-owned and roots on the
 * org's name. The FK (not the stored URN's root atom or `@` sigil) is
 * authoritative because a stored URN root can diverge from its real owner
 * (observed: `shadowbrush.com:recipes` owned by org `baragaun.com`). Returns
 * null (→ a recorded failure) only if the selected owner's name column is
 * somehow absent.
 */
function ownerRootOf(row: OwnedRow): { root: string; ownerKind: 'org' | 'user' } | null {
  if (row.ownerUserId) {
    return row.ownerUser?.handle ? { root: row.ownerUser.handle, ownerKind: 'user' } : null;
  }
  return row.organization?.urn ? { root: row.organization.urn, ownerKind: 'org' } : null;
}

/**
 * Normalize one row onto its v2 URN. Returns the outcome bucket. Never throws:
 * a compute/validate error is caught and recorded as `urnMigrationFailedReason`
 * so the sweep proceeds. Byte-identical rows (`<org>:<slug>` whose v2 form is
 * the same) get only `urnNormalizedAt` — no `legacyUrn`, since the plain v1
 * lookup (and its `::`/`@`/`urn:` spellings) already resolves them.
 */
async function migrateRow(
  db: PrismaClient,
  cfg: EntityConfig,
  row: OwnedRow,
  opts: BackfillOptions,
  claimed: Set<string>,
): Promise<'migrated' | 'unchanged' | 'failed'> {
  const log = opts.log ?? console.log;
  const delegate = cfg.delegate(db);

  const fail = async (reason: string): Promise<'failed'> => {
    log(`  ✗ ${cfg.entity} ${row.id} (${row.urn}): ${reason}`);
    if (!opts.dryRun) {
      await delegate.update({ where: { id: row.id }, data: { urnMigrationFailedReason: reason } });
    }
    return 'failed';
  };

  // Root from the OWNER FK (authoritative); slug from the stored URN, first
  // collapsed to the single-colon lookup form so a canonical `::`-stored row (a
  // supported migration-window state, e.g. `acme.com::notes`) is flattened
  // rather than rejected by planV2Slug's empty-atom guard.
  const owner = ownerRootOf(row);
  if (!owner) return fail('row has no resolvable owner (org/user FK)');
  const { root, ownerKind } = owner;

  const storedUrn = normalizeUrnForLookup(row.urn);

  let plan;
  try {
    plan = planV2Slug(storedUrn);
  } catch (err) {
    return fail(`plan: ${(err as Error).message}`);
  }
  const authorRoot = plan.authorRootHint ?? root;

  if (!(await rootIsLivePrincipal(db, root, ownerKind))) {
    return fail(`root "${root}" is not a live ${ownerKind} principal`);
  }

  // Validate the base atoms are v2-legal up front (charset/arity) so an illegal
  // root/slug fails fast rather than after the collision probe. The `hrn:`-
  // prefixed result is only for validation; we store the BARE `<root>:<slug>`.
  try {
    composeUrnV2(cfg.entity, root, plan.desiredSlug);
  } catch (err) {
    return fail(`compose: ${(err as Error).message}`);
  }

  // Collision-safe mint. The probe excludes the row itself and matches the
  // entity's unique predicate, checking BOTH `urn` AND `legacyUrn` — a minted
  // urn must never shadow another row's stored legacy identity, since resolution
  // checks `urn` before the `legacyUrn` fallback (a shadowed legacy reference
  // would resolve to the wrong row). It also consults `claimed` — the primary +
  // legacy URNs already taken by EARLIER rows this run — so a dry run (which
  // writes nothing) still previews intra-batch collisions accurately.
  let minted;
  try {
    minted = await mintLocalSlug({
      root,
      desiredSlug: plan.desiredSlug,
      authorRoot,
      isTaken: async (composedUrn) =>
        claimed.has(composedUrn) ||
        (await delegate.count({
          where: {
            id: { not: row.id },
            ...cfg.probeWhere,
            OR: [{ urn: composedUrn }, { legacyUrn: composedUrn }],
          },
        })) > 0,
    });
  } catch (err) {
    return fail(`mint: ${(err as Error).message}`);
  }

  const newUrn = minted.urn; // bare `<root>:<slug>`, single colon.
  claimed.add(newUrn); // reserve the new primary against later rows this run.
  // When the row's lookup identity moves, its OLD key becomes a legacy alias —
  // reserve that too so a later row can't mint a urn that shadows it.
  const identityMoved = newUrn !== storedUrn;
  if (identityMoved) claimed.add(storedUrn);

  // Already in the exact v2 form (raw stored string == new urn): nothing to
  // rewrite, just mark it normalized.
  if (newUrn === row.urn) {
    log(`  · ${cfg.entity} ${row.id}: unchanged (${row.urn})`);
    if (!opts.dryRun) {
      await delegate.update({ where: { id: row.id }, data: { urnNormalizedAt: new Date() } });
    }
    return 'unchanged';
  }

  log(`  → ${cfg.entity} ${row.id}: ${row.urn}  ⟶  ${newUrn}`);
  const outcome = identityMoved ? 'migrated' : 'unchanged'; // pure `::` collapse = unchanged identity
  if (opts.dryRun) return outcome;
  try {
    await delegate.update({
      where: { id: row.id },
      data: {
        urn: newUrn,
        urnNormalizedAt: new Date(),
        // Populate the alias map only when the LOOKUP identity actually changed;
        // a pure `::`→`:` collapse keeps the same lookup key and needs no redirect.
        ...(identityMoved ? { legacyUrn: storedUrn } : {}),
      },
    });
    return outcome;
  } catch (err) {
    // A P2002 here means another row already owns `newUrn` under the entity's
    // full unique — for Memory/Agent typically a TOMBSTONED holder (the unique
    // spans soft-deletes while the probe is live-only, the #695 gotcha).
    // Record it rather than crash; a later pass or a manual reclaim resolves it.
    if ((err as { code?: string } | null)?.code === 'P2002') {
      return fail(`urn "${newUrn}" already claimed under the unique constraint (P2002)`);
    }
    return fail(`write: ${(err as Error).message}`);
  }
}

/**
 * Sweep one entity to completion. Repeatedly fetches a batch of rows still
 * pending (`urnNormalizedAt IS NULL AND urnMigrationFailedReason IS NULL`) and
 * processes each; because every processed row exits the pending set (success
 * sets `urnNormalizedAt`, failure sets `urnMigrationFailedReason`), the loop
 * drains and is safe to re-run. Paging is KEYSET (a strictly-greater `id`
 * predicate in the `where`), NOT Prisma's `cursor`/`skip:1`: a migrated row
 * leaves the pending set, and Prisma's `cursor` throws `P2025` when the cursor
 * record no longer satisfies the query filter. Keyset paging also guarantees
 * forward progress for a row a run leaves pending (a dry run writes nothing; an
 * unexpected DB error on a write is caught, counted, and the row left for a
 * later run) — the `id > cursor` bound moves past it rather than re-fetching it
 * forever. The per-row catch upholds "never crash the sweep".
 */
async function backfillEntity(
  db: PrismaClient,
  cfg: EntityConfig,
  opts: BackfillOptions,
): Promise<EntityBackfillStats> {
  const log = opts.log ?? console.log;
  const delegate = cfg.delegate(db);
  const stats: EntityBackfillStats = { entity: cfg.entity, migrated: 0, unchanged: 0, failed: 0 };
  const claimed = new Set<string>();
  const pendingWhere = {
    urnNormalizedAt: null,
    urnMigrationFailedReason: null,
    ...cfg.probeWhere,
    ...cfg.pendingExtra,
  };

  let cursor: string | undefined;
  for (;;) {
    const rows = await delegate.findMany({
      where: { ...pendingWhere, ...(cursor ? { id: { gt: cursor } } : {}) },
      select: {
        id: true,
        urn: true,
        ownerUserId: true,
        organization: { select: { urn: true } },
        ownerUser: { select: { handle: true } },
      },
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      try {
        stats[await migrateRow(db, cfg, row, opts, claimed)] += 1;
      } catch (err) {
        // migrateRow records data errors itself; only an unexpected DB error on
        // a write reaches here. Log + count, leave the row pending for re-run;
        // the cursor still advances past it so the run cannot spin.
        stats.failed += 1;
        log(`  ✗ ${cfg.entity} ${row.id} (${row.urn}): unexpected ${(err as Error).message} (left pending)`);
      }
    }
    cursor = rows[rows.length - 1]!.id;
  }
  return stats;
}

/**
 * Run the full URN-v2 backfill across Memory, Agent, and App. Returns per-entity
 * stats. Idempotent and resumable — re-running only touches rows still pending.
 * Pass `{ dryRun: true }` to preview every pending row without writing.
 */
export async function backfillUrnV2(
  db: PrismaClient,
  opts: BackfillOptions = {},
): Promise<EntityBackfillStats[]> {
  const log = opts.log ?? console.log;
  const results: EntityBackfillStats[] = [];
  for (const cfg of ENTITY_CONFIGS) {
    log(`\n${opts.dryRun ? '[dry-run] ' : ''}Backfilling ${cfg.entity} URNs…`);
    const stats = await backfillEntity(db, cfg, opts);
    log(
      `  ${cfg.entity}: ${stats.migrated} migrated, ${stats.unchanged} unchanged, ${stats.failed} failed`,
    );
    results.push(stats);
  }
  return results;
}
