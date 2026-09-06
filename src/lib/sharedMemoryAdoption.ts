/**
 * #723 — reconcile pre-#723 `shared` app-class memories onto the column key.
 *
 * Until #723 an App's shared memory was IDENTIFIED by its urn string
 * (`<app-urn>:<agent-slug>:shared`). That string key is what kept the row on a
 * compound v1 URN — a multi-atom memory slug, so node URNs inside it don't
 * round-trip through `splitNodeUrn` and the portal link a node read emits 404s
 * (every team chat, by construction — `chats:team` lives here, #939). The
 * identity now lives in `Memory.sharedMemoryOfAgentId` + the
 * `(appId, sharedMemoryOfAgentId)` unique, which frees the urn to be minted flat.
 *
 * Existing rows carry no column, so they must be adopted ONCE off the old string
 * key. Three places do that, deliberately overlapping — "new rows are fine, old
 * ones aren't" is the failure mode this feature has to avoid:
 *
 *   1. the `20260813120000_shared_memory_agent_key` migration, in bulk;
 *   2. this sweep, which additionally REPORTS what it cannot decide;
 *   3. `findOrCreateAppClassMemory`, lazily, on the pairing's next touch.
 *
 * All three match through {@link memoryCarriesLegacyKeyFor} so they can't drift
 * into adopting different sets of rows. This sweep is deliberately conservative:
 * a candidate that resolves to no Agent, to more than one, or to a pairing
 * already held by another row is reported and SKIPPED, never guessed at — an
 * adoption points a team's chat and worklog at a memory, so a wrong one is worse
 * than a manual fix.
 *
 * It does NOT rewrite any urn. Flattening an existing memory's address is the
 * #697 backfill's job (`pnpm admin:backfill-urn-v2`), which parks the old value
 * in `legacyUrn` so existing references keep resolving; this sweep counts every
 * keyed row still waiting for it so the operator knows to run it.
 */

import type { PrismaClient } from '../generated/prisma/index.js';
import {
  agentSlugCandidates,
  hasCompoundUrn,
  memoryCarriesLegacyKeyFor,
  sharedUrnAgentSlug,
} from './sharedMemoryLegacyKey.js';

/** Outcome tally for one sweep. */
export interface SharedMemoryAdoptionStats {
  /** Rows that gained `sharedMemoryOfAgentId` (would gain, in a dry run). */
  adopted: number;
  /** Rows already carrying the column when the sweep started. */
  alreadyKeyed: number;
  /** Candidates left alone — no agent match, ambiguous, or pairing taken. */
  skipped: number;
  /**
   * Keyed shared memories whose urn is STILL COMPOUND once this run is done —
   * every one of them is a live 404 on its nodes' portal links until
   * `admin:backfill-urn-v2` flattens them. Counted across ALL keyed rows, not
   * just the ones this run adopted: the migration adopts without rewriting
   * urns, so a sweep that only counted its own work would report a reassuring
   * zero while every pre-existing team chat was still unaddressable.
   */
  stillCompoundUrn: number;
}

/** Options controlling a sweep. */
export interface SharedMemoryAdoptionOptions {
  /** Compute + log every row, write nothing. */
  dryRun?: boolean;
  /** Structured line logger; defaults to `console.log`. */
  log?: (msg: string) => void;
}

export { sharedUrnAgentSlug };

/**
 * Adopt every pre-#723 shared app-class memory onto the `(appId, agent)` column
 * key. Idempotent and re-runnable: a row that already carries the column is
 * counted and skipped, so a second run is a no-op.
 */
