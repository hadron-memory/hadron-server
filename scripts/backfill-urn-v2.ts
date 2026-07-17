/**
 * One-time online migration: populate the URN grammar-v2 stored alias map (#697).
 *
 * For every not-yet-normalized LIVE Memory/Agent/App row, compute the flat v2
 * `urn`, stash the old value in `legacyUrn`, and mark `urnNormalizedAt`. This is
 * what makes the (already-wired) `resolve{Memory,Agent,App}Ref` legacy fallback
 * come alive. Node/Edge/NodeRevision URNs are computed and self-heal.
 *
 *   pnpm admin:backfill-urn-v2            # apply
 *   pnpm admin:backfill-urn-v2 --dry-run  # preview every pending row, write nothing
 *
 * Safe to run multiple times — idempotent and resumable (only rows still pending
 * are touched). Runs against DATABASE_URL. MUST run only AFTER #692 (the pool)
 * is deployed — every root must resolve to a live Principal. See epic #691.
 */
import { PrismaClient } from '../src/generated/prisma/index.js';
import { backfillUrnV2 } from '../src/lib/urnMigration/backfill.js';

const dryRun = process.argv.includes('--dry-run');
const db = new PrismaClient();

async function main(): Promise<void> {
  console.log(
    dryRun
      ? 'URN v2 backfill — DRY RUN (no writes; previews every pending row)\n'
      : 'URN v2 backfill — applying…\n',
  );
  const results = await backfillUrnV2(db, { dryRun });

  const totals = results.reduce(
    (acc, r) => ({
      migrated: acc.migrated + r.migrated,
      unchanged: acc.unchanged + r.unchanged,
      failed: acc.failed + r.failed,
    }),
    { migrated: 0, unchanged: 0, failed: 0 },
  );
  console.log(
    `\nTotal: ${totals.migrated} migrated, ${totals.unchanged} unchanged, ${totals.failed} failed.`,
  );
  if (totals.failed > 0) {
    console.log('Failed rows recorded urn_migration_failed_reason; inspect and re-run once resolved.');
  }
}

main()
  .catch((err) => {
    console.error('URN v2 backfill failed:', err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
