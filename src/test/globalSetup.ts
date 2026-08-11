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
import { PARALLEL_DBS, baseTestDbUrl, baseDbName, maintenanceUrl } from './dbWorkers.js';

export async function setup() {
  const databaseUrl = baseTestDbUrl();
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

  // 008-agent-installation, relaxed by 034-memory-class-access and #653: app_id
  // required for class='app'; forbidden for class='system'; OPTIONAL for
  // knowledge/group/personal/private. #653 moved knowledge + group to optional
  // so they can be attached to an App. Synced with prisma/post-push.sql.
  await client.query(`
    ALTER TABLE "memories" DROP CONSTRAINT IF EXISTS "chk_memory_class_app_id";
    ALTER TABLE "memories"
      ADD CONSTRAINT "chk_memory_class_app_id"
      CHECK (
        (class = 'app' AND app_id IS NOT NULL)
        OR (class = 'system' AND app_id IS NULL)
        OR (class IN ('knowledge', 'group', 'personal', 'private'))
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

  // #510: an AgentSchedule is EITHER recurring (cron) or one-shot (run_at).
  await client.query(`
    ALTER TABLE "agent_schedules" DROP CONSTRAINT IF EXISTS "chk_agent_schedule_cron_xor_run_at";
    ALTER TABLE "agent_schedules"
      ADD CONSTRAINT "chk_agent_schedule_cron_xor_run_at"
      CHECK (("cron" IS NULL) <> ("run_at" IS NULL));
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

    ALTER TABLE "memories" DROP CONSTRAINT IF EXISTS "chk_memory_max_rev_count_positive";
    ALTER TABLE "memories"
      ADD CONSTRAINT "chk_memory_max_rev_count_positive"
      CHECK (max_rev_count >= 1);
  `);

  // 036-ai-service-config: a config belongs to exactly one owner; name is
  // unique per owner (partial uniques — Prisma can't express either).
  // spec 047 Phase 2c: App/Agent/Memory are owned by EXACTLY ONE of an org or a
  // user (org-XOR-owner). Synced with prisma/post-push.sql + the 20260714160000
  // migration.
  await client.query(`
    ALTER TABLE "apps" DROP CONSTRAINT IF EXISTS "chk_app_owner_xor";
    ALTER TABLE "apps" ADD CONSTRAINT "chk_app_owner_xor"
      CHECK (("organization_id" IS NULL) <> ("owner_user_id" IS NULL));
    ALTER TABLE "agents" DROP CONSTRAINT IF EXISTS "chk_agent_owner_xor";
    ALTER TABLE "agents" ADD CONSTRAINT "chk_agent_owner_xor"
      CHECK (("organization_id" IS NULL) <> ("owner_user_id" IS NULL));
    ALTER TABLE "memories" DROP CONSTRAINT IF EXISTS "chk_memory_owner_xor";
    ALTER TABLE "memories" ADD CONSTRAINT "chk_memory_owner_xor"
      CHECK (("organization_id" IS NULL) <> ("owner_user_id" IS NULL));
  `);

  await client.query(`
    ALTER TABLE "ai_service_configs" DROP CONSTRAINT IF EXISTS "chk_ai_service_config_owner";
    ALTER TABLE "ai_service_configs"
      ADD CONSTRAINT "chk_ai_service_config_owner"
      CHECK (num_nonnulls(hadron_server_id, organization_id, app_id, agent_id) = 1);

    CREATE UNIQUE INDEX IF NOT EXISTS ai_service_configs_server_name_uniq
      ON ai_service_configs (hadron_server_id, name) WHERE hadron_server_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS ai_service_configs_org_name_uniq
      ON ai_service_configs (organization_id, name) WHERE organization_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS ai_service_configs_app_name_uniq
      ON ai_service_configs (app_id, name) WHERE app_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS ai_service_configs_agent_name_uniq
      ON ai_service_configs (agent_id, name) WHERE agent_id IS NOT NULL;
  `);

  // #928 team personas: persona names are unique per owner (org XOR user),
  // case-insensitively (partial functional uniques — Prisma can't express
  // them). NOT filtered on deleted_at: a persona name binds to one agent
  // forever (D-2026-08-11-006). Synced with prisma/post-push.sql + the
  // 20260811120000 migration.
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS agents_org_persona_name_uniq
      ON agents (organization_id, lower(persona_name))
      WHERE persona_name IS NOT NULL AND organization_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS agents_owner_persona_name_uniq
      ON agents (owner_user_id, lower(persona_name))
      WHERE persona_name IS NOT NULL AND owner_user_id IS NOT NULL;
  `);

  // 043-slack-integration: one LIVE Slack connection per (org, workspace) —
  // PARTIAL unique (Prisma can't express the WHERE), so a soft-deleted row
  // never blocks re-registration. Synced with prisma/post-push.sql.
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS slack_connections_org_team_active_uniq
      ON slack_connections (organization_id, team_id) WHERE deleted_at IS NULL;
  `);

  // #696: secrets are ORG/USER-owned only (D-2026-07-15-006). Synced with
  // prisma/post-push.sql + the 20260716120000 migration.
  await client.query(`
    ALTER TABLE "secrets" DROP CONSTRAINT IF EXISTS "chk_secret_owner_type";
    ALTER TABLE "secrets"
      ADD CONSTRAINT "chk_secret_owner_type"
      CHECK ("owner_type" IN ('user', 'org'));
  `);

  // 325-user-urn: case-insensitive handle uniqueness (handle is the
  // hrn:user:<handle> slug; lowercase-canonical). Functional index — Prisma's
  // plain @unique is case-sensitive and can't express this.
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS users_handle_lower_uniq
      ON users (lower(handle)) WHERE handle IS NOT NULL;
  `);


  // cor:api:090 (findNodes) + cor:rag:010:02: lexical FTS substrate — a STORED
  // generated tsvector (weighted A/B/C/D) + GIN index. Prisma models neither, so
  // `db push` doesn't create them; mirror post-push.sql here. Source of truth is
  // prisma/post-push.sql; the two MUST stay in sync.
  await client.query(`
    CREATE OR REPLACE FUNCTION hadron_nodes_tsv(
      p_name text, p_alias text, p_loc text, p_tags text[],
      p_description text, p_abstract text, p_content text, p_properties text, p_data text
    ) RETURNS tsvector LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
      SELECT
        setweight(to_tsvector('english', coalesce(p_name, '') || ' ' || coalesce(p_alias, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(p_loc, '') || ' ' || array_to_string(coalesce(p_tags, ARRAY[]::text[]), ' ')), 'B') ||
        setweight(to_tsvector('english', coalesce(p_description, '') || ' ' || coalesce(p_abstract, '')), 'C') ||
        setweight(to_tsvector('english', left(coalesce(p_content, '') || ' ' || coalesce(p_properties, '') || ' ' || coalesce(p_data, ''), 1000000)), 'D')
    $$;

    ALTER TABLE nodes ADD COLUMN IF NOT EXISTS tsv tsvector GENERATED ALWAYS AS (
      hadron_nodes_tsv(name, alias, loc, tags, description, abstract, content, properties::text, data::text)
    ) STORED;

    CREATE INDEX IF NOT EXISTS nodes_tsv_gin ON nodes USING gin (tsv);
  `);

  // The base DB above is now the fully-provisioned TEMPLATE. Must be closed
  // before it can be used as a CREATE DATABASE template (no open connections).
  await client.end();

  if (!PARALLEL_DBS) return;

  // Worker DBs are cloned from this template LAZILY, per worker (perWorkerDb.ts),
  // because VITEST_POOL_ID isn't statically bounded. Nothing to create up front;
  // just drop any leftover `hadron_test_<n>` clones from a prior run so a schema
  // change to the template can't be masked by a stale clone.
  const base = baseDbName();
  const admin = new Client({ connectionString: maintenanceUrl() });
  await admin.connect();
  try {
    // Pre-run cleanup fails LOUD (swallow: false): if a stale clone can't be
    // dropped, perWorkerDb would see it exists, skip CREATE, and run the suite
    // against an old schema — masking failures. Better to abort setup (Codex).
    await dropWorkerDbs(admin, base, { swallow: false });
  } finally {
    await admin.end();
  }

  return async function teardown() {
    const a = new Client({ connectionString: maintenanceUrl() });
    await a.connect();
    try {
      // Post-run cleanup is best-effort (swallow: true) — a failure here can't
      // affect correctness (the next run's setup drops loudly first).
      await dropWorkerDbs(a, base, { swallow: true });
    } finally {
      await a.end();
    }
  };
}

/**
 * Drop every `<base>_<digits>` worker clone. Matches by exact prefix + numeric
 * suffix in JS (not a SQL regex) so a base name with regex metachars can never
 * over-match and drop an unrelated database.
 */
async function dropWorkerDbs(admin: Client, base: string, opts: { swallow: boolean }): Promise<void> {
  const prefix = `${base}_`;
  const { rows } = await admin.query<{ datname: string }>('SELECT datname FROM pg_database');
  const clones = rows.filter(
    (r) => r.datname.startsWith(prefix) && /^[0-9]+$/.test(r.datname.slice(prefix.length)),
  );
  for (const { datname } of clones) {
    const drop = admin.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
    if (opts.swallow) await drop.catch(() => {});
    else await drop;
  }
}
