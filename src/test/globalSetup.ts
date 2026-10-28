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
import { readFileSync } from 'node:fs';
import {
  PARALLEL_DBS,
  baseTestDbUrl,
  baseDbName,
  maintenanceUrl,
  testRunId,
  runTemplateDbName,
  runTemplateUrl,
  isLocalDbHost,
  createDatabaseFromTemplate,
  quoteDbIdent,
  templateLockKey,
  isOwnedRunDead,
  runToken,
  stampTestRunIdentity,
  parseWorkerDbName,
  type WorkerCloneName,
} from './dbWorkers.js';
import { prepareRunGraphRoot, removeRunGraphRoot } from './graphRoot.js';
import { assertBaseMatchesSchema, ensureSchemaTemplate } from './schemaTemplate.js';

export async function setup() {
  // Stamp this run's id BEFORE any worker is forked (#1091). globalSetup runs
  // in the vitest MAIN process and workers inherit its env, which is what
  // carries the id to `perWorkerDb.ts` — nothing else crosses that boundary.
  // Set unconditionally rather than defaulted, so a stale value exported into
  // the shell cannot quietly make two runs share a name-space again.
  stampTestRunIdentity();
  const runId = testRunId();

  // This run's graph-fixture root (#1951), in BOTH modes: serial runs write
  // nodes to disk too. Created (and dead runs' roots swept) before the
  // databases, and removed at teardown even when the database teardown fails.
  prepareRunGraphRoot(runId);
  let dbTeardown: (() => Promise<void>) | undefined;
  try {
    dbTeardown = await setupDatabases();
  } catch (e) {
    removeRunGraphRoot(runId);
    throw e;
  }
  return async function teardown() {
    try {
      await dbTeardown?.();
    } finally {
      removeRunGraphRoot(runId);
    }
  };
}

async function setupDatabases(): Promise<(() => Promise<void>) | undefined> {

  // SERIAL MODE touches the test database and NOTHING ELSE (#1136 review, Codex
  // P2). `HADRON_TEST_PARALLEL=0` is the escape hatch for a setup that has no
  // CREATE DATABASE infrastructure — including a role that can reach the test
  // database but not the `postgres` maintenance one — so opening a maintenance
  // connection up front would have broken exactly the configuration the hatch
  // exists for. The lock still serializes the DDL between two serial runs; it
  // just lives on the connection serial mode already has.
  if (!PARALLEL_DBS) {
    const client = new Client({ connectionString: baseTestDbUrl() });
    await client.connect();
    try {
      await client.query('SELECT pg_advisory_lock($1)', [templateLockKey()]);
      // #1922: serial mode runs against the base itself, so it must have been
      // built for this checkout's schema (`pnpm db:test-setup` stamps it).
      await assertBaseMatchesSchema(client);
      await applyTemplateConstraints(client);
    } finally {
      await client.end();
    }
    return;
  }

  // Scope tokens protect Linux PID-namespace sharing of local endpoints (#1137).
  // Remote Postgres remains outside the supported locality model.
  if (!isLocalDbHost()) {
    throw new Error('Parallel test databases require a local loopback/Unix-socket Postgres endpoint. Remote ownership is unsupported; use HADRON_TEST_PARALLEL=0.');
  }

  // Serialize provisioning against other lock-honouring runs (#1091). Since
  // this checkout applies its DDL to its OWN template rather than to the shared
  // base, the lock no longer protects a DDL window — it just keeps concurrent
  // clones of the base from thrashing on 55006.
  const admin = new Client({ connectionString: maintenanceUrl() });
  await admin.connect();
  await admin.query('SELECT pg_advisory_lock($1)', [templateLockKey()]);

  try {
    return await provision(admin);
  } finally {
    // Releases the advisory lock — session-scoped, so disconnecting is enough.
    await admin.end();
  }
}

