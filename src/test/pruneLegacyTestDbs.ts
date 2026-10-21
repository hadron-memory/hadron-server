/**
 * Drop pre-#1091 `<base>_<digits>` test clones.
 *
 * These are the databases created by a checkout from before worker clones were
 * scoped by run. The automated sweep in `globalSetup` deliberately leaves them
 * alone: it can prove a RUN-SCOPED clone is dead (its pid is gone) and it can
 * prove nothing about an unscoped one, and "no open connections" is not proof —
 * a worker between its CREATE DATABASE and its first connection has none either
 * (#1136 review, Codex P2).
 *
 * Manual --apply requires ALL runs/namespaces sharing this endpoint to be
 * quiescent, not just a PID absent in this process table (#1137). This tool
 * does not establish that fact and does not collect pid-only r<pid> clones,
 * prior-boot/foreign tokens, or graph roots. Do not extend it using local PID
 * absence as ownership evidence.
 *
 * So they may be collected by hand once that quiescence is established. They cost disk and nothing else: a run-scoped name can never
 * equal an unscoped one, so no run can adopt one, and nothing creates them any
 * more.
 *
 *   pnpm db:test-prune-legacy          # list them
 *   pnpm db:test-prune-legacy --apply  # drop them
 *
 * Deliberately NOT `WITH (FORCE)`: if something IS connected, that is a running
 * suite and the drop should fail rather than evict it.
 */
import { Client } from 'pg';
import { baseDbName, maintenanceUrl, parseWorkerDbName, quoteDbIdent } from './dbWorkers.js';

const apply = process.argv.includes('--apply');

const base = baseDbName();
const admin = new Client({ connectionString: maintenanceUrl() });
await admin.connect();
try {
  const { rows } = await admin.query<{ datname: string }>('SELECT datname FROM pg_database');
  const legacy = rows
    .map((r) => parseWorkerDbName(r.datname, base))
    .filter((c) => c !== null && c.runId === null);

  if (legacy.length === 0) {
    console.log(`No legacy ${base}_<n> clones found.`);
  } else if (!apply) {
    console.log(`${legacy.length} legacy clone(s) — re-run with --apply to drop:`);
    for (const c of legacy) console.log(`  ${c!.datname}`);
  } else {
    for (const c of legacy) {
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${quoteDbIdent(c!.datname)}`);
        console.log(`dropped ${c!.datname}`);
      } catch (e) {
        // Almost always 55006: a pre-#1091 suite is using it right now. Say so
        // and move on rather than forcing it off.
        console.log(`SKIPPED ${c!.datname} — ${(e as Error).message}`);
      }
    }
  }
} finally {
  await admin.end();
}
