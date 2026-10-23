/**
 * #2199 (cor:rag:010:01 r17) — the one-off, OPERATOR-run backfill that gives the nodes of every existing
 * `class = 'system'` memory their summary (abstract) vector.
 *
 * It is a bounded walk through the normal embedding queue, never a request-time embed and never raw SQL: each step
 * stamps `embeddingPendingAt` on the nodes that need a summary vector (`stampMemoryEmbeddingsBatch`) and the existing
 * fair drain embeds them at its own pace. Properties:
 *
 *  - DRY RUN BY DEFAULT: without `--apply` nothing is written; it reports what a run would stamp, over the SAME
 *    bounded window an apply would cover.
 *  - BOUNDED BY WORK: `--node-limit N` caps the nodes INSPECTED per run (default 500), `--memory-limit M` the memories
 *    started (default 25), `--batch N` the window per query (default 100). Every query runs under a statement timeout.
 *  - RESUMABLE: the report ends with a cursor `memoryId:nodeId`; `--after <cursor>` continues exactly there. The cursor
 *    advances over nodes that were skipped (already indexed, already queued, no abstract), so a run never loops on
 *    nothing and never passes over an eligible node.
 *  - IDEMPOTENT: a re-run stamps only what is still missing; a node with no abstract is never requeued forever.
 *  - PARTIAL RESULTS ARE SAID: `complete: false` means the budget ended the run before the walk did.
 *
 * It is NOT scheduled at boot. Running it against production needs the recorded grant (authorizations register); code
 * deploy and the production run are separate acts.
 *
 *   pnpm tsx src/jobs/backfillSystemMemoryEmbeddings.ts [--apply] [--node-limit N] [--memory-limit M] [--batch N] [--after memoryId:nodeId]
 */

import type { PrismaClient } from '../generated/prisma/index.js';
import { stampMemoryEmbeddingsBatch, publishEmbedWake } from '../services/embedding/enqueue.js';
import { SYSTEM_MEMORY_CLASS } from '../lib/embedding/indexing.js';

export const BACKFILL_STATEMENT_TIMEOUT_MS = 10_000;

export type SystemEmbeddingBackfillOptions = {
  apply?: boolean;
  nodeLimit?: number;
  memoryLimit?: number;
  batch?: number;
  /** `memoryId:nodeId` of the last inspected node (or `memoryId:` to start inside a memory); omit to start. */
  after?: string | null;
};

export type SystemEmbeddingBackfillReport = {
  mode: 'dry-run' | 'apply';
  memoriesStarted: number;
  inspected: number;
  eligible: number;
  stamped: number;
  /** Live encrypted system memories (expected 0: only private memories encrypt). Check it is 0 before an apply. */
  encryptedSystemMemories: number;
  perMemory: { memoryId: string; urn: string; inspected: number; eligible: number; stamped: number; done: boolean }[];
  /** Pass to `--after` to continue; null when the walk is complete. */
  cursor: string | null;
  complete: boolean;
};

/**
 * The command line, strictly: only the known flags, each number a plain positive integer, `--after` a `memoryId:nodeId`
 * cursor. An unknown or malformed flag throws — a typo must never silently drop a bound the operator thought they set.
 */
export function parseBackfillArgs(argv: readonly string[]): SystemEmbeddingBackfillOptions {
  const out: SystemEmbeddingBackfillOptions = {};
  const positive = (flag: string, raw: string | undefined): number => {
    if (raw === undefined || !/^[1-9][0-9]{0,8}$/.test(raw)) throw new Error(`${flag} needs a plain positive integer (got ${JSON.stringify(raw)}).`);
    return Number(raw);
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === '--apply') out.apply = true;
    else if (flag === '--node-limit') out.nodeLimit = positive(flag, argv[++i]);
    else if (flag === '--memory-limit') out.memoryLimit = positive(flag, argv[++i]);
    else if (flag === '--batch') out.batch = positive(flag, argv[++i]);
    else if (flag === '--after') {
      const raw = argv[++i];
      if (!raw || !/^[0-9A-Za-z]+:[0-9A-Za-z]*$/.test(raw)) throw new Error(`--after needs memoryId:nodeId (got ${JSON.stringify(raw)}).`);
      out.after = raw;
    } else throw new Error(`Unknown argument ${JSON.stringify(flag)}.`);
  }
  return out;
}

export function parseCursor(after: string | null | undefined): { memoryId: string; nodeId: string } | null {
  if (!after) return null;
  const i = after.indexOf(':');
  if (i < 0) return { memoryId: after, nodeId: '' };
  return { memoryId: after.slice(0, i), nodeId: after.slice(i + 1) };
}

