/**
 * #5018 (Billing A14, hrn:node:hadronmemory.com:specs:cor:dmo:060:18) — the one-off, OPERATOR-run backfill that fills
 * `nodes.stored_bytes` and `nodes.revision_bytes` on rows written before the triggers existed (null means "not measured yet").
 *
 *  - DRY RUN BY DEFAULT: without `--apply` nothing is written; it reports what an apply over the same window would fill.
 *  - BOUNDED AND RESUMABLE: lowest node id first, over rows with either column null; `--batch N` rows per transaction
 *    (default 1000), `--limit N` rows per run, `--after <id>` to continue from the cursor a partial run printed.
 *  - IDEMPOTENT: a second run finds no null row and changes nothing.
 *  - WRITES ONLY THE TWO COLUMNS, in raw SQL that names no other column, so `updated_at`, `rev_seq` and
 *    `revision_content_hash` are untouched and no node-column trigger fires.
 *  - SAFE AGAINST A CONCURRENT REVISION WRITE: each batch locks its node rows (`FOR UPDATE`, id order) and then their
 *    revision rows (`FOR SHARE`, id order) before it sums anything. A revision INSERT takes the node lock first (it numbers
 *    itself from `rev_seq`, and the foreign key takes a key-share lock the node lock conflicts with); a revision DELETE or
 *    in-place rewrite (`deleteNodeRevision`, `clearNodeHistory`, the encryption pass) locks only the revision row, and on a node
 *    that is not measured yet its trigger finds nothing to update and takes no node lock, so the revision-row lock is what makes
 *    it wait. Whichever goes first, the node ends equal to a full recomputation: a change committed before the locks is summed,
 *    one after them finds a measured node and applies its own difference through the trigger.
 *
 * It is NOT scheduled and never part of a migration. Running it against production needs the recorded grant (authorizations
 * register); code deploy and the production run are separate acts.
 *
 *   pnpm tsx src/jobs/backfillNodeBytes.ts [--apply] [--batch N] [--limit N] [--after <node id>]
 */
import type { Prisma, PrismaClient } from '../generated/prisma/index.js';

export const BACKFILL_STATEMENT_TIMEOUT_MS = 60_000;
export const DEFAULT_BATCH = 1_000;

export interface NodeBytesBackfillOptions {
  /** Called after each committed batch with the cursor to resume from, so a killed run still tells the operator where it was. */
  onBatch?: (cursor: string, filled: number) => void;
  apply?: boolean;
  batch?: number;
  limit?: number;
  /** The id of the last node a previous run handled; omit to start at the lowest. */
  after?: string | null;
}

export interface NodeBytesBackfillReport {
  mode: 'dry-run' | 'apply';
  /** Rows with a null figure that the run looked at. */
  scanned: number;
  /** Rows written (0 in a dry run). */
  filled: number;
  /** Pass to `--after` to continue; null when the walk is complete. */
  cursor: string | null;
  complete: boolean;
}

/** The command line, strictly: an unknown or malformed flag throws, so a typo never silently drops a bound the operator set. */
export function parseBackfillArgs(argv: readonly string[]): NodeBytesBackfillOptions {
  const out: NodeBytesBackfillOptions = {};
  const positive = (flag: string, raw: string | undefined): number => {
    if (raw === undefined || !/^[1-9][0-9]{0,8}$/.test(raw)) throw new Error(`${flag} needs a plain positive integer (got ${JSON.stringify(raw)}).`);
    return Number(raw);
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === '--apply') out.apply = true;
    else if (flag === '--batch') out.batch = positive(flag, argv[++i]);
    else if (flag === '--limit') out.limit = positive(flag, argv[++i]);
    else if (flag === '--after') {
      const raw = argv[++i];
      if (!raw || !/^[0-9A-Za-z_-]+$/.test(raw)) throw new Error(`--after needs a node id (got ${JSON.stringify(raw)}).`);
      out.after = raw;
    } else throw new Error(`Unknown argument ${JSON.stringify(flag)}.`);
  }
  return out;
}

/** The statement is a constant; only the ids are bound. */
const FILL = `
  UPDATE nodes n SET
    stored_bytes = LEAST(hadron_node_state_bytes(n.content, n.description, n.data, n.properties), 2147483647),
    revision_bytes = COALESCE((SELECT sum(hadron_node_state_bytes(r.content, r.description, r.data, r.properties))::bigint
                               FROM node_revisions r WHERE r.node_id = n.id), 0)
  WHERE n.id = ANY($1::text[])`;