async function provision(admin: Client) {
  const base = baseDbName();
  const runId = testRunId();

  // CLONE FIRST, then apply this checkout's DDL to the COPY — the shared base
  // is only ever READ (#1136 review, Codex P1).
  //
  // Applying the constraints to the base and snapshotting afterwards left a
  // window that the advisory lock could not close, because a lock only binds
  // peers that take it: a checkout from before this change rewrites the base
  // without one, and could land between our DDL and our snapshot. Doing the DDL
  // on a database whose name nobody else knows removes the window rather than
  // narrowing it — there is no shared mutable state left to race for.
  return await provisionParallel(admin, base, runId);
}

/** The CHECK constraints `prisma db push` cannot express. Source of truth: prisma/post-push.sql. */
async function applyTemplateConstraints(client: Client) {
  await client.query(readFileSync(new URL('../../prisma/passkey-invariants.sql', import.meta.url), 'utf8'));
  // #1897 — sign-in lineage guards (sign_ins depends on passkey_credentials).
  await client.query(readFileSync(new URL('../../prisma/signin-invariants.sql', import.meta.url), 'utf8'));
  // #1631 PR1b slice 2 — fresh sign-ins bound to the ceremony browser.
  await client.query(readFileSync(new URL('../../prisma/fresh-sign-in-invariants.sql', import.meta.url), 'utf8'));
  // #2204 — OIDC nonce hash on pending logins.
  await client.query(readFileSync(new URL('../../prisma/login-nonce-invariants.sql', import.meta.url), 'utf8'));
  // #1631 PR2 — passkey registration lifecycle (cancel tokens).
  await client.query(readFileSync(new URL('../../prisma/passkey-registration-invariants.sql', import.meta.url), 'utf8'));
  // #1897 slice B1 — pending email sign-ins (depend on sign_ins).
  await client.query(readFileSync(new URL('../../prisma/pending-email-sign-in-invariants.sql', import.meta.url), 'utf8'));
  // #1632 — signing requests, append-only signature records, the content-change marker.
  await client.query(readFileSync(new URL('../../prisma/signing-invariants.sql', import.meta.url), 'utf8'));
  await client.query(readFileSync(new URL('../../prisma/automation-invariants.sql', import.meta.url), 'utf8'));
  // #2441 — append-only automation adoption events.
  await client.query(readFileSync(new URL('../../prisma/automation-adoption-invariants.sql', import.meta.url), 'utf8'));
  // #2484 — App memory write grants (shape, one live row, terminal revoke) and append-only events.
  await client.query(readFileSync(new URL('../../prisma/app-memory-write-grant-invariants.sql', import.meta.url), 'utf8'));
  // #430 — Git-mirror obligation shape + attempt sequence.
  await client.query(readFileSync(new URL('../../prisma/git-mirror-obligation-invariants.sql', import.meta.url), 'utf8'));
  // #1705 — agent task shape + append-only team events.
  await client.query(readFileSync(new URL('../../prisma/agent-task-invariants.sql', import.meta.url), 'utf8'));
  // #2553 — the per-App task number (needs agent_tasks and its counter table).
  await client.query(readFileSync(new URL('../../prisma/agent-task-number-invariants.sql', import.meta.url), 'utf8'));
  // #1706 — stall alarm episodes, alarm wakes, availability, stall windows.
  await client.query(readFileSync(new URL('../../prisma/agent-task-stall-invariants.sql', import.meta.url), 'utf8'));
  // #1707 — session model family, host registrations.
  await client.query(readFileSync(new URL('../../prisma/agent-task-matching-invariants.sql', import.meta.url), 'utf8'));
  // #1747 — tickers, subscriptions, wake settings, app grants, App ticker bounds.
  await client.query(readFileSync(new URL('../../prisma/ticker-invariants.sql', import.meta.url), 'utf8'));
  await client.query(readFileSync(new URL('../../prisma/worker-team-choice-invariants.sql', import.meta.url), 'utf8'));
  // #2043 — a compiled boot prompt keeps its role.
  await client.query(readFileSync(new URL('../../prisma/boot-prompt-invariants.sql', import.meta.url), 'utf8'));
  // #2045 — a boot-prompt pointer's id and URN snapshot are set or cleared together.
  await client.query(readFileSync(new URL('../../prisma/boot-prompt-pointer-invariants.sql', import.meta.url), 'utf8'));
  // #2046 — compiled boot-prompt revision provenance: shape CHECK + immutability trigger.
  await client.query(readFileSync(new URL('../../prisma/compiled-prompt-revision-invariants.sql', import.meta.url), 'utf8'));
  // #2043 PR 2 — an outside approval ends when its node enters the placed boot-prompt state.
  await client.query(readFileSync(new URL('../../prisma/boot-prompt-approval-invariants.sql', import.meta.url), 'utf8'));
  // #2022 — stop signals, their coverage history, the stop holds of queued tasks.
  await client.query(readFileSync(new URL('../../prisma/stop-signal-invariants.sql', import.meta.url), 'utf8'));

  // #1326 — nullable attribution is either unknown, a task at an exact
  // revision, or an authenticated human. A CHECK with a bare OR of enum
  // comparisons would admit SQL NULL, so use CASE with explicit non-null
  // requirements. Synced with prisma/post-push.sql and the migration.
  for (const [table, constraint] of [
    ['nodes', 'chk_nodes_authorship_shape'],
    ['node_revisions', 'chk_node_revisions_authorship_shape'],
  ] as const) {
    await client.query(`
      ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${constraint}";
      ALTER TABLE "${table}" ADD CONSTRAINT "${constraint}" CHECK (CASE
        WHEN "authorship_kind" IS NULL THEN
          "authored_by_task" IS NULL AND "authored_by_revision" IS NULL AND "authored_by_human" IS NULL AND "authored_at" IS NULL
        WHEN "authorship_kind" = 'TASK' THEN
          "authored_by_task" IS NOT NULL AND "authored_by_revision" IS NOT NULL AND "authored_by_revision" > 0 AND "authored_by_human" IS NULL AND "authored_at" IS NOT NULL
        WHEN "authorship_kind" = 'HUMAN' THEN
          "authored_by_task" IS NULL AND "authored_by_revision" IS NULL AND "authored_by_human" IS NOT NULL AND "authored_at" IS NOT NULL
        ELSE false END);
    `);
  }
  // #1591 — a mint record is complete or absent. Synced with prisma/post-push.sql
  // and the migration.
  await client.query(`
    ALTER TABLE "nodes" DROP CONSTRAINT IF EXISTS "chk_node_mint_complete";
    ALTER TABLE "nodes" ADD CONSTRAINT "chk_node_mint_complete" CHECK (CASE
      WHEN "minted_at" IS NULL THEN
        "minted_by" IS NULL AND "minted_by_info" IS NULL AND "minted_rev_no" IS NULL AND "minted_hash" IS NULL
      ELSE
        ("minted_by" IS NOT NULL OR "minted_by_info" IS NOT NULL)
          AND ("minted_rev_no" IS NULL) = ("minted_hash" IS NULL)
          AND ("minted_rev_no" IS NULL OR "minted_rev_no" > 0)
      END);
  `);
  // #1591 — an approval is complete or absent. Synced with prisma/post-push.sql
  // and the migration.
  await client.query(`
    ALTER TABLE "nodes" DROP CONSTRAINT IF EXISTS "chk_node_approval_complete";
    ALTER TABLE "nodes" ADD CONSTRAINT "chk_node_approval_complete" CHECK (CASE
      WHEN "approved_rev_no" IS NULL THEN
        "approved_at" IS NULL AND "approval_hash" IS NULL AND "approved_by" IS NULL AND "approved_by_info" IS NULL
      ELSE
        "approved_rev_no" > 0 AND "approved_at" IS NOT NULL
          AND ("approved_by" IS NOT NULL OR "approved_by_info" IS NOT NULL)
      END);
  `);
  await client.query(`
    ALTER TABLE "node_content_validation_reports" DROP CONSTRAINT IF EXISTS "chk_node_content_validation_revisions_positive";
    ALTER TABLE "node_content_validation_reports" ADD CONSTRAINT "chk_node_content_validation_revisions_positive"
      CHECK ("node_rev_seq" > 0 AND "validation_task_rev_seq" > 0);
  `);

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
(class = 'app' AND app_id IS NOT NULL AND install_of_agent_id IS NULL AND is_install_memory = false)
      OR (class = 'system' AND app_id IS NULL AND install_of_agent_id IS NULL AND is_install_memory = false)
      OR (class = 'system' AND app_id IS NOT NULL AND is_install_memory = true)
      OR (class IN ('knowledge', 'group', 'personal', 'private') AND install_of_agent_id IS NULL AND is_install_memory = false)
      );
    CREATE UNIQUE INDEX IF NOT EXISTS memories_install_memory_live_uniq
      ON memories (app_id, install_of_agent_id)
      WHERE install_of_agent_id IS NOT NULL AND deleted_at IS NULL;
  `);

  // 034-memory-class-access: agent scope required only for an app-scoped
  // personal/private memory (app_id set); free-standing (app_id NULL) is exempt.
  await client.query(`
    ALTER TABLE "memories" DROP CONSTRAINT IF EXISTS "chk_memory_personal_agent_id";
    ALTER TABLE "memories"
      ADD CONSTRAINT "chk_memory_personal_agent_id"
      CHECK (class NOT IN ('personal', 'private') OR app_id IS NULL OR user_memory_of_agent_id IS NOT NULL);
  `);

  // #723: shared_memory_of_agent_id identifies an App's runtime `shared`
  // app-class memory, so it is meaningful only on an App-scoped app-class row.
  // Synced with prisma/post-push.sql + the 20260813120000 migration.
  await client.query(`
    ALTER TABLE "memories" DROP CONSTRAINT IF EXISTS "chk_memory_shared_agent_scope";
    ALTER TABLE "memories"
      ADD CONSTRAINT "chk_memory_shared_agent_scope"
      CHECK (shared_memory_of_agent_id IS NULL OR (class = 'app' AND app_id IS NOT NULL));
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

  // Ruling DY-5: a dormancy threshold is a positive number of days. Synced
  // with prisma/post-push.sql + the 20261005010000 migration.
  await client.query(`
    ALTER TABLE "apps" DROP CONSTRAINT IF EXISTS "chk_app_session_dormancy_days_positive";
    ALTER TABLE "apps" ADD CONSTRAINT "chk_app_session_dormancy_days_positive"
      CHECK ("session_dormancy_days" > 0);
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

  // Spec 049 Phase 2 — Scope: exactly one owner + per-owner name uniqueness
  // among LIVE rows. Synced with prisma/post-push.sql + the
  // 20260915170000_scopes migration.
  await client.query(`
    ALTER TABLE "scopes" DROP CONSTRAINT IF EXISTS "chk_scope_owner";
    ALTER TABLE "scopes"
      ADD CONSTRAINT "chk_scope_owner"
      CHECK (num_nonnulls(organization_id, agent_id, app_id) = 1);

    CREATE UNIQUE INDEX IF NOT EXISTS scopes_org_name_uniq
      ON scopes (organization_id, name) WHERE organization_id IS NOT NULL AND deleted_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS scopes_agent_name_uniq
      ON scopes (agent_id, name) WHERE agent_id IS NOT NULL AND deleted_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS scopes_app_name_uniq
      ON scopes (app_id, name) WHERE app_id IS NOT NULL AND deleted_at IS NULL;
  `);

  // #1325 — MemoryConfig templates: exactly one owner + per-owner live-name
  // uniqueness; rule task-reference markers; and #1322 dotted rule-key
  // grammar. Synced with prisma/post-push.sql + the 20260925030000_memory_config
  // and 20260925100000_dotted_role_rules migrations.
  await client.query(`
    ALTER TABLE memory_config_templates
      DROP CONSTRAINT IF EXISTS chk_memory_config_template_owner;
    ALTER TABLE memory_config_templates
      ADD CONSTRAINT chk_memory_config_template_owner
      CHECK (num_nonnulls(hadron_server_id, organization_id, owner_user_id, app_id) = 1);
    CREATE UNIQUE INDEX IF NOT EXISTS memory_config_templates_server_name_uniq
      ON memory_config_templates (hadron_server_id, name) WHERE hadron_server_id IS NOT NULL AND deleted_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS memory_config_templates_org_name_uniq
      ON memory_config_templates (organization_id, name) WHERE organization_id IS NOT NULL AND deleted_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS memory_config_templates_user_name_uniq
      ON memory_config_templates (owner_user_id, name) WHERE owner_user_id IS NOT NULL AND deleted_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS memory_config_templates_app_name_uniq
      ON memory_config_templates (app_id, name) WHERE app_id IS NOT NULL AND deleted_at IS NULL;
    ALTER TABLE node_role_rules
      DROP CONSTRAINT IF EXISTS chk_node_role_rule_task_markers;
    ALTER TABLE node_role_rules
      ADD CONSTRAINT chk_node_role_rule_task_markers
      CHECK ((author_task_id IS NULL OR author_task_required)
         AND (validation_task_id IS NULL OR validation_task_required));
    DO $$
    DECLARE
      bad text;
    BEGIN
      SELECT string_agg(format('%s:%s (%L)', src, id, role), ', ') INTO bad FROM (
        SELECT 'node_role_rules' AS src, id, role FROM node_role_rules
         WHERE NOT (char_length(role) BETWEEN 1 AND 64 AND role ~ '^[a-z0-9][a-z0-9-]*(\\.[a-z0-9][a-z0-9-]*)*$')
        UNION ALL
        SELECT 'memory_config_template_rules', id, role FROM memory_config_template_rules
         WHERE NOT (char_length(role) BETWEEN 1 AND 64 AND role ~ '^[a-z0-9][a-z0-9-]*(\\.[a-z0-9][a-z0-9-]*)*$')
        LIMIT 20
      ) t;
      IF bad IS NOT NULL THEN
        RAISE EXCEPTION '#1322: rule keys the dotted grammar refuses (lower-case letter/digit/dash segments joined by dots, 1-64 characters). Rename or delete these rules, then re-run: %', bad;
      END IF;
    END $$;
    ALTER TABLE node_role_rules
      DROP CONSTRAINT IF EXISTS chk_node_role_rule_role_format;
    ALTER TABLE node_role_rules
      ADD CONSTRAINT chk_node_role_rule_role_format
      CHECK (char_length(role) BETWEEN 1 AND 64
         AND role ~ '^[a-z0-9][a-z0-9-]*(\\.[a-z0-9][a-z0-9-]*)*$');
    ALTER TABLE memory_config_template_rules
      DROP CONSTRAINT IF EXISTS chk_memory_config_template_rule_task_markers;
    ALTER TABLE memory_config_template_rules
      ADD CONSTRAINT chk_memory_config_template_rule_task_markers
      CHECK ((author_task_id IS NULL OR author_task_required)
         AND (validation_task_id IS NULL OR validation_task_required));
    ALTER TABLE memory_config_template_rules
      DROP CONSTRAINT IF EXISTS chk_memory_config_template_rule_role_format;
    ALTER TABLE memory_config_template_rules
      ADD CONSTRAINT chk_memory_config_template_rule_role_format
      CHECK (char_length(role) BETWEEN 1 AND 64
         AND role ~ '^[a-z0-9][a-z0-9-]*(\\.[a-z0-9][a-z0-9-]*)*$');
  `);

  // Spec 049 Phase 5 — the register: exactly one owner, at most one
  // attendee, and the (owner, channel, attendee) natural keys among LIVE rows
  // (the install insert's ON CONFLICT target). Synced with
  // prisma/post-push.sql + the 20260915220000_register_entries migration.
  await client.query(`
    ALTER TABLE "register_entries" DROP CONSTRAINT IF EXISTS "chk_register_owner";
    ALTER TABLE "register_entries"
      ADD CONSTRAINT "chk_register_owner"
      CHECK (num_nonnulls(organization_id, app_id) = 1);
    ALTER TABLE "register_entries" DROP CONSTRAINT IF EXISTS "chk_register_attendee";
    ALTER TABLE "register_entries"
      ADD CONSTRAINT "chk_register_attendee"
      CHECK (num_nonnulls(attendee_worker_id, attendee_agent_id) <= 1);

    CREATE UNIQUE INDEX IF NOT EXISTS register_entries_app_channel_worker_uniq
      ON register_entries (app_id, channel_id, attendee_worker_id)
      WHERE app_id IS NOT NULL AND attendee_worker_id IS NOT NULL AND deleted_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS register_entries_app_channel_agent_uniq
      ON register_entries (app_id, channel_id, attendee_agent_id)
      WHERE app_id IS NOT NULL AND attendee_agent_id IS NOT NULL AND deleted_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS register_entries_app_channel_all_uniq
      ON register_entries (app_id, channel_id)
      WHERE app_id IS NOT NULL AND attendee_worker_id IS NULL AND attendee_agent_id IS NULL AND deleted_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS register_entries_org_channel_worker_uniq
      ON register_entries (organization_id, channel_id, attendee_worker_id)
      WHERE organization_id IS NOT NULL AND attendee_worker_id IS NOT NULL AND deleted_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS register_entries_org_channel_agent_uniq
      ON register_entries (organization_id, channel_id, attendee_agent_id)
      WHERE organization_id IS NOT NULL AND attendee_agent_id IS NOT NULL AND deleted_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS register_entries_org_channel_all_uniq
      ON register_entries (organization_id, channel_id)
      WHERE organization_id IS NOT NULL AND attendee_worker_id IS NULL AND attendee_agent_id IS NULL AND deleted_at IS NULL;
  `);

  // Spec 049 Phase 7 — read-state: exactly one attendee, an Agent attendee
  // carries its App, the (attendee, channel) natural keys. Synced with
  // prisma/post-push.sql + the 20260915240000_channel_read_state migration.
  await client.query(`
    ALTER TABLE "channel_read_states" DROP CONSTRAINT IF EXISTS "chk_read_state_attendee";
    ALTER TABLE "channel_read_states"
      ADD CONSTRAINT "chk_read_state_attendee"
      CHECK (num_nonnulls(worker_id, agent_id) = 1);
    ALTER TABLE "channel_read_states" DROP CONSTRAINT IF EXISTS "chk_read_state_agent_app";
    ALTER TABLE "channel_read_states"
      ADD CONSTRAINT "chk_read_state_agent_app"
      CHECK (agent_id IS NULL OR app_id IS NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS channel_read_states_worker_channel_uniq
      ON channel_read_states (worker_id, channel_id) WHERE worker_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS channel_read_states_agent_app_channel_uniq
      ON channel_read_states (agent_id, app_id, channel_id) WHERE agent_id IS NOT NULL;
  `);

  // #974 Worker model (cor:dmo:050:11, cor:agt:020:02 v0.0.3): a worker's
  // name is unique per App, case-insensitively (functional unique — Prisma
  // can't express it). NOT filtered on retirement: a name binds to one
  // casting forever. Synced with prisma/post-push.sql + the
  // 20260814130000_worker_model migration.
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS workers_app_name_uniq
      ON workers (app_id, lower(name));
  `);

  // #991's second worker unique — workers_app_slug_uniq on (app_id, slug), the
  // URN atom — is absent here on purpose: it is a plain column pair that Prisma
  // models in schema.prisma's @@unique, so `db push` creates it. Only the
  // inexpressible ones (functional/partial) are re-declared in this file.

  // The mention-token unique (workers_app_mention_token_uniq) was REMOVED by
  // decision (Holger, 2026-08-14): cor:agt:020:02 keeps ONE uniqueness layer.
  // The DROP keeps an already-provisioned template in step. Synced with
  // prisma/post-push.sql + the 20260814150000 migration.
  await client.query(`
    DROP INDEX IF EXISTS workers_app_mention_token_uniq;
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
    -- #1430: C-collation index for paged-attention keyset pages (mirrors the
    -- migration and post-push.sql — all three DDL-sync sites per the review rule).
    CREATE INDEX IF NOT EXISTS nodes_memory_id_loc_c_idx ON nodes ("memory_id", "loc" COLLATE "C");
    -- #1430: Channel-local seq-first partial index (see migration).
    CREATE INDEX IF NOT EXISTS nodes_msg_channel_seq_loc_c_idx
      ON "nodes" ("message_channel_id", "seq", "loc" COLLATE "C")
      WHERE "node_type" = 'chat-message' AND "deleted_at" IS NULL AND "seq" IS NOT NULL;
  `);

}

