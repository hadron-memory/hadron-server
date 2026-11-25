/**
 * #5136 (follow-up of #5124; cor:dmo:060:13, cor:acl:150:02): soft-delete the live files of memories that were deleted BEFORE #5124, so
 * the retention janitor reclaims their bytes and `assetBytes` drains.
 *
 *   DATABASE_URL=<url> pnpm tsx scripts/db/backfill-deleted-memory-assets-5136.ts            # dry run: counts and bytes per owner, writes nothing
 *   DATABASE_URL=<url> pnpm tsx scripts/db/backfill-deleted-memory-assets-5136.ts --apply    # soft-delete, in bounded batches
 *
 * The gate's three decisions (hadron-server#5136, CHECKED):
 *   - INSTANT: the run instant, one value taken when `--apply` starts and stamped on every file, so each file gets the full recovery window.
 *     (Not the memory's own `deletedAt`: the next janitor pass would destroy the bytes at once, and the window is this backfill's only undo.)
 *   - SCOPE: exactly the live files (`deleted_at IS NULL`) of soft-deleted memories (`memories.deleted_at IS NOT NULL`). Never a live
 *     memory's file, never a staged file with no memory, never a BLOCKED tombstone (cor:dmo:060:12 owns those).
 *   - VEHICLE: this script, not a migration.
 *
 * Safe to repeat and beside live writers: a batch is one guarded updateMany that re-checks the scope on every row it writes, so a second apply
 * finds nothing and a file restored or a memory restored meanwhile is never touched. Batches are `BATCH_SIZE` rows.
 *
 * NO production run, not even the dry run, is granted by this file: it needs its own register grant (CLAUDE.md, "Production database").
 * Output is counts, byte totals and owner ids, never a filename or storage key.
 *
 * Exit codes: 0 done (dry run: nothing to do, or reported); 1 failed; 2 usage.
 */
import { pathToFileURL } from 'node:url';
import { PrismaClient } from '../../src/generated/prisma/index.js';

const TAG = 'db.backfill_deleted_memory_assets_5136';
export const BATCH_SIZE = 500;

export interface BackfillIo {
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  /** The run instant. Injected by tests; defaults to the process clock. */
  now?: () => Date;
}

interface OwnerRow { owner: string; files: bigint; bytes: bigint }

export async function main(argv: readonly string[], io: BackfillIo): Promise<number> {
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
    const owners = await db.$queryRaw<OwnerRow[]>`
      SELECT COALESCE('org:' || m.organization_id, 'user:' || m.owner_user_id, 'none') AS owner,
             count(*)::bigint AS files, COALESCE(sum(a.size_bytes), 0)::bigint AS bytes
      FROM assets a JOIN memories m ON m.id = a.memory_id
      WHERE m.deleted_at IS NOT NULL AND a.deleted_at IS NULL AND a.scan_status <> 'BLOCKED'
      GROUP BY 1 ORDER BY 1`;
    let files = 0n;
    let bytes = 0n;
    for (const o of owners) {
      files += o.files;
      bytes += o.bytes;
      io.log(`${TAG}.owner owner=${o.owner} files=${o.files} bytes=${o.bytes}`);
    }
    if (!apply) {
      io.log(`${TAG} dry_run owners=${owners.length} files=${files} bytes=${bytes}`);
      return 0;
    }
    const at = io.now ? io.now() : new Date();
    let done = 0;
    const inScope = { deletedAt: null, scanStatus: { not: 'BLOCKED' as const }, memory: { is: { deletedAt: { not: null } } } };
    for (;;) {
      const ids = (await db.asset.findMany({ where: inScope, select: { id: true }, orderBy: { id: 'asc' }, take: BATCH_SIZE })).map((r) => r.id);
      if (ids.length === 0) break;
      // The scope is re-checked on the write: a file restored, blocked or a memory restored since the read is left alone.
      const { count } = await db.asset.updateMany({ where: { id: { in: ids }, ...inScope }, data: { deletedAt: at } });
      done += count;
      io.log(`${TAG}.batch rows=${count} total=${done}`);
      if (count === 0) break;
    }
    io.log(`${TAG} applied files=${done} at=${at.toISOString()}`);
    return 0;
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
