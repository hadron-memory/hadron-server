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
  } catch (error) {
    // #4719 BLIND P2-1: name the failure so a failed connect can be told from a failed query, but print only the
    // error's class and its code (Prisma's Pnnnn, or a SQLSTATE), never its message, which can carry the URL.
    const name = error instanceof Error ? error.constructor.name : typeof error;
    const code = (error as { code?: unknown; errorCode?: unknown } | null)?.code ?? (error as { errorCode?: unknown } | null)?.errorCode;
    io.log(`${TAG}.failed error=${/^\w+$/.test(name) ? name : 'unknown'}${typeof code === 'string' && /^\w+$/.test(code) ? ` code=${code}` : ''}`);
    return 1;
  } finally {
    await db.$disconnect();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  // #4719 BLIND P3-2: exitCode rather than exit(), so buffered output is not cut off; a rejection outside main's own
  // catch (the log or the disconnect) still ends with exit 1 and a failure line.
  main(process.argv.slice(2), { env: process.env, log: (line) => console.log(line) })
    .then((code) => { process.exitCode = code; })
    .catch(() => { console.log(`${TAG}.failed error=unknown`); process.exitCode = 1; });
}