export async function backfillSystemMemoryEmbeddings(
  db: PrismaClient,
  opts: SystemEmbeddingBackfillOptions = {},
): Promise<SystemEmbeddingBackfillReport> {
  const nodeBudget = Math.max(1, Math.floor(opts.nodeLimit ?? 500));
  const memoryBudget = Math.max(1, Math.floor(opts.memoryLimit ?? 25));
  const batch = Math.max(1, Math.floor(opts.batch ?? 100));
  const apply = opts.apply === true;
  const start = parseCursor(opts.after);
  const report: SystemEmbeddingBackfillReport = {
    mode: apply ? 'apply' : 'dry-run', memoriesStarted: 0, inspected: 0, eligible: 0, stamped: 0, encryptedSystemMemories: 0, perMemory: [],
    cursor: null, complete: true,
  };
  // Memories in id order, from the cursor's memory on. Only live class=system memories: never a user's.
  // Under the same statement timeout as every other query of the job.
  const { memories, encrypted } = await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${BACKFILL_STATEMENT_TIMEOUT_MS}`);
    return {
      memories: await tx.memory.findMany({
        where: { class: SYSTEM_MEMORY_CLASS, deletedAt: null, ...(start ? { id: { gte: start.memoryId } } : {}) },
        orderBy: { id: 'asc' },
        take: memoryBudget + 1,
        select: { id: true, urn: true },
      }),
      encrypted: await tx.memory.count({ where: { class: SYSTEM_MEMORY_CLASS, deletedAt: null, isEncrypted: true } }),
    };
  }, { timeout: BACKFILL_STATEMENT_TIMEOUT_MS + 5_000 });
  report.encryptedSystemMemories = encrypted;
  let remaining = nodeBudget;
  for (const [index, memory] of memories.entries()) {
    if (index >= memoryBudget || remaining <= 0) {
      // Budget ended the run before the walk did: resume at this memory.
      report.complete = false;
      report.cursor = `${memory.id}:`;
      return report;
    }
    let afterNodeId: string | null = start && memory.id === start.memoryId ? start.nodeId : null;
    const row = { memoryId: memory.id, urn: memory.urn, inspected: 0, eligible: 0, stamped: 0, done: false };
    report.memoriesStarted += 1;
    while (remaining > 0) {
      const step = await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${BACKFILL_STATEMENT_TIMEOUT_MS}`);
        return stampMemoryEmbeddingsBatch(tx as unknown as PrismaClient, memory.id, {
          limit: Math.min(batch, remaining), afterNodeId, dryRun: !apply,
        });
      }, { timeout: BACKFILL_STATEMENT_TIMEOUT_MS + 5_000 });
      if (step.stamped > 0) void publishEmbedWake({}); // authoritative step committed
      row.inspected += step.inspected; row.eligible += step.eligible; row.stamped += step.stamped;
      remaining -= step.inspected;
      afterNodeId = step.nextAfterNodeId;
      if (step.done) { row.done = true; break; }
      if (step.inspected === 0) break; // defensive: never spin without progress
    }
    report.inspected += row.inspected; report.eligible += row.eligible; report.stamped += row.stamped;
    report.perMemory.push(row);
    if (!row.done) {
      report.complete = false;
      report.cursor = `${memory.id}:${afterNodeId ?? ''}`;
      return report;
    }
  }
  return report;
}

// Hand-run entry point. It exits explicitly: an apply that stamps anything publishes the drain
// wake, which opens the process-wide bus client, and that open connection would otherwise keep
// the process alive after the report (#2243).
if (process.argv[1] && process.argv[1].endsWith('backfillSystemMemoryEmbeddings.ts')) {
  const { db: prisma } = await import('../integrations/db/client.js');
  const { closeBusClient } = await import('../lib/bus/index.js');
  const shutdown = async (code: number): Promise<never> => {
    await closeBusClient();
    await prisma.$disconnect();
    process.exit(code);
  };
  let parsed: ReturnType<typeof parseBackfillArgs>;
  try {
    parsed = parseBackfillArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${(e as Error).message}\nusage: backfillSystemMemoryEmbeddings.ts [--apply] [--node-limit N] [--memory-limit M] [--batch N] [--after memoryId:nodeId]`);
    await shutdown(2);
  }
  try {
    const apply = parsed!.apply === true;
    const report = await backfillSystemMemoryEmbeddings(prisma, parsed!);
    console.log(JSON.stringify(report, null, 2));
    if (!apply) console.log('\nDry run — nothing written. Re-run with --apply (production needs the recorded grant).');
    if (!report.complete) console.log(`\nPartial: continue with --after ${report.cursor}`);
  } catch (e) {
    console.error(e);
    await shutdown(1);
  }
  await shutdown(0);
}
