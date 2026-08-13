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
 * This module owns (2). It is deliberately conservative: a candidate that
 * resolves to no Agent, to more than one, or to a pairing already held by
 * another row is reported and SKIPPED, never guessed at — an adoption points a
 * team's chat and worklog at a memory, so a wrong one is worse than a manual fix.
 *
 * It does NOT rewrite any urn. Flattening an existing memory's address is the
 * #697 backfill's job (`pnpm admin:backfill-urn-v2`), which parks the old value
 * in `legacyUrn` so existing references keep resolving; this sweep counts the
 * rows still waiting for it so the operator knows to run it.
 */

import type { PrismaClient } from '../generated/prisma/index.js';
import { normalizeUrnForLookup } from './urn.js';

/** Outcome tally for one sweep. */
export interface SharedMemoryAdoptionStats {
  /** Rows that gained `sharedMemoryOfAgentId`. */
  adopted: number;
  /** Rows already carrying the column (nothing to do). */
  alreadyKeyed: number;
  /** Candidates left alone — no agent match, ambiguous, or pairing taken. */
  skipped: number;
  /** Adopted rows whose urn is still compound (needs `admin:backfill-urn-v2`). */
  stillCompoundUrn: number;
}

/** Options controlling a sweep. */
export interface SharedMemoryAdoptionOptions {
  /** Compute + log every row, write nothing. */
  dryRun?: boolean;
  /** Structured line logger; defaults to `console.log`. */
  log?: (msg: string) => void;
}

/**
 * The agent slug embedded in a pre-#723 shared-memory urn: the penultimate atom
 * of `<root>:<app>:<agent-slug>:shared`. Returns null unless the urn really has
 * that shape — at least three atoms and a `:shared` terminal — so a flat
 * `<root>:shared` can never be read as `<agent>:shared`.
 */
export function sharedUrnAgentSlug(urn: string | null): string | null {
  if (!urn) return null;
  const atoms = normalizeUrnForLookup(urn).split(':');
  if (atoms.length < 3) return null;
  if (atoms[atoms.length - 1] !== 'shared') return null;
  const slug = atoms[atoms.length - 2]!;
  if (slug.length === 0) return null;
  // `…:<agent>:app-mem:<name>` is a NAME-addressable createMemoryInApp memory
  // that happens to be called "shared" — the marker sits where the agent slug
  // would be, so exclude it rather than report a phantom "no Agent slugged
  // app-mem" every run.
  if (slug === 'app-mem') return null;
  return slug;
}

/**
 * The slug an Agent contributes to that string key: everything after the first
 * atom of its urn (the rule `findOrCreateAppClassMemory` used when it minted
 * the key). Both the current and the pre-#697 urn count — the Task-A sweep can
 * have re-slugged the Agent since the memory urn was written.
 */
function agentSlugCandidates(agent: { urn: string; legacyUrn: string | null }): string[] {
  const slugs = [agent.urn, agent.legacyUrn]
    .filter((u): u is string => !!u)
    .map((u) => normalizeUrnForLookup(u).split(':').slice(1).join(':'))
    .filter((s) => s.length > 0);
  return Array.from(new Set(slugs));
}

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

  // Candidate set: app-class, App-scoped, not yet keyed, and carrying the old
  // string key in `urn` or (post-Task-A) `legacyUrn`. The `:shared` terminal is
  // matched in SQL only to narrow the scan — sharedUrnAgentSlug re-validates the
  // full shape below.
  const rows = await db.memory.findMany({
    where: {
      class: 'app',
      appId: { not: null },
      sharedMemoryOfAgentId: null,
      OR: [{ urn: { endsWith: ':shared' } }, { legacyUrn: { endsWith: ':shared' } }],
    },
    select: { id: true, urn: true, legacyUrn: true, appId: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

  stats.alreadyKeyed = await db.memory.count({
    where: { sharedMemoryOfAgentId: { not: null } },
  });

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
      .filter((a) => agentSlugCandidates(a).includes(slug));

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

    // The pairing may already be held — by a row adopted earlier in this run, by
    // the migration, or by a memory provisioned after the App was renamed. The
    // holder keeps it; this row stays unkeyed and gets reported.
    const holder = await db.memory.findUnique({
      where: { appId_sharedMemoryOfAgentId: { appId: row.appId!, sharedMemoryOfAgentId: agent.id } },
      select: { id: true, urn: true },
    });
    if (holder) {
      stats.skipped += 1;
      log(
        `  ✗ ${row.id} (${row.urn}): the (App, ${agent.name}) pairing is already held by ` +
          `${holder.id} (${holder.urn}) — resolve by hand if this row holds real content`,
      );
      continue;
    }

    log(`  → ${row.id} (${row.urn}): adopt as the shared memory of ${agent.name} (${agent.id})`);
    stats.adopted += 1;
    if (normalizeUrnForLookup(row.urn).split(':').length > 2) stats.stillCompoundUrn += 1;
    if (opts.dryRun) continue;

    // Guarded on the column still being null so a concurrent lazy adoption in
    // findOrCreateAppClassMemory is never overwritten.
    const claimed = await db.memory.updateMany({
      where: { id: row.id, sharedMemoryOfAgentId: null },
      data: { sharedMemoryOfAgentId: agent.id },
    });
    if (claimed.count === 0) {
      stats.adopted -= 1;
      stats.skipped += 1;
      log(`  · ${row.id}: claimed by a concurrent writer — left as found`);
    }
  }

  return stats;
}