export async function adoptSharedMemories(
  db: PrismaClient,
  opts: SharedMemoryAdoptionOptions = {},
): Promise<SharedMemoryAdoptionStats> {
  const log = opts.log ?? console.log;
  const stats: SharedMemoryAdoptionStats = {
    adopted: 0,
    alreadyKeyed: 0,
    skipped: 0,
    stillCompoundUrn: 0,
  };

  // Candidate set: app-class, App-scoped, not yet keyed. Narrowed by indexed
  // columns only — the `:shared` shape is matched in memory, because Prisma's
  // string filters compile to SQL LIKE and a legal slug may contain `_` (see
  // sharedMemoryLegacyKey.ts).
  const rows = await db.memory.findMany({
    where: { class: 'app', appId: { not: null }, sharedMemoryOfAgentId: null },
    select: { id: true, urn: true, legacyUrn: true, appId: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

  stats.alreadyKeyed = await db.memory.count({
    where: { sharedMemoryOfAgentId: { not: null } },
  });

  /**
   * Pairings this run has already spoken for. In an APPLY run the DB holds
   * them, but a DRY RUN writes nothing — without this, two unkeyed rows for the
   * same pairing would both be previewed as adoptable and the preview would
   * disagree with what the apply run does (the `claimed` set in the #697
   * backfill exists for the same reason).
   */
  const claimed = new Set<string>();
  /** Rows this run plans to adopt whose urn is compound (dry-run accounting). */
  const plannedCompound = new Set<string>();

  for (const row of rows) {
    const slug = sharedUrnAgentSlug(row.urn) ?? sharedUrnAgentSlug(row.legacyUrn);
    if (!slug) continue; // e.g. a flat `<root>:shared` — not a string-keyed row.

    const installed = await db.appAgent.findMany({
      where: { appId: row.appId! },
      select: { agent: { select: { id: true, urn: true, legacyUrn: true, name: true } } },
    });
    const matches = installed
      .map((r) => r.agent)
      .filter((a): a is NonNullable<typeof a> => !!a)
      .filter((a) => memoryCarriesLegacyKeyFor(row, agentSlugCandidates(a)));

    if (matches.length === 0) {
      stats.skipped += 1;
      log(`  ✗ ${row.id} (${row.urn}): no installed Agent slugged "${slug}" in this App`);
      continue;
    }
    if (matches.length > 1) {
      stats.skipped += 1;
      log(
        `  ✗ ${row.id} (${row.urn}): slug "${slug}" matches ${matches.length} installed Agents ` +
          `(${matches.map((a) => a.id).join(', ')}) — not guessing`,
      );
      continue;
    }
    const agent = matches[0]!;
    const pairing = `${row.appId}::${agent.id}`;

    // The pairing may already be held — by a row adopted earlier in this run, by
    // the migration, or by a memory provisioned after the App was renamed. The
    // holder keeps it; this row stays unkeyed and gets reported.
    const holder = claimed.has(pairing)
      ? { id: '(claimed earlier in this run)', urn: '' }
      : await db.memory.findUnique({
          where: {
            appId_sharedMemoryOfAgentId: { appId: row.appId!, sharedMemoryOfAgentId: agent.id },
          },
          select: { id: true, urn: true },
        });
    if (holder) {
      stats.skipped += 1;
      log(
        `  ✗ ${row.id} (${row.urn}): the (App, ${agent.name}) pairing is already held by ` +
          `${holder.id}${holder.urn ? ` (${holder.urn})` : ''} — resolve by hand if this row ` +
          'holds real content',
      );
      continue;
    }

    log(`  → ${row.id} (${row.urn}): adopt as the shared memory of ${agent.name} (${agent.id})`);
    stats.adopted += 1;
    claimed.add(pairing);
    if (hasCompoundUrn(row.urn)) plannedCompound.add(row.id);
    if (opts.dryRun) continue;

    // Guarded on the column still being null so a concurrent lazy adoption in
    // findOrCreateAppClassMemory is never overwritten.
    const written = await db.memory.updateMany({
      where: { id: row.id, sharedMemoryOfAgentId: null },
      data: { sharedMemoryOfAgentId: agent.id },
    });
    if (written.count === 0) {
      stats.adopted -= 1;
      stats.skipped += 1;
      claimed.delete(pairing);
      plannedCompound.delete(row.id);
      log(`  · ${row.id}: claimed by a concurrent writer — left as found`);
    }
  }

  // Every keyed shared memory still on a compound address, INCLUDING the ones
  // the migration adopted and (in a dry run) the ones this run would adopt.
  const keyed = await db.memory.findMany({
    where: { sharedMemoryOfAgentId: { not: null } },
    select: { id: true, urn: true },
  });
  const compound = new Set(keyed.filter((m) => hasCompoundUrn(m.urn)).map((m) => m.id));
  for (const id of plannedCompound) compound.add(id);
  stats.stillCompoundUrn = compound.size;

  return stats;
}
