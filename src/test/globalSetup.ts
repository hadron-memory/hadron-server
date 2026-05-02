/**
 * Vitest global setup: apply Postgres CHECK constraints that don't
 * survive `prisma db push` (which tests use to bootstrap a fresh
 * schema). Each constraint is added IF NOT EXISTS so re-runs are
 * safe.
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
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_personal_visibility_user'
      ) THEN
        ALTER TABLE "memories"
          ADD CONSTRAINT "chk_personal_visibility_user"
          CHECK (("visibility" = 'PERSONAL') = ("user_id" IS NOT NULL));
      END IF;
    END$$;
  `);

  // 008-agent-installation: app_id is required for class IN ('app', 'personal'),
  // forbidden for class IN ('system', 'knowledge').
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_memory_class_app_id'
      ) THEN
        ALTER TABLE "memories"
          ADD CONSTRAINT "chk_memory_class_app_id"
          CHECK (
            (class IN ('app', 'personal') AND app_id IS NOT NULL)
            OR (class IN ('system', 'knowledge') AND app_id IS NULL)
          );
      END IF;
    END$$;
  `);

  await client.end();
}
