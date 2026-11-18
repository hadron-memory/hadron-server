/**
 * #3833 retrofit: give every live Agent's system memory the skeleton parents (boot, boot:rules, processes,
 * tasks) its effective memory lacks. System memories only, never install memories; creates absent locs only;
 * bases before children so a child never hides its base's node. See src/lib/agentSkeleton.ts.
 *
 *   pnpm tsx scripts/backfill-agent-skeleton-3833.ts --dry-run   # report only
 *   pnpm tsx scripts/backfill-agent-skeleton-3833.ts             # apply
 *
 * Runs against DATABASE_URL. Idempotent. Production runs need their own register grant.
 */
import { PrismaClient } from '../src/generated/prisma/index.js';
import { retrofitAgentSkeletons } from '../src/lib/agentSkeleton.js';
import { backfillMemoryEmbeddings } from '../src/services/embedding/enqueue.js';

const dryRun = process.argv.includes('--dry-run');
const db = new PrismaClient();

async function main(): Promise<void> {
  const rows = await retrofitAgentSkeletons(db, { dryRun });
  let total = 0;
  for (const r of rows) {
    if (r.created.length) console.log(`${dryRun ? 'would create' : 'created'} ${r.created.join(', ')} in ${r.agentUrn}`);
    total += r.created.length;
    if (!dryRun && r.created.length) await backfillMemoryEmbeddings(db, r.memoryId).catch((e) => console.warn('embedding stamp failed', r.agentUrn, e));
  }
  console.log(`${rows.length} system memories checked, ${total} node(s) ${dryRun ? 'to create' : 'created'}.`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => db.$disconnect());
