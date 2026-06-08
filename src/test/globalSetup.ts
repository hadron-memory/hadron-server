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

  // 005-agent-subscription, re-keyed by 034-memory-class-access: ownership is
  // class-based — personal/private ⇔ user_id IS NOT NULL (allows private+owner
  // and free-standing personal/private; decoupled from visibility).
  await client.query(`
    ALTER TABLE "memories" DROP CONSTRAINT IF EXISTS "chk_personal_visibility_user";
    ALTER TABLE "memories"
      ADD CONSTRAINT "chk_personal_visibility_user"
      CHECK (("class" IN ('personal', 'private')) = ("user_id" IS NOT NULL));
  `);

  // 008-agent-installation, relaxed by 034-memory-class-access: app_id required
  // only for class='app'; forbidden for system/knowledge/group; OPTIONAL for
  // personal/private (set when app-scoped, NULL when free-standing).
  await client.query(`
    ALTER TABLE "memories" DROP CONSTRAINT IF EXISTS "chk_memory_class_app_id";
    ALTER TABLE "memories"
      ADD CONSTRAINT "chk_memory_class_app_id"
      CHECK (
        (class = 'app' AND app_id IS NOT NULL)
        OR (class IN ('system', 'knowledge', 'group') AND app_id IS NULL)
        OR (class IN ('personal', 'private'))
      );
  `);

  // 034-memory-class-access: agent scope required only for an app-scoped
  // personal/private memory (app_id set); free-standing (app_id NULL) is exempt.
  await client.query(`
    ALTER TABLE "memories" DROP CONSTRAINT IF EXISTS "chk_memory_personal_agent_id";
    ALTER TABLE "memories"
      ADD CONSTRAINT "chk_memory_personal_agent_id"
      CHECK (class NOT IN ('personal', 'private') OR app_id IS NULL OR user_memory_of_agent_id IS NOT NULL);
  `);

  // 035-visibility-enum-cleanup: visibility is meaningful only for knowledge
  // (PUBLIC/ORGANIZATION) and group (GROUP); NULL for every other class.
  await client.query(`
    ALTER TABLE "memories" DROP CONSTRAINT IF EXISTS "chk_memory_visibility_class";
    ALTER TABLE "memories"
      ADD CONSTRAINT "chk_memory_visibility_class"
      CHECK (visibility IS NULL OR class IN ('knowledge', 'group'));
  `);

  // 033-rag-vector-retrieval: vector-index config invariants.
  // FR-026 (encrypted memory needs disclosure ack) + FR-003 chunk-dial sanity.
  // The pgvector extension + indexes come from `db push` (extensions = [vector])
  // + post-push.sql (db:test-setup); these CHECK constraints are the per-run
  // safety net, matching the pattern above.
  await client.query(`
    ALTER TABLE "memories" DROP CONSTRAINT IF EXISTS "chk_memory_vector_encrypted_ack";
    ALTER TABLE "memories"
      ADD CONSTRAINT "chk_memory_vector_encrypted_ack"
      CHECK (NOT (is_encrypted AND vector_index_enabled) OR vector_index_encrypted_ack_at IS NOT NULL);

    ALTER TABLE "memories" DROP CONSTRAINT IF EXISTS "chk_memory_chunk_tokens_positive";
    ALTER TABLE "memories"
      ADD CONSTRAINT "chk_memory_chunk_tokens_positive"
      CHECK (chunk_tokens IS NULL OR chunk_tokens > 0);

    ALTER TABLE "memories" DROP CONSTRAINT IF EXISTS "chk_memory_chunk_overlap_valid";
    ALTER TABLE "memories"
      ADD CONSTRAINT "chk_memory_chunk_overlap_valid"
      CHECK (chunk_overlap IS NULL OR (chunk_overlap >= 0 AND (chunk_tokens IS NULL OR chunk_overlap < chunk_tokens)));
  `);

  await client.end();
}
