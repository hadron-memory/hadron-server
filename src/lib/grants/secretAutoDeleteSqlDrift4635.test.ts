/**
 * #4635 (follow-up to #4001 S6): the S6 finite-end guard is written twice, once in the migration that carries it to a
 * migrated database and once in prisma/post-push.sql's include (prisma/secret-auto-delete-invariants.sql) that
 * `db push` databases (dev, the test templates) rebuild from. Nothing tied the two together, so an edit to one would
 * leave the other guarding differently, and the test databases (post-push only) would not show it.
 *
 * Two pins. (1) The executable SQL of the migration and of the invariants file is the same text, ignoring comments and
 * whitespace. (2) The migration that defines the function is the LAST one that does: a later migration that redefines
 * it would make the file stale. The live function in this test database comes from the file, so the pair also proves
 * the migrated definition equals what the rest of the suite exercises.
 *
 * A migration is frozen once shipped, so a future change to the guard is a NEW migration plus the file, and this test
 * is then updated to name that migration on purpose.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';

// Resolved from this file, not the working directory, so the test runs from any cwd.
const PRISMA = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'prisma');
const FUNCTION = 'hadron_guard_secret_auto_delete_limit';
const MIGRATION = '20261120210000_secret_auto_delete';

/** Executable SQL only: `--` comments dropped (whole-line and trailing), runs of whitespace collapsed. The guard has no `--` inside a string. */
const executable = (sql: string) => sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n').replace(/\s+/g, ' ').trim();

describe('#4635 secret auto-delete guard SQL: migration and post-push include agree', () => {
  it('the migration and prisma/secret-auto-delete-invariants.sql carry the same executable SQL', () => {
    const migration = executable(readFileSync(join(PRISMA, 'migrations', MIGRATION, 'migration.sql'), 'utf8'));
    const invariants = executable(readFileSync(join(PRISMA, 'secret-auto-delete-invariants.sql'), 'utf8'));
    expect(migration).toContain(`CREATE OR REPLACE FUNCTION ${FUNCTION}()`);
    expect(invariants).toBe(migration);
  });

  it('no later migration redefines the function or its trigger', () => {
    const touching = readdirSync(join(PRISMA, 'migrations'), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((name) => {
        const sql = readFileSync(join(PRISMA, 'migrations', name, 'migration.sql'), 'utf8');
        return sql.includes(FUNCTION) || sql.includes('secret_auto_delete_limit');
      })
      .sort();
    expect(touching).toEqual([MIGRATION]);
  });

  it('post-push.sql still includes the invariants file, and the live function is the one the file defines', async () => {
    expect(readFileSync(join(PRISMA, 'post-push.sql'), 'utf8')).toMatch(/^\\ir secret-auto-delete-invariants\.sql$/m);
    const [fn] = await db.$queryRaw<Array<{ src: string }>>`
      SELECT p.prosrc AS src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = current_schema() AND p.proname = ${FUNCTION}`;
    // Non-greedy: the first dollar-quoted body only (the file defines exactly one function).
    const body = /\$\$(.*?)\$\$/s.exec(readFileSync(join(PRISMA, 'secret-auto-delete-invariants.sql'), 'utf8'))?.[1] ?? '';
    expect(body).not.toBe('');
    expect(fn, 'the guard function is not installed in the test database').toBeDefined();
    expect(executable(fn!.src)).toBe(executable(body));
  });
});
