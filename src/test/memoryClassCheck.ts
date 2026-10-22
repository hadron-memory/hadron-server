/**
 * The CURRENT `chk_memory_class_app_id` definition, read from prisma/post-push.sql, for test fixtures that drop the
 * CHECK to stage legacy rows. Restoring a hand-copied shape went stale twice (no #2064 install-memory arm) and broke
 * every later file in the same vitest worker; see memoryClassCheck.test.ts.
 */
import { readFileSync } from 'node:fs';

const POST_PUSH = readFileSync(new URL('../../prisma/post-push.sql', import.meta.url), 'utf8');
const match = /ALTER TABLE memories\s+ADD CONSTRAINT chk_memory_class_app_id\s+CHECK \([\s\S]*?\n  \);/.exec(POST_PUSH);
if (!match) throw new Error('prisma/post-push.sql no longer defines chk_memory_class_app_id in the expected shape');

/** The `ALTER TABLE … ADD CONSTRAINT chk_memory_class_app_id CHECK (…);` statement, verbatim from post-push.sql. */
export const CHK_MEMORY_CLASS_APP_ID_SQL = match[0];

/** Drop the CHECK if present and re-add post-push.sql's definition, through the fixture's own SQL runner. */
export async function restoreChkMemoryClassAppId(exec: (sql: string) => Promise<unknown>): Promise<void> {
  await exec('ALTER TABLE memories DROP CONSTRAINT IF EXISTS chk_memory_class_app_id');
  await exec(CHK_MEMORY_CLASS_APP_ID_SQL.replace(/;\s*$/, ''));
}
