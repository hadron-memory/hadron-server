/**
 * #3571 (ruling 0223, cor:int:010:01) — the one-off reconciliation of memories the pre-#3568 no-installation path
 * left reading SYNCING. An eligible row (no source, or an organization with no installation; not deleted, not
 * encrypted; no sync running) becomes PENDING and nothing else; see src/integrations/github/reconcileSyncing.ts.
 *
 *   DATABASE_URL=<url> pnpm tsx scripts/db/reconcile-syncing-status.ts            # dry run: counts, writes nothing
 *   DATABASE_URL=<url> pnpm tsx scripts/db/reconcile-syncing-status.ts --apply    # reconcile
 *
 * NO production inventory or repair is granted by this file, the issue or the ruling: running it against production,
 * even as a dry run, needs its own explicit grant (CLAUDE.md, "Production database"). Output is counts only, never an
 * id, name or source; the dry run is operator output, never a database report. A running sync makes its row skip
 * (`held`), and a row whose configuration changed since the scan is skipped (`ineligible`); re-running is safe.
 *
 * Exit codes: 0 ok (dry run or applied), 1 failed, 2 usage.
 */
import { pathToFileURL } from 'node:url';
import { PrismaClient } from '../../src/generated/prisma/index.js';
import { reconcileSyncingStatus } from '../../src/integrations/github/reconcileSyncing.js';

const TAG = 'db.syncing_status_reconcile';

export interface ReconcileSyncingToolIo {
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
}

export async function main(argv: readonly string[], io: ReconcileSyncingToolIo): Promise<number> {
  const apply = argv.length === 1 && argv[0] === '--apply';
  if (argv.length !== 0 && !apply) {
    io.log(`${TAG}.usage: [--apply]`);
    return 2;
  }
  if (!io.env.DATABASE_URL) {
    io.log(`${TAG}.database_url_missing`);
    return 2;
  }
  const db = new PrismaClient({ datasourceUrl: io.env.DATABASE_URL });
  try {
    const r = await reconcileSyncingStatus(db, { apply });
    io.log(apply
      ? `${TAG} ok candidates=${r.candidates} reconciled=${r.reconciled} held=${r.held} ineligible=${r.ineligible} uncovered=${r.uncovered}`
      : `${TAG} dry_run candidates=${r.candidates} uncovered=${r.uncovered} (pass --apply to reconcile)`);
    return 0;
  } catch {
    io.log(`${TAG}.failed`);
    return 1;
  } finally {
    await db.$disconnect();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2), { env: process.env, log: (line) => console.log(line) }).then((code) => process.exit(code));
}