export async function provisionParallel(admin: Client, base: string, runId: string) {
  const ownToken = runToken(runId);
  await dropOrphanWorkerDbs(admin, base, runId);

  // Snapshot the shared template into a RUN-SCOPED one, while still holding the
  // lock, and have the workers clone from that (#1136 review, Codex P1).
  //
  // Without this the run-scoping is only half done: the destination names are
  // per-run but their CONTENT is not, so a second checkout's setup could
  // rewrite the shared constraints between our DDL and our first lazy worker
  // clone. The failure mode that makes it worth an extra clone is not the noisy
  // one — it is a run passing against another branch's constraints.
  //
  // One extra `CREATE DATABASE` per run against ~13 worker clones. The template
  // holds schema, not rows.
  //
  // #1922: the source is no longer the shared base but the template built from
  // EMPTY for this checkout's schema fingerprint, so another branch's setup can
  // neither drop our columns nor leave its triggers in our run.
  const schemaTemplate = await ensureSchemaTemplate(admin, base);
  const runTemplate = runTemplateDbName(runId, base);
  await admin.query(`DROP DATABASE IF EXISTS ${quoteDbIdent(runTemplate)} WITH (FORCE)`);
  // Waits on a busy source rather than aborting setup — a developer's open psql
  // against it blocks CREATE ... TEMPLATE, and the previous code handled that
  // at the worker-clone site only (#1136 review, Codex P2).
  await createDatabaseFromTemplate(admin, runTemplate, schemaTemplate);

  // This checkout's constraints, applied to this run's copy.
  const client = new Client({ connectionString: runTemplateUrl(runId, base) });
  await client.connect();
  try {
    await applyTemplateConstraints(client);
  } finally {
    // Must be closed before the workers can clone from it.
    await client.end();
  }

  // Worker DBs are cloned from the run template LAZILY, per worker
  // (perWorkerDb.ts), because VITEST_POOL_ID isn't statically bounded.
  return async function teardown() {
    const a = new Client({ connectionString: maintenanceUrl() });
    await a.connect();
    try {
      // Best-effort: this captured full token only. Future same-scope runs
      // may collect it once its PID is provably dead.
      await dropWorkerDbs(a, base, (c) => c.runToken === ownToken, { swallow: true });
    } finally {
      await a.end();
    }
  };
}

