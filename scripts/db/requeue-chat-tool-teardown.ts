/**
 * #4847 (cor:int:030:03 clause 4) — the operator's lever on a CAPPED chat tool teardown. After ten failed attempts an intent is
 * CAPPED: one alarm was raised, nothing is retried and nothing is dropped. Once the tool side is fixed (or the tool answers a
 * repeat DELETE with success, hadrontool-telegram#8 and hadrontool-slack#6), this puts a capped intent back in the retry from a
 * clean count; the sweep then attempts it.
 *
 *   DATABASE_URL=<owner url> pnpm tsx scripts/db/requeue-chat-tool-teardown.ts                       # list the capped intents
 *   DATABASE_URL=<owner url> pnpm tsx scripts/db/requeue-chat-tool-teardown.ts --id <intent id> --apply
 *   DATABASE_URL=<owner url> pnpm tsx scripts/db/requeue-chat-tool-teardown.ts --all --apply
 *
 * Run under a register grant, never on the strength of this file or the PR that adds it (CLAUDE.md, "Production database").
 * Ops-script only: no GraphQL, CLI or MCP surface, so nothing here widens who can see a connection (cor:int:030:03). Without
 * `--apply` it lists and writes nothing; the listing carries ids and handles (kind, provider, the tool's connection id), never a
 * token. Only a CAPPED intent is touched: a pending or confirmed one is not.
 *
 * `--id` without `--apply` is a dry run of that one intent. A failure logs the error's name and Prisma code, never the message or URL.
 *
 * Exit codes: 0 ok (listed or requeued), 1 failed, nothing written; 2 usage.
 */
import { pathToFileURL } from 'node:url';
import { PrismaClient } from '../../src/generated/prisma/index.js';
import { listCappedChatToolTeardowns, requeueCappedChatToolTeardowns } from '../../src/lib/chatToolTeardown.js';

const TAG = 'db.chat_tool_teardown_requeue';

export interface RequeueToolIo {
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
}

export async function main(argv: readonly string[], io: RequeueToolIo): Promise<number> {
  const apply = argv.includes('--apply');
  const rest = argv.filter((a) => a !== '--apply');
  const all = rest.length === 1 && rest[0] === '--all';
  const byId = rest.length === 2 && rest[0] === '--id' && !!rest[1] && !rest[1].startsWith('--');
  if (rest.length > 0 && !all && !byId) {
    io.log(`${TAG}.usage: [--id <intent id> | --all] [--apply]   (no selector lists the capped intents)`);
    return 2;
  }
  if (apply && !all && !byId) {
    io.log(`${TAG}.usage: --apply needs --id <intent id> or --all`);
    return 2;
  }
  if (!io.env.DATABASE_URL) {
    io.log(`${TAG}.database_url_missing`);
    return 2;
  }
  const db = new PrismaClient({ datasourceUrl: io.env.DATABASE_URL });
  try {
    if (!apply) {
      // A dry run honours the selector: --id lists that one intent (and nothing when it is not capped), --all or none lists every one.
      const capped = await listCappedChatToolTeardowns(db, byId ? { id: rest[1]! } : {});
      for (const c of capped) io.log(`${TAG} capped id=${c.id} kind=${c.kind} provider=${c.provider} tool_connection_id=${c.toolConnectionId} attempts=${c.attempts}`);
      io.log(`${TAG} dry_run capped=${capped.length} (pass --id <id> or --all with --apply to requeue)`);
      return 0;
    }
    const n = await requeueCappedChatToolTeardowns(db, all ? { all: true } : { id: rest[1]! });
    io.log(`${TAG} ok requeued=${n}`);
    return 0;
  } catch (error) {
    // The kind of failure, so an operator is not left guessing: the error's name and a Prisma code, never its message (which can
    // carry the connection string or a value) and never the URL.
    const code = typeof (error as { code?: unknown })?.code === 'string' && /^[A-Za-z0-9_]{1,16}$/.test((error as { code: string }).code) ? (error as { code: string }).code : '-';
    const name = error instanceof Error && /^[A-Za-z0-9_]{1,64}$/.test(error.name) ? error.name : 'Error';
    io.log(`${TAG}.failed name=${name} code=${code}`);
    return 1;
  } finally {
    await db.$disconnect().catch(() => undefined);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main(process.argv.slice(2), { env: process.env, log: (line) => console.error(line) });
}
