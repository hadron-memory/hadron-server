/**
 * #5390 retrofit: give every live Agent's system memory the parents its chatbot design lacks: the skeleton roots
 * `conversations` and `prompts`, and a `prompts:<conversation>` parent over each conversation's stage prompts
 * (`prompts:<conversation>:<stage>`). It runs the #3833 skeleton retrofit, which now does both (src/lib/agentSkeleton.ts,
 * src/lib/chatbotAncestors.ts): system memories only, never install memories; creates absent locs only, never touches an
 * existing node or revives a tombstone; bases before children so a child never hides its base's node.
 *
 *   pnpm tsx scripts/backfill-chatbot-ancestors-5390.ts --dry-run   # report only
 *   pnpm tsx scripts/backfill-chatbot-ancestors-5390.ts             # apply
 *
 * Runs against DATABASE_URL. Idempotent: a second run creates nothing. A platform write with no caller content
 * (cor:acl:150:04, Proposed: counted and never refused). Production runs need their own register grant.
 */
import { PrismaClient } from '../src/generated/prisma/index.js';
import { retrofitAgentSkeletons } from '../src/lib/agentSkeleton.js';
import { backfillMemoryEmbeddings } from '../src/services/embedding/enqueue.js';

const dryRun = process.argv.includes('--dry-run');
const db = new PrismaClient();

async function main(): Promise<void> {
  const rows = await retrofitAgentSkeletons(db, { dryRun, actor: 'system:5390' });
  let total = 0;
  let embedFailures = 0;
  for (const r of rows) {
    if (r.created.length) console.log(`${dryRun ? 'would create' : 'created'} ${r.created.join(', ')} in ${r.agentUrn}`);
    total += r.created.length;
    if (!dryRun && r.created.length) {
      await backfillMemoryEmbeddings(db, r.memoryId).catch((e) => { embedFailures += 1; console.warn('embedding stamp failed', r.agentUrn, e); });
    }
  }
  console.log(`${rows.length} system memories checked, ${total} node(s) ${dryRun ? 'to create' : 'created'}.`);
  // The nodes stand either way; a failed stamp only delays their embedding, but the run must not read as clean.
  if (embedFailures) { console.error(`${embedFailures} memory(ies) failed the embedding stamp; their nodes were created, but a re-run creates nothing and so stamps nothing: backfill those memories' embeddings (logged above).`); process.exitCode = 1; }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => db.$disconnect());