/**
 * Drop clones that no live run owns, before this run creates its own (#1091).
 *
 * This replaced a blanket "drop every `<base>_<digits>`", which was the second
 * half of the collision it was meant to prevent: names were not run-scoped, so
 * the blanket drop reached into a CONCURRENT run's databases, and `WITH (FORCE)`
 * meant it terminated that run's connections rather than failing. A suite that
 * outlived its terminal — a `vitest` piped to `head` SIGPIPEs the pipe and
 * leaves the run alive — was enough to make somebody else's suite collapse with
 * `Database … does not exist` or a `40P01` inside `cleanDb`.
 *
 * The pre-run pass exists at all so a schema change to the template can't be
 * masked by a stale clone that `perWorkerDb` would adopt instead of creating.
 * Run-scoped names make that impossible for a FOREIGN clone — this run's names
 * cannot collide with another run's — so the remaining job is garbage
 * collection, and it is best-effort: an orphan we fail to drop is wasted disk,
 * not a wrong result.
 *
 * Ownership is decided by the full scope token and {@link isOwnedRunDead} and by NOTHING else — in
 * particular never by "has no open connections", since a run that has just
 * issued `CREATE DATABASE` and not yet connected has no connections either, and
 * dropping it there is precisely the bug being fixed. That rule now has no
 * exceptions: a clone this sweep cannot prove is dead is left alone.
 */
