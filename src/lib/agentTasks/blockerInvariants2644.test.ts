/** #2644: the migration and db-push/test paths must install identical guards. */
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
it('keeps the SQL guards byte-identical in the migration and reachable from post-push/test setup', () => {
  const root = new URL('../../../', import.meta.url);
  const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
  expect(read('prisma/migrations/20261029000000_task_blockers_priority/migration.sql').endsWith(read('prisma/task-blocker-invariants.sql'))).toBe(true);
  expect(read('prisma/post-push.sql')).toContain('\\ir task-blocker-invariants.sql');
  // #434: post-push.sql (above) is the test template's only path; the vitest global setup no longer re-applies it.
  expect(read('src/test/globalSetup.ts')).not.toContain('task-blocker-invariants.sql');
});
