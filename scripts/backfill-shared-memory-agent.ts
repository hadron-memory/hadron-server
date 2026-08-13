/**
 * One-time reconciliation: adopt pre-#723 `shared` app-class memories onto the
 * `(appId, sharedMemoryOfAgentId)` column key (see src/lib/sharedMemoryAdoption.ts).
 *
 *   pnpm admin:backfill-shared-memory-agent            # apply
 *   pnpm admin:backfill-shared-memory-agent --dry-run  # report only, write nothing
 *
 * The 20260813120000 migration already adopts the unambiguous rows in bulk, and
 * `findOrCreateAppClassMemory` adopts lazily on the next touch — run this to see
 * what is left and, above all, to have the undecidable cases (no matching Agent,
 * ambiguous slug, pairing already held) REPORTED rather than silently deferred.
 *
 * Safe to run repeatedly — idempotent; already-keyed rows are skipped. Runs
 * against DATABASE_URL. It never rewrites a urn: run `pnpm admin:backfill-urn-v2`
 * for that (it flattens compound urns and parks the old value in `legacyUrn`).
 */
import { PrismaClient } from '../src/generated/prisma/index.js';
import { adoptSharedMemories } from '../src/lib/sharedMemoryAdoption.js';

const dryRun = process.argv.includes('--dry-run');
const db = new PrismaClient();

async function main(): Promise<void> {
  console.log(
    dryRun
      ? 'Shared-memory agent-key adoption — DRY RUN (no writes)\n'
      : 'Shared-memory agent-key adoption — applying…\n',
  );
  const stats = await adoptSharedMemories(db, { dryRun });
  console.log(
    `\n${stats.adopted} adopted, ${stats.alreadyKeyed} already keyed, ${stats.skipped} skipped.`,
  );
  if (stats.stillCompoundUrn > 0) {
    console.log(
      `${stats.stillCompoundUrn} adopted row(s) still carry a COMPOUND urn — node URNs in them ` +
        'do not round-trip (portal links 404). Run `pnpm admin:backfill-urn-v2` to flatten them.',
    );
  }
  if (stats.skipped > 0) {
    console.log('Skipped rows are listed above; each needs a human decision.');
  }
}

main()
  .catch((err) => {
    console.error('Shared-memory adoption failed:', err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
