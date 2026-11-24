/**
 * #5078 (Billing A7d): compare every memory's stored live-node figure with a recount, and repair the ones that differ.
 *
 *   DATABASE_URL=<url> pnpm tsx scripts/db/reconcile-memory-node-totals.ts            # dry run: reports, writes nothing
 *   DATABASE_URL=<url> pnpm tsx scripts/db/reconcile-memory-node-totals.ts --apply    # repair
 *
 * RUN IT after anything that writes `nodes` with the triggers off, the only known way a figure drifts:
 *   - `ALTER TABLE nodes DISABLE TRIGGER …`,
 *   - `session_replication_role = replica`,
 *   - a data-only load with triggers disabled (`pg_restore --data-only --disable-triggers`).
 * A full restore needs nothing: `memory_node_totals` comes from the same snapshot, so never exclude that table from a dump.
 * Until then `OWNER_NODE_COUNT_SOURCE=on-demand` makes every answer a recount.
 *
 * NO production run, not even the dry run, is granted by this file: it needs its own register grant (CLAUDE.md, "Production
 * database"). Output is memory ids and the two figures only. The dry run is one statement, so it never reports a write in progress.
 *
 * `--apply` is safe beside live writers and safe to repeat: each memory is repaired in its own transaction (see `repairMemoryNodeTotal`).
 *
 * Exit codes: 0 no drift, or all of it repaired; 1 drift found (dry run) or failed; 2 usage.
 */
import { pathToFileURL } from 'node:url';
import { PrismaClient } from '../../src/generated/prisma/index.js';
import { findMemoryNodeTotalDrift, repairMemoryNodeTotal } from '../../src/lib/ownerLimits/nodeTotals.js';

const TAG = 'db.memory_node_totals_reconcile';

export interface ReconcileNodeTotalsIo {
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
}

export async function main(argv: readonly string[], io: ReconcileNodeTotalsIo): Promise<number> {
  const apply = argv.length === 1 && argv[0] === '--apply';
  if (argv.length !== 0 && !apply) {
    io.log(`${TAG}.usage: [--apply]`);
    return 2;
  }
  if (!io.env.DATABASE_URL) {
    io.log(`${TAG}.database_url_missing`);
    return 2;
  }
  let db: PrismaClient | undefined;
  try {
    db = new PrismaClient({ datasourceUrl: io.env.DATABASE_URL });
    const drift = await findMemoryNodeTotalDrift(db);
    for (const d of drift) io.log(`${TAG}.drift memory=${d.memoryId} stored=${d.stored} counted=${d.counted}`);
    if (apply) for (const d of drift) await repairMemoryNodeTotal(db, d.memoryId);
    io.log(`${TAG} ${apply ? 'applied' : 'dry_run'} drifted=${drift.length}`);
    return drift.length > 0 && !apply ? 1 : 0;
  } catch (error) {
    // The class and code only, never the message: it can carry the URL.
    const name = error instanceof Error ? error.constructor.name : typeof error;
    const code = (error as { code?: unknown } | null)?.code;
    io.log(`${TAG}.failed error=${/^\w+$/.test(name) ? name : 'unknown'}${typeof code === 'string' && /^\w+$/.test(code) ? ` code=${code}` : ''}`);
    return 1;
  } finally {
    await db?.$disconnect().catch(() => {});
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2), { env: process.env, log: (line) => console.log(line) })
    .then((code) => { process.exitCode = code; })
    .catch(() => { console.log(`${TAG}.failed error=unknown`); process.exitCode = 1; });
}
