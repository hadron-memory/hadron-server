/**
 * Vitest global setup: apply Postgres CHECK constraints that don't
 * survive `prisma db push` (which tests use to bootstrap a fresh
 * schema). Uses DROP + ADD instead of IF NOT EXISTS so the constraint
 * definition always matches the current schema — the previous
 * IF-NOT-EXISTS idiom silently kept stale definitions across schema
 * evolution (bug: 'group' and 'private' values were missing for a
 * long time without anyone noticing, because no test exercised them).
 *
 * Source of truth is `prisma/post-push.sql`; the two MUST stay in sync.
 */

import { Client } from 'pg';

export async function setup() {
  const databaseUrl =
    process.env.TEST_DATABASE_URL ?? 'postgresql://holger@localhost:5432/hadron_test';
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  // 005-agent-subscription FR-014: bidirectional invariant on memories.
  // PERSONAL ⇔ userId IS NOT NULL.
  await client.query(`
    ALTER TABLE "memories" DROP CONSTRAINT IF EXISTS "chk_personal_visibility_user";
    ALTER TABLE "memories"
      ADD CONSTRAINT "chk_personal_visibility_user"
      CHECK (("visibility" = 'PERSONAL') = ("user_id" IS NOT NULL));
  `);

  // 008-agent-installation (extended 023 + 2026-05-24 'private'):
  // app_id is required for class IN ('app', 'personal', 'private'),
  // forbidden for class IN ('system', 'knowledge', 'group').
  await client.query(`
    ALTER TABLE "memories" DROP CONSTRAINT IF EXISTS "chk_memory_class_app_id";
    ALTER TABLE "memories"
      ADD CONSTRAINT "chk_memory_class_app_id"
      CHECK (
        (class IN ('app', 'personal', 'private') AND app_id IS NOT NULL)
        OR (class IN ('system', 'knowledge', 'group') AND app_id IS NULL)
      );
  `);

  await client.end();
}