export async function dropOrphanWorkerDbs(admin: Client, base: string, runId: string): Promise<void> {
  const { rows } = await admin.query<{ datname: string }>('SELECT datname FROM pg_database');
  const datnames = rows.map((r) => r.datname);

  // OUR OWN name, left by a crashed run whose pid the OS has since handed to us.
  // This one fails LOUD (#1136 review, Codex P2): a swallowed failure here means
  // `perWorkerDb` finds the database already present, skips CREATE, and runs the
  // suite against the CRASHED run's schema — the stale-clone masking that the
  // pre-run pass exists to prevent, and the one case where being best-effort
  // produces a wrong result rather than wasted disk.
  await dropWorkerDbs(admin, base, (c) => c.runToken === runToken(runId), { swallow: false }, datnames);

  // Same-scope provably dead runs only. Previous-boot, foreign, unknown,
  // pid-only and unscoped legacy names are never automatically dropped.
  // These leftovers can accumulate without bound (disk/inodes). Manual removal
  // requires all namespaces sharing this endpoint to be quiescent, not merely
  // a PID absent here. db:test-prune-legacy is not a namespace-ownership tool.
  await dropWorkerDbs(
    admin,
    base,
    (clone) => clone.runToken !== runToken(runId) && isOwnedRunDead(clone.scope, clone.runId),
    { swallow: true },
    datnames,
  );
}

/**
 * Drop the worker clones `select` accepts. Clone names are recognized by
 * `parseWorkerDbName` — exact prefix + shape, in JS rather than a SQL regex, so
 * a base name carrying regex metacharacters can never over-match and drop an
 * unrelated database.
 *
 * `select` is mandatory rather than defaulted, because every caller of the
 * blanket version this replaces was the #1091 bug.
 */
async function dropWorkerDbs(
  admin: Client,
  base: string,
  select: (clone: WorkerCloneName) => boolean,
  opts: { swallow: boolean },
  datnames?: string[],
): Promise<void> {
  const names =
    datnames ??
    (await admin.query<{ datname: string }>('SELECT datname FROM pg_database')).rows.map(
      (r) => r.datname,
    );
  const clones = names
    .map((n) => parseWorkerDbName(n, base))
    .filter((c): c is WorkerCloneName => c !== null && select(c));

  for (const { datname } of clones) {
    const drop = admin.query(`DROP DATABASE IF EXISTS ${quoteDbIdent(datname)} WITH (FORCE)`);
    if (opts.swallow) await drop.catch(() => {});
    else await drop;
  }
}
