/**
 * #5394 PR 2 (cor:cht:010:02; Holger's ruling 2c, 2026-11-27): delete the per-user chat memories the removed no-App route of `startChat`
 * wrote. PR 1 (#5407) made that shape impossible to write again; this removes the rows that already exist.
 *
 *   DATABASE_URL=<url> pnpm tsx scripts/db/delete-no-app-chat-memories-5394.ts            # dry run (the default): count and ids, writes nothing
 *   DATABASE_URL=<url> pnpm tsx scripts/db/delete-no-app-chat-memories-5394.ts --apply    # delete them, at most MAX_APPLY_ROWS
 *
 * PREDICATE (the issue's, verbatim): `memories` with `class = 'knowledge'`, `app_id IS NULL`, `user_memory_of_agent_id IS NOT NULL`,
 * `user_id IS NULL`, `deleted_at IS NULL`. Only the no-App route ever wrote this shape.
 *
 * VEHICLE: each memory is deleted through `deleteMemory`'s own transactional path (`deleteMemoryInTx`, shared with the resolver), one
 * transaction per memory, so it takes exactly what a `deleteMemory` takes and nothing more: the memory row's `deleted_at`, and its live
 * assets' `deleted_at` at the same instant (the asset janitor purges their bytes after its recovery window). Nodes, chat roots, messages,
 * Agent subscriptions and member rows stay behind the tombstoned memory, as for every deleteMemory. Not a migration, and no raw SQL
 * delete. The caller check the resolver makes (an org admin's `memory.delete`) is replaced by the predicate itself, re-judged on the row
 * under its `FOR UPDATE` lock: a row that left the predicate since the read (restored to an App, given an owner, already deleted) is
 * skipped, never deleted. The authority for the run is the production register row, not this file.
 *
 * REFUSALS deleteMemory makes are kept, per memory, and the script reports and skips that memory (the others still run; exit 4):
 *   - `MEMORY_HOSTS_CHANNEL`: the memory hosts a live Channel;
 *   - `SPEC_MINTED_PERMANENT`: the memory holds a minted spec (a minted node BLOCKS the delete; nothing of that memory is written);
 *   - `QUESTION_CONTAINED`: the memory holds a question or a question log.
 * The script never forces past one of these: a skipped memory goes back to whoever granted the run.
 *
 * CAP: `--apply` re-counts first and refuses outright (exit 3, nothing written) when more than MAX_APPLY_ROWS rows match: the production
 * register grant covers at most 4 rows (Hugo's count, #5394 comment 7239146699); more means stop and go back to Holger. It also never
 * deletes more than MAX_APPLY_ROWS in one run.
 *
 * NO production run, not even the dry run, is granted by this file: each needs its own register grant (CLAUDE.md, "Production database").
 * The output is counts and memory ids, never a name or content. Post only the count in public.
 *
 * Exit codes: 0 done; 1 failed; 2 usage; 3 over the cap (nothing applied); 4 applied, but one or more memories refused and were skipped.
 */
import { pathToFileURL } from 'node:url';
import { GraphQLError } from 'graphql';
import { PrismaClient, type Memory, type Prisma } from '../../src/generated/prisma/index.js';
import { deleteMemoryInTx } from '../../src/api/graphql/schema/memoryDelete.js';
import type { Context } from '../../src/api/graphql/schema/resolvers.helpers.js';

const TAG = 'db.delete_no_app_chat_memories_5394';

/** The production register grant's cap (#5394, coordination:authorizations): at most 4 rows. */
export const MAX_APPLY_ROWS = 4;

/** The #5394 PR 2 predicate, as a Prisma filter. */
export const NO_APP_CHAT_MEMORY_WHERE = {
  class: 'knowledge',
  appId: null,
  userMemoryOfAgentId: { not: null },
  userId: null,
  deletedAt: null,
} as const satisfies Prisma.MemoryWhereInput;

/** The same predicate judged on one row, under its lock. */
export function matchesNoAppChatMemory(m: Pick<Memory, 'class' | 'appId' | 'userMemoryOfAgentId' | 'userId' | 'deletedAt'>): boolean {
  return m.class === 'knowledge' && m.appId === null && m.userMemoryOfAgentId !== null && m.userId === null && m.deletedAt === null;
}

const OUT_OF_SCOPE = 'OUT_OF_SCOPE';

export interface DeleteIo {
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  /** @internal Test seam: runs after the apply's read and before its first delete, to let a test change the data in that gap. */
  afterRead?: () => Promise<void>;
}

export async function main(argv: readonly string[], io: DeleteIo): Promise<number> {
  const apply = argv.length === 1 && argv[0] === '--apply';
  const dryRun = argv.length === 0 || (argv.length === 1 && argv[0] === '--dry-run');
  if (!apply && !dryRun) {
    io.log(`${TAG}.usage: [--dry-run | --apply]`);
    return 2;
  }
  if (!io.env.DATABASE_URL) {
    io.log(`${TAG}.database_url_missing`);
    return 2;
  }
  let db: PrismaClient | undefined;
  let deleted = 0;
  try {
    db = new PrismaClient({ datasourceUrl: io.env.DATABASE_URL });
    const rows = await db.memory.findMany({ where: NO_APP_CHAT_MEMORY_WHERE, select: { id: true }, orderBy: { id: 'asc' } });
    for (const r of rows) io.log(`${TAG}.match id=${r.id}`);
    if (!apply) {
      io.log(`${TAG} dry_run count=${rows.length}`);
      return 0;
    }
    if (rows.length > MAX_APPLY_ROWS) {
      io.log(`${TAG}.over_cap count=${rows.length} cap=${MAX_APPLY_ROWS} applied=0`);
      return 3;
    }
    await io.afterRead?.();
    let skipped = 0;
    for (const { id } of rows) {
      try {
        const ctx = { db, userId: null, roles: [] } as unknown as Context;
        const wrote = await db.$transaction((tx) =>
          deleteMemoryInTx(tx, { ...ctx, db: tx } as unknown as Context, id, async (_tx, current) => {
            if (!matchesNoAppChatMemory(current)) {
              throw new GraphQLError('The memory no longer matches the #5394 predicate.', { extensions: { code: OUT_OF_SCOPE } });
            }
          }),
        );
        if (wrote) {
          deleted += 1;
          io.log(`${TAG}.deleted id=${id}`);
        } else {
          // Unreachable while the predicate requires deleted_at IS NULL under the lock; kept so a change there cannot miscount.
          skipped += 1;
          io.log(`${TAG}.skipped id=${id} code=ALREADY_DELETED`);
        }
      } catch (error) {
        const code = error instanceof GraphQLError ? error.extensions?.code : undefined;
        if (typeof code !== 'string') throw error;
        skipped += 1;
        io.log(`${TAG}.skipped id=${id} code=${code}`);
      }
    }
    io.log(`${TAG} applied deleted=${deleted} skipped=${skipped}`);
    return skipped > 0 ? 4 : 0;
  } catch (error) {
    // The class and code only, never the message: it can carry the URL.
    const name = error instanceof Error ? error.constructor.name : typeof error;
    const code = (error as { code?: unknown } | null)?.code;
    io.log(`${TAG}.failed deleted_so_far=${deleted} error=${/^\w+$/.test(name) ? name : 'unknown'}${typeof code === 'string' && /^\w+$/.test(code) ? ` code=${code}` : ''}`);
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