/**
 * One batch in the caller's transaction: lock the next `batch` rows that still need a figure (lowest id first, after the
 * cursor), then write both figures for them. Without `apply` it only reads (no lock) and writes nothing. Returns the ids it
 * handled, the last of which is the cursor.
 */
export async function fillNodeBytesBatch(
  tx: Prisma.TransactionClient,
  opts: { after: string | null; batch: number; apply?: boolean },
): Promise<{ ids: string[]; filled: number }> {
  const after = opts.after;
  const ids = (opts.apply === false
    ? await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM nodes WHERE (stored_bytes IS NULL OR revision_bytes IS NULL) AND (${after}::text IS NULL OR id > ${after})
        ORDER BY id LIMIT ${opts.batch}`
    : await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM nodes WHERE (stored_bytes IS NULL OR revision_bytes IS NULL) AND (${after}::text IS NULL OR id > ${after})
        ORDER BY id LIMIT ${opts.batch} FOR UPDATE`).map((r) => r.id);
  if (ids.length === 0 || opts.apply === false) return { ids, filled: 0 };
  // The revision rows too (id order, so two batches never wait on each other in a cycle): see the header.
  await tx.$queryRawUnsafe('SELECT id FROM node_revisions WHERE node_id = ANY($1::text[]) ORDER BY id FOR SHARE', ids);
  const filled = await tx.$executeRawUnsafe(FILL, ids);
  return { ids, filled };
}

export async function backfillNodeBytes(db: PrismaClient, opts: NodeBytesBackfillOptions = {}): Promise<NodeBytesBackfillReport> {
  const apply = opts.apply === true;
  const batch = Math.max(1, Math.floor(opts.batch ?? DEFAULT_BATCH));
  const limit = Math.max(1, Math.floor(opts.limit ?? Number.MAX_SAFE_INTEGER));
  const report: NodeBytesBackfillReport = { mode: apply ? 'apply' : 'dry-run', scanned: 0, filled: 0, cursor: null, complete: true };
  let after: string | null = opts.after ?? null;
  let remaining = limit;
  while (remaining > 0) {
    const step = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${BACKFILL_STATEMENT_TIMEOUT_MS}`);
      return fillNodeBytesBatch(tx, { after, batch: Math.min(batch, remaining), apply });
    }, { timeout: BACKFILL_STATEMENT_TIMEOUT_MS + 5_000 });
    if (step.ids.length === 0) { report.cursor = null; return report; }
    report.scanned += step.ids.length;
    report.filled += step.filled;
    remaining -= step.ids.length;
    after = step.ids[step.ids.length - 1]!;
    report.cursor = after;
    opts.onBatch?.(after, report.filled);
  }
  // The budget ended the run: say so unless nothing is left to do.
  const [more] = await db.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*) AS n FROM (SELECT 1 FROM nodes WHERE (stored_bytes IS NULL OR revision_bytes IS NULL) AND id > ${after} LIMIT 1) t`;
  if (more!.n === 0n) report.cursor = null;
  else report.complete = false;
  return report;
}

// Hand-run entry point (run through tsx, as the usage line says: a compiled or wrapped copy would not match this name and would do nothing).
if (process.argv[1] && process.argv[1].endsWith('backfillNodeBytes.ts')) {
  const { db: prisma } = await import('../integrations/db/client.js');
  const shutdown = async (code: number): Promise<never> => {
    await prisma.$disconnect();
    process.exit(code);
  };
  let parsed: NodeBytesBackfillOptions;
  try {
    parsed = parseBackfillArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${(e as Error).message}\nusage: backfillNodeBytes.ts [--apply] [--batch N] [--limit N] [--after <node id>]`);
    await shutdown(2);
  }
  try {
    const report = await backfillNodeBytes(prisma, { ...parsed!, onBatch: (cursor, filled) => console.error(`batch committed: ${filled} filled so far, resume with --after ${cursor}`) });
    console.log(JSON.stringify(report, null, 2));
    if (parsed!.apply !== true) console.log('\nDry run, nothing written. Re-run with --apply (production needs the recorded grant).');
    if (!report.complete) console.log(`\nPartial: continue with --after ${report.cursor}`);
  } catch (e) {
    console.error(e);
    await shutdown(1);
  }
  await shutdown(0);
}
