-- Post-`prisma db push` invariants. `db push` introspects the Prisma schema
-- but doesn't apply CHECK constraints (Prisma doesn't model them at the
-- schema-language level). The migrations under prisma/migrations/ DO add
-- them, so applying the migrations to a real DB gives you these for free —
-- but `db push` for a dev/test DB does not.
--
-- Apply this file after every `db push` (the db:dev-setup / db:test-setup
-- scripts in package.json wire it up).

-- 005-agent-subscription, re-keyed by 034-memory-class-access: ownership is a
-- property of CLASS, not visibility. `personal`/`private` are single-owner
-- (user_id NOT NULL); all other classes have user_id NULL. This replaces the
-- old visibility=PERSONAL coupling so a `private` memory (visibility=PRIVATE)
-- can carry an owner, and so a free-standing personal/private memory is valid.
-- NAMING DEBT: the constraint name still says "visibility"; rename to
-- chk_memory_owner_userid when next touching it.
ALTER TABLE memories
  DROP CONSTRAINT IF EXISTS chk_personal_visibility_user;
ALTER TABLE memories
  ADD CONSTRAINT chk_personal_visibility_user
  CHECK ((class IN ('personal', 'private')) = (user_id IS NOT NULL));

-- 008-agent-installation, 034-memory-class-access, #653 and #2064:
-- app_id is REQUIRED for class='app'; class='system' has app_id NULL for an
-- Agent's own system memory, or app_id set with is_install_memory=true for an
-- App's install memory. Other classes have is_install_memory=false and no
-- install_of_agent_id. app_id is OPTIONAL for knowledge/group/personal/private
-- (set when provisioned inside an app — the (app, user) scope for personal;
-- NULL when free-standing). #653 moved knowledge + group from FORBIDDEN to
-- OPTIONAL so those shared memory classes can be attached to an App.
ALTER TABLE memories
  DROP CONSTRAINT IF EXISTS chk_memory_class_app_id;
ALTER TABLE memories
  ADD CONSTRAINT chk_memory_class_app_id
  CHECK (
    (class = 'app' AND app_id IS NOT NULL AND install_of_agent_id IS NULL AND is_install_memory = false)
    OR (class = 'system' AND app_id IS NULL AND install_of_agent_id IS NULL AND is_install_memory = false)
    OR (class = 'system' AND app_id IS NOT NULL AND is_install_memory = true)
    OR (class IN ('knowledge', 'group', 'personal', 'private') AND install_of_agent_id IS NULL AND is_install_memory = false)
  );

-- #723: shared_memory_of_agent_id IDENTIFIES an App's runtime `shared`
-- app-class memory (the find-or-create key that replaced the deterministic
-- `…:shared` urn), so it is meaningful only on an App-scoped app-class row.
-- NULL everywhere else — including the name-addressable createMemoryInApp
-- app-class memories.
ALTER TABLE memories
  DROP CONSTRAINT IF EXISTS chk_memory_shared_agent_scope;
ALTER TABLE memories
  ADD CONSTRAINT chk_memory_shared_agent_scope
  CHECK (shared_memory_of_agent_id IS NULL OR (class = 'app' AND app_id IS NOT NULL));

-- #2044 (S7): an App's INSTALL MEMORY is class='system', app_id set and
-- is_install_memory=true. install_of_agent_id identifies the Agent while
-- present; erasure may detach it to NULL without erasing the retained memory
-- (hrn:node:hadronmemory.com:specs:cor:dmo:060:01). ONE live install memory per
-- (App, Agent); a soft-deleted
-- one never blocks its replacement (Prisma cannot model the WHERE). Synced with
-- the 20261019090000 migration and src/test/globalSetup.ts.
CREATE UNIQUE INDEX IF NOT EXISTS memories_install_memory_live_uniq
  ON memories (app_id, install_of_agent_id)
  WHERE install_of_agent_id IS NOT NULL AND deleted_at IS NULL;

-- 023-app-shape FR-024: bidirectional invariant — class='group' ⇔
-- visibility='GROUP'.
ALTER TABLE memories
  DROP CONSTRAINT IF EXISTS chk_memory_group_visibility;
ALTER TABLE memories
  ADD CONSTRAINT chk_memory_group_visibility
  CHECK (
    (class = 'group' AND visibility = 'GROUP')
    OR
    (class <> 'group' AND visibility <> 'GROUP')
  );

-- #510: an AgentSchedule is EITHER recurring (cron) or one-shot (run_at).
ALTER TABLE agent_schedules
  DROP CONSTRAINT IF EXISTS chk_agent_schedule_cron_xor_run_at;
ALTER TABLE agent_schedules
  ADD CONSTRAINT chk_agent_schedule_cron_xor_run_at
  CHECK ((cron IS NULL) <> (run_at IS NULL));

-- 023-app-shape FR-025: group memory has no single owner.
ALTER TABLE memories
  DROP CONSTRAINT IF EXISTS chk_memory_group_no_owner;
ALTER TABLE memories
  ADD CONSTRAINT chk_memory_group_no_owner
  CHECK (class <> 'group' OR user_id IS NULL);

-- 035-visibility-enum-cleanup: visibility is meaningful only for knowledge
-- (PUBLIC/ORGANIZATION) and group (GROUP). Every other class has visibility
-- NULL. Loose form — forbids non-null elsewhere but does not require non-null
-- on knowledge/group (application code defaults knowledge to ORGANIZATION).
ALTER TABLE memories
  DROP CONSTRAINT IF EXISTS chk_memory_visibility_class;
ALTER TABLE memories
  ADD CONSTRAINT chk_memory_visibility_class
  CHECK (visibility IS NULL OR class IN ('knowledge', 'group'));

-- 023-app-shape FR-004 / FR-032: personal memory carries the (App, Agent,
-- User) scope. user_memory_of_agent_id (legacy column name; semantically
-- agent_id) is required-non-null for personal class. 'private' (added
-- 2026-05-24) shares the same scope shape and is covered here too.
--
-- NAMING DEBT: the constraint name still says "personal" but now also covers
-- 'private'. Rename to e.g. chk_memory_user_scoped_agent_id when next touching
-- this constraint.
-- 034-memory-class-access: the agent scope is required only for an APP-SCOPED
-- personal/private memory (app_id set). A free-standing personal/private memory
-- (app_id NULL) is exempt. (We deliberately do NOT couple app_id ⇔ agent: a
-- legacy pre-008 row may have app_id NULL with an agent set, and the MCP gate
-- has explicit handling + a regression test for that shape.)
-- #422: supported account erasure deletes Apps (cascading to owned App-scoped
-- memories) before Agents; relaxing Agent sharing must revisit this SET NULL/CHECK ordering.
ALTER TABLE memories
  DROP CONSTRAINT IF EXISTS chk_memory_personal_agent_id;
ALTER TABLE memories
  ADD CONSTRAINT chk_memory_personal_agent_id
  CHECK (class NOT IN ('personal', 'private') OR app_id IS NULL OR user_memory_of_agent_id IS NOT NULL);

-- ─── 033-rag-vector-retrieval ───────────────────────────────────────────
-- pgvector extension (db push with `extensions = [vector]` also handles this;
-- kept here so a bare psql -f post-push.sql is self-sufficient).
CREATE EXTENSION IF NOT EXISTS vector;

-- HNSW index for cosine similarity (pgvector defaults pinned).
CREATE INDEX IF NOT EXISTS node_embeddings_embedding_hnsw
  ON node_embeddings USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

-- One abstract vector per node (the @@unique can't dedupe NULL chunk_index rows).
CREATE UNIQUE INDEX IF NOT EXISTS node_embeddings_abstract_uniq
  ON node_embeddings (node_id) WHERE kind = 'abstract';

-- Cheap sweep "find work" indexes (scan only marked rows).
CREATE INDEX IF NOT EXISTS nodes_embedding_pending_idx
  ON nodes (embedding_pending_at) WHERE embedding_pending_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS nodes_embedding_failed_idx
  ON nodes (embedding_failed_at) WHERE embedding_failed_at IS NOT NULL;

-- FR-026: an encrypted memory cannot have the index enabled without a recorded
-- disclosure acknowledgment.
ALTER TABLE memories
  DROP CONSTRAINT IF EXISTS chk_memory_vector_encrypted_ack;
ALTER TABLE memories
  ADD CONSTRAINT chk_memory_vector_encrypted_ack
  CHECK (NOT (is_encrypted AND vector_index_enabled) OR vector_index_encrypted_ack_at IS NOT NULL);

-- FR-003: chunk dials sanity.
ALTER TABLE memories
  DROP CONSTRAINT IF EXISTS chk_memory_chunk_tokens_positive;
ALTER TABLE memories
  ADD CONSTRAINT chk_memory_chunk_tokens_positive
  CHECK (chunk_tokens IS NULL OR chunk_tokens > 0);

ALTER TABLE memories
  DROP CONSTRAINT IF EXISTS chk_memory_chunk_overlap_valid;
ALTER TABLE memories
  ADD CONSTRAINT chk_memory_chunk_overlap_valid
  CHECK (chunk_overlap IS NULL OR (chunk_overlap >= 0 AND (chunk_tokens IS NULL OR chunk_overlap < chunk_tokens)));

-- #621: per-node revision-history cap must be >= 1.
ALTER TABLE memories
  DROP CONSTRAINT IF EXISTS chk_memory_max_rev_count_positive;
ALTER TABLE memories
  ADD CONSTRAINT chk_memory_max_rev_count_positive
  CHECK (max_rev_count >= 1);

-- ─── 043-slack-integration ──────────────────────────────────────────────
-- One LIVE Slack connection per (org, workspace): PARTIAL unique so a
-- soft-deleted row never blocks re-registration (Prisma can't model the
-- WHERE clause). Synced with the 043 migration and src/test/globalSetup.ts.
CREATE UNIQUE INDEX IF NOT EXISTS slack_connections_org_team_active_uniq
  ON slack_connections (organization_id, team_id) WHERE deleted_at IS NULL;

-- ─── 036-ai-service-config ──────────────────────────────────────────────
-- A config belongs to exactly one owner (HadronServer / Organization /
-- App / Agent). Synced with the 036 migration and src/test/globalSetup.ts.
ALTER TABLE ai_service_configs
  DROP CONSTRAINT IF EXISTS chk_ai_service_config_owner;
ALTER TABLE ai_service_configs
  ADD CONSTRAINT chk_ai_service_config_owner
  CHECK (num_nonnulls(hadron_server_id, organization_id, app_id, agent_id) = 1);

-- ─── #2831 S1: a model group belongs to exactly one owner (Agent or App) ──
-- Synced with the 20261031230000 migration.
ALTER TABLE model_groups
  DROP CONSTRAINT IF EXISTS chk_model_group_owner;
ALTER TABLE model_groups
  ADD CONSTRAINT chk_model_group_owner
  CHECK (num_nonnulls(agent_id, app_id) = 1);

-- ─── #696: secrets are ORG/USER-owned only ───────────────────────────────
-- D-2026-07-15-006 narrows the #679 secret store to org/user owners (the flat
-- v2 secret URN carries a single root principal; app-/memory-owned shapes are
-- superseded). Synced with the 20260716120000 migration + src/test/globalSetup.ts.
ALTER TABLE secrets
  DROP CONSTRAINT IF EXISTS chk_secret_owner_type;
ALTER TABLE secrets
  ADD CONSTRAINT chk_secret_owner_type
  CHECK (owner_type IN ('user', 'org'));

-- ─── spec 047 Phase 2c: user-OR-org ownership ────────────────────────────
-- App / Agent / Memory are owned by EXACTLY ONE of an organization or a user
-- (org-XOR-owner). `organization_id` is nullable (a user-owned entity has no
-- org); `owner_user_id` (spec 047) is the user tenant owner. Synced with the
-- 20260714160000 migration + src/test/globalSetup.ts.
ALTER TABLE apps
  DROP CONSTRAINT IF EXISTS chk_app_owner_xor;
ALTER TABLE apps
  ADD CONSTRAINT chk_app_owner_xor
  CHECK ((organization_id IS NULL) <> (owner_user_id IS NULL));
-- Ruling DY-5: a dormancy threshold is a positive number of days. Synced with
-- the 20261005010000 migration + src/test/globalSetup.ts.
ALTER TABLE apps
  DROP CONSTRAINT IF EXISTS chk_app_session_dormancy_days_positive;
ALTER TABLE apps
  ADD CONSTRAINT chk_app_session_dormancy_days_positive
  CHECK (session_dormancy_days > 0);
ALTER TABLE agents
  DROP CONSTRAINT IF EXISTS chk_agent_owner_xor;
ALTER TABLE agents
  ADD CONSTRAINT chk_agent_owner_xor
  CHECK ((organization_id IS NULL) <> (owner_user_id IS NULL));
ALTER TABLE memories
  DROP CONSTRAINT IF EXISTS chk_memory_owner_xor;
ALTER TABLE memories
  ADD CONSTRAINT chk_memory_owner_xor
  CHECK ((organization_id IS NULL) <> (owner_user_id IS NULL));

-- URN-shape guardrail (spec 047 follow-up). memories.urn stores the BARE v2
-- form `<root>:<slug>` (single colon, NO scheme prefix); the display layer
-- (emitEntityUrnV2) prepends `hrn:mem:`. Storing the already-rendered form via
-- a raw UPDATE double-prefixes it (`hrn:mem:hrn:mem:holger:jens`), which fails
-- parseUrn and gets SILENTLY dropped from the portal's memory listing. This
-- rejects that class of write at the source — including hand-edits that bypass
-- the app layer.
--   * Matches only the rendered MEMORY display prefix (`hrn:mem:` / legacy
--     `hrn:memory:`), NOT every `hrn:` — a user whose handle is literally `hrn`
--     has a legitimate bare root `hrn:<slug>` that must remain writable (#762).
--   * lower() so a mixed-case `HRN:MEM:` hand-edit can't slip past (#762).
--   * NOT VALID: enforced on every INSERT/UPDATE but does not re-check
--     pre-existing rows, so it can never fail this idempotent re-run on a DB
--     that already holds a legacy oddity. (A later VALIDATE CONSTRAINT, after a
--     data audit, can promote it to fully validated.)
ALTER TABLE memories
  DROP CONSTRAINT IF EXISTS chk_memory_urn_not_prefixed;
ALTER TABLE memories
  ADD CONSTRAINT chk_memory_urn_not_prefixed
  CHECK (lower(urn) NOT LIKE 'hrn:mem:%' AND lower(urn) NOT LIKE 'hrn:memory:%') NOT VALID;

-- Per-owner name uniqueness (Prisma cannot express partial uniques).
CREATE UNIQUE INDEX IF NOT EXISTS ai_service_configs_server_name_uniq
  ON ai_service_configs (hadron_server_id, name) WHERE hadron_server_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ai_service_configs_org_name_uniq
  ON ai_service_configs (organization_id, name) WHERE organization_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ai_service_configs_app_name_uniq
  ON ai_service_configs (app_id, name) WHERE app_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ai_service_configs_agent_name_uniq
  ON ai_service_configs (agent_id, name) WHERE agent_id IS NOT NULL;

-- ─── spec 049 Phase 2 — Scope: exactly one owner + per-owner live-name uniqueness ──
-- Synced with the 20260915170000_scopes migration and src/test/globalSetup.ts.
ALTER TABLE scopes
  DROP CONSTRAINT IF EXISTS chk_scope_owner;
ALTER TABLE scopes
  ADD CONSTRAINT chk_scope_owner
  CHECK (num_nonnulls(organization_id, agent_id, app_id) = 1);
CREATE UNIQUE INDEX IF NOT EXISTS scopes_org_name_uniq
  ON scopes (organization_id, name) WHERE organization_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS scopes_agent_name_uniq
  ON scopes (agent_id, name) WHERE agent_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS scopes_app_name_uniq
  ON scopes (app_id, name) WHERE app_id IS NOT NULL AND deleted_at IS NULL;

-- ─── #1325 — MemoryConfig templates: exactly one owner + per-owner live-name
-- uniqueness; rule task-reference markers (fail closed on a hard-deleted task);
-- and #1322 dotted rule-key grammar. Synced with the
-- 20260925030000_memory_config + 20260925100000_dotted_role_rules migrations
-- and src/test/globalSetup.ts.
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
-- #1345 review (@copilot): name any existing rule key the new CHECKs would
-- refuse, and say what to do, instead of failing on an opaque constraint
-- violation. (The tables arrived in 20260925030000 and have no write path
-- before #1325(b), so none is expected; this makes the unexpected actionable.)
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(format('%s:%s (%L)', src, id, role), ', ') INTO bad FROM (
    SELECT 'node_role_rules' AS src, id, role FROM node_role_rules
     WHERE NOT (char_length(role) BETWEEN 1 AND 64 AND role ~ '^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$')
    UNION ALL
    SELECT 'memory_config_template_rules', id, role FROM memory_config_template_rules
     WHERE NOT (char_length(role) BETWEEN 1 AND 64 AND role ~ '^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$')
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
     AND role ~ '^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$');
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
     AND role ~ '^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$');

-- #974 Worker model (cor:dmo:050:11, cor:agt:020:02 v0.0.3): a worker's name
-- is unique per App, case-insensitively — a functional unique, so it lives
-- here and in the 20260814130000_worker_model migration (Prisma cannot
-- express it). Deliberately NOT filtered on retirement: a name binds to one
-- casting forever (PR trailers and chat archives reference it), so a retired
-- worker — and an uninstalled agent's surviving casting — keep the name
-- reserved.
CREATE UNIQUE INDEX IF NOT EXISTS workers_app_name_uniq
  ON workers (app_id, lower(name));

-- The mention-token unique that briefly followed here
-- (workers_app_mention_token_uniq, PR #978 review) was REMOVED by decision
-- (Holger, 2026-08-14): cor:agt:020:02 keeps ONE uniqueness layer — the name.
-- Mention-token collisions ("Mary Jane" / "Mary-Jane" → @mary-jane) are
-- accepted, as they were under the persona model. The DROP keeps a dev DB
-- that applied it in step; the 20260814150000 migration does the same for
-- migrated databases.
DROP INDEX IF EXISTS workers_app_mention_token_uniq;

-- #991 added a SECOND worker unique — `workers_app_slug_uniq` on (app_id, slug),
-- the URN atom. It is deliberately NOT declared here: it is a plain column pair,
-- so Prisma CAN model it, and it lives in schema.prisma's `@@unique`. Declaring
-- it here too would make every `db push` see it as drift and drop it.
--
-- It is also not the mention-token unique returning. That one REFUSED a cast;
-- this one never does — the slug mint iterates (`iris`, `iris-2`, …) until it
-- finds a free atom, so the name collision above stays the only allocation
-- primitive a caller can observe. The index is a race guard: two concurrent
-- casts deriving one base slug must not end up sharing a URN.

-- Cleanup for #975-pushed dev databases (`db push` does not run migrations):
-- the superseded persona-as-agent name machinery. `persona_name` /
-- `team_app_id` themselves are gone from schema.prisma, so `db push` drops
-- the columns (and with them the FK); these guarded DROPs only clear the
-- functional index and CHECK that Prisma cannot see. No-ops on fresh DBs.
DROP INDEX IF EXISTS agents_team_persona_name_uniq;
ALTER TABLE "agents" DROP CONSTRAINT IF EXISTS "chk_agent_persona_team_app";
DROP INDEX IF EXISTS agents_org_persona_name_uniq;
DROP INDEX IF EXISTS agents_owner_persona_name_uniq;

-- ─── 325-user-urn: handle is the hrn:user:<handle> slug ──────────────────
-- Case-insensitive uniqueness on the handle (lowercase-canonical), so a new
-- lowercased handle can never collide-by-case with an existing one. Prisma's
-- plain @unique is case-sensitive and can't express a functional index; this
-- is the real guarantee. Synced with the 325 migration + src/test/globalSetup.ts.
-- Partial (WHERE handle IS NOT NULL): handle-less users don't bloat the index.
CREATE UNIQUE INDEX IF NOT EXISTS users_handle_lower_uniq
  ON users (lower(handle)) WHERE handle IS NOT NULL;

-- ─── #692: unified principal pool — backfill for db-push setups ──────────
-- `principals.name` is a plain @unique (created by `db push` from the schema;
-- names are always written lowercased, so it is effectively case-insensitive).
-- The MIGRATION backfills a principal per existing user/org; but `db:dev-setup`
-- runs `db push` + this file, NOT the migration, so populate principals here too
-- or existing local rows stay invisible to the pool probe. Idempotent
-- (`principal_id IS NULL` + ON CONFLICT), so it is a no-op on the empty test
-- template and on already-backfilled rows. Soft-deleted → tombstoned.
INSERT INTO principals (id, name, kind, status, released_at, created_at, updated_at)
SELECT md5(random()::text || clock_timestamp()::text), lower(handle), 'user',
       CASE WHEN deleted_at IS NULL THEN 'active' ELSE 'released' END,
       deleted_at, (now() AT TIME ZONE 'utc'), (now() AT TIME ZONE 'utc')
FROM users u
WHERE handle IS NOT NULL AND principal_id IS NULL
ON CONFLICT (name) DO NOTHING;
UPDATE users u SET principal_id = p.id
FROM principals p WHERE p.kind = 'user' AND p.name = lower(u.handle) AND u.principal_id IS NULL;

INSERT INTO principals (id, name, kind, status, released_at, created_at, updated_at)
SELECT md5(random()::text || clock_timestamp()::text), lower(urn), 'org',
       CASE WHEN deleted_at IS NULL THEN 'active' ELSE 'released' END,
       deleted_at, (now() AT TIME ZONE 'utc'), (now() AT TIME ZONE 'utc')
FROM organizations o
WHERE principal_id IS NULL
ON CONFLICT (name) DO NOTHING;
UPDATE organizations o SET principal_id = p.id
FROM principals p WHERE p.kind = 'org' AND p.name = lower(o.urn) AND o.principal_id IS NULL;

-- Reserve the platform root words (idempotent).
INSERT INTO principals (id, name, kind, status, created_at, updated_at)
SELECT md5(random()::text || clock_timestamp()::text), r.w, 'platform', 'reserved',
       (now() AT TIME ZONE 'utc'), (now() AT TIME ZONE 'utc')
FROM (VALUES ('hadron'), ('hadronmemory'), ('hadron-memory'), ('platform'), ('host'), ('server')) AS r(w)
ON CONFLICT (name) DO NOTHING;

-- ─── cor:api:090 (findNodes) + cor:rag:010:02: lexical FTS substrate ─────
-- STORED generated tsvector (weighted A/B/C/D = name/alias > loc/tags >
-- description/abstract > content/data) + GIN index. Prisma models neither.
-- Synced with the 20260701120000_findnodes_fts migration + globalSetup.ts.
-- The weight expression lives in an IMMUTABLE wrapper fn: to_tsvector's named
-- config coerces 'english'→regconfig via a catalog lookup (non-immutable),
-- which a generated column rejects; the wrapper is the standard workaround.
-- IF NOT EXISTS (structural, like the HNSW index); changing the expression or
-- weights needs a dedicated DROP+ADD migration — this won't update it in place.
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

-- ── #719 structured/faceted query: value-cast guard functions + JSONB GIN ────
-- Mirrors prisma/migrations/20260718120000_where_query_helpers/migration.sql
-- (keep in lockstep). The `where` predicate compiler (src/lib/retrieval/
-- nodeWhere.ts) routes the stored-value (LHS) side of number/datetime
-- comparisons through these guards, so unparseable stored data yields NULL (row
-- drops out) instead of raising a cast error. Bounds are validated in the
-- compiler; the datetime bound is additionally guarded (defense-in-depth).
-- Prisma models neither plpgsql functions nor GIN(jsonb_path_ops), so `db push`
-- won't create these; this file does (idempotent CREATE OR REPLACE / IF NOT EXISTS).

CREATE OR REPLACE FUNCTION hadron_safe_numeric(input text)
RETURNS numeric
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
  IF input IS NULL THEN RETURN NULL; END IF;
  RETURN input::numeric;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION hadron_safe_timestamptz(input text)
RETURNS timestamptz
LANGUAGE plpgsql STABLE PARALLEL SAFE AS $$
BEGIN
  IF input IS NULL THEN RETURN NULL; END IF;
  RETURN input::timestamptz;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;

CREATE INDEX IF NOT EXISTS nodes_properties_gin ON nodes USING gin (properties jsonb_path_ops);
CREATE INDEX IF NOT EXISTS nodes_data_gin ON nodes USING gin (data jsonb_path_ops);

-- Spec 049 Phase 5 — the register's S1 CHECKs and partial uniques (Prisma
-- cannot express either). Synced with the 20260915220000_register_entries
-- migration.
ALTER TABLE register_entries
  DROP CONSTRAINT IF EXISTS chk_register_owner;
ALTER TABLE register_entries
  ADD CONSTRAINT chk_register_owner
  CHECK (num_nonnulls(organization_id, app_id) = 1);
ALTER TABLE register_entries
  DROP CONSTRAINT IF EXISTS chk_register_attendee;
ALTER TABLE register_entries
  ADD CONSTRAINT chk_register_attendee
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

-- Spec 049 Phase 7 — read-state: exactly one attendee, an Agent attendee
-- carries its App, and the (attendee, channel) natural keys the monotonic
-- upsert targets. Synced with the 20260915240000_channel_read_state migration.
ALTER TABLE channel_read_states
  DROP CONSTRAINT IF EXISTS chk_read_state_attendee;
ALTER TABLE channel_read_states
  ADD CONSTRAINT chk_read_state_attendee
  CHECK (num_nonnulls(worker_id, agent_id) = 1);
ALTER TABLE channel_read_states
  DROP CONSTRAINT IF EXISTS chk_read_state_agent_app;
ALTER TABLE channel_read_states
  ADD CONSTRAINT chk_read_state_agent_app
  CHECK (agent_id IS NULL OR app_id IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS channel_read_states_worker_channel_uniq
  ON channel_read_states (worker_id, channel_id) WHERE worker_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS channel_read_states_agent_app_channel_uniq
  ON channel_read_states (agent_id, app_id, channel_id) WHERE agent_id IS NOT NULL;

-- #1323 — every newly inserted Node gets a complete at-rest state baseline, including
-- raw/createMany writers Prisma cannot route through an application helper.
-- Keep in lockstep with 20260925010000_trustworthy_node_revisions and
-- 20260926220000_node_content_provenance.
ALTER TABLE "nodes" DROP CONSTRAINT IF EXISTS "chk_nodes_authorship_shape";
ALTER TABLE "nodes" ADD CONSTRAINT "chk_nodes_authorship_shape" CHECK (CASE
  WHEN "authorship_kind" IS NULL THEN
    "authored_by_task" IS NULL AND "authored_by_revision" IS NULL AND "authored_by_human" IS NULL AND "authored_at" IS NULL
  WHEN "authorship_kind" = 'TASK' THEN
    "authored_by_task" IS NOT NULL AND "authored_by_revision" IS NOT NULL AND "authored_by_revision" > 0 AND "authored_by_human" IS NULL AND "authored_at" IS NOT NULL
  WHEN "authorship_kind" = 'HUMAN' THEN
    "authored_by_task" IS NULL AND "authored_by_revision" IS NULL AND "authored_by_human" IS NOT NULL AND "authored_at" IS NOT NULL
  ELSE false END);
ALTER TABLE "node_revisions" DROP CONSTRAINT IF EXISTS "chk_node_revisions_authorship_shape";
ALTER TABLE "node_revisions" ADD CONSTRAINT "chk_node_revisions_authorship_shape" CHECK (CASE
  WHEN "authorship_kind" IS NULL THEN
    "authored_by_task" IS NULL AND "authored_by_revision" IS NULL AND "authored_by_human" IS NULL AND "authored_at" IS NULL
  WHEN "authorship_kind" = 'TASK' THEN
    "authored_by_task" IS NOT NULL AND "authored_by_revision" IS NOT NULL AND "authored_by_revision" > 0 AND "authored_by_human" IS NULL AND "authored_at" IS NOT NULL
  WHEN "authorship_kind" = 'HUMAN' THEN
    "authored_by_task" IS NULL AND "authored_by_revision" IS NULL AND "authored_by_human" IS NOT NULL AND "authored_at" IS NOT NULL
  ELSE false END);
-- #1591: a mint record is complete or absent. Synced with the migration and
-- src/test/globalSetup.ts.
ALTER TABLE "nodes" DROP CONSTRAINT IF EXISTS "chk_node_mint_complete";
ALTER TABLE "nodes" ADD CONSTRAINT "chk_node_mint_complete" CHECK (CASE
  WHEN "minted_at" IS NULL THEN
    "minted_by" IS NULL AND "minted_by_info" IS NULL AND "minted_rev_no" IS NULL AND "minted_hash" IS NULL
  ELSE
    ("minted_by" IS NOT NULL OR "minted_by_info" IS NOT NULL)
      AND ("minted_rev_no" IS NULL) = ("minted_hash" IS NULL)
      AND ("minted_rev_no" IS NULL OR "minted_rev_no" > 0)
  END);
-- #1591: an approval is complete or absent (#1838: the hash alone may be NULL, an approval ended on encrypted entry). Synced with the migration and
-- src/test/globalSetup.ts.
ALTER TABLE "nodes" DROP CONSTRAINT IF EXISTS "chk_node_approval_complete";
ALTER TABLE "nodes" ADD CONSTRAINT "chk_node_approval_complete" CHECK (CASE
  WHEN "approved_rev_no" IS NULL THEN
    "approved_at" IS NULL AND "approval_hash" IS NULL AND "approved_by" IS NULL AND "approved_by_info" IS NULL
  ELSE
    "approved_rev_no" > 0 AND "approved_at" IS NOT NULL
      AND ("approved_by" IS NOT NULL OR "approved_by_info" IS NOT NULL)
  END);
ALTER TABLE "node_content_validation_reports" DROP CONSTRAINT IF EXISTS "chk_node_content_validation_revisions_positive";
ALTER TABLE "node_content_validation_reports" ADD CONSTRAINT "chk_node_content_validation_revisions_positive"
  CHECK ("node_rev_seq" > 0 AND "validation_task_rev_seq" > 0);

-- Preserve a pre-existing drift mismatch when widening the fingerprint. On a
-- fresh DB the old function is absent, so there is no old hash to translate.
CREATE TEMP TABLE node_revision_hash_before_1326 (id TEXT, stored_hash TEXT, old_actual_hash TEXT);
DO $$ BEGIN
  IF to_regprocedure('hadron_node_revision_state_hash(nodes)') IS NOT NULL THEN
    EXECUTE 'INSERT INTO node_revision_hash_before_1326
      SELECT n.id, n.revision_content_hash, hadron_node_revision_state_hash(n) FROM nodes n';
  END IF;
END $$;

-- `prisma db push` adds the nullable column without running the migration, so
-- upgrade every row still carrying that one-time marker to the new LIVE-state
-- counter semantics before clearing it. Re-running post-push is then a no-op.
CREATE OR REPLACE FUNCTION hadron_node_revision_state_hash(node_row "nodes")
RETURNS TEXT
LANGUAGE sql
IMMUTABLE AS $$
  SELECT md5(jsonb_build_array(
    node_row."memory_id", node_row."loc", node_row."name", node_row."alias",
    node_row."description", node_row."abstract", node_row."abstract_origin_hash",
    node_row."content", to_jsonb(node_row."tags"), node_row."node_type",
    node_row."object_type", node_row."is_link", node_row."properties",
    node_row."data", node_row."seq", node_row."is_runnable", node_row."role",
    node_row."llm_model", node_row."ai_agent", node_row."authorship_kind",
    node_row."authored_by_task", node_row."authored_by_revision",
    node_row."authored_by_human", node_row."authored_at"
  )::text)
$$;

UPDATE "nodes" n SET "revision_content_hash" = hadron_node_revision_state_hash(n)
FROM node_revision_hash_before_1326 old
WHERE n.id = old.id AND old.stored_hash IS NOT NULL
  AND old.stored_hash = old.old_actual_hash;
DROP TABLE node_revision_hash_before_1326;

UPDATE "nodes"
SET "rev_seq" = "rev_seq" + 1,
    "revision_content_hash" = hadron_node_revision_state_hash("nodes")
WHERE "revision_content_hash" IS NULL;

CREATE OR REPLACE FUNCTION hadron_initialize_node_revision_content_hash()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW."revision_content_hash" = 'refresh' THEN
    NEW."revision_content_hash" := hadron_node_revision_state_hash(NEW);
    -- #1611 (cor:dmo:120:04): the content-change boundary moves only through a
    -- SANCTIONED writer (the same 'refresh' marker as the fingerprint above) and
    -- only when the three approval-hashed fields change under approval-hash v1
    -- normalization (CRLF and lone CR become LF; nothing else). A write outside
    -- the revision system never moves it, so its content change stays
    -- detectable as TAMPERED instead of passing for a supported edit.
    IF TG_OP = 'INSERT' THEN
      NEW."content_rev_seq" := NEW."rev_seq";
    ELSIF replace(replace(NEW."name", E'\r\n', E'\n'), E'\r', E'\n')
         IS DISTINCT FROM replace(replace(OLD."name", E'\r\n', E'\n'), E'\r', E'\n')
      OR replace(replace(NEW."abstract", E'\r\n', E'\n'), E'\r', E'\n')
         IS DISTINCT FROM replace(replace(OLD."abstract", E'\r\n', E'\n'), E'\r', E'\n')
      OR replace(replace(NEW."content", E'\r\n', E'\n'), E'\r', E'\n')
         IS DISTINCT FROM replace(replace(OLD."content", E'\r\n', E'\n'), E'\r', E'\n') THEN
      NEW."content_rev_seq" := NEW."rev_seq";
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS nodes_initialize_revision_content_hash ON "nodes";
CREATE TRIGGER nodes_initialize_revision_content_hash
BEFORE INSERT OR UPDATE ON "nodes"
FOR EACH ROW EXECUTE FUNCTION hadron_initialize_node_revision_content_hash();

-- #1430: C-collation index for paged-attention keyset pages. Prisma cannot
-- model column collation in @@index, so this is recreated after every push.
CREATE INDEX IF NOT EXISTS "nodes_memory_id_loc_c_idx" ON "nodes" ("memory_id", "loc" COLLATE "C");

-- #1430: Channel-local seq-first partial index for paged-attention scans.
-- Prisma cannot model collation in @@index, so this is recreated after push.
CREATE INDEX IF NOT EXISTS "nodes_msg_channel_seq_loc_c_idx"
  ON "nodes" ("message_channel_id", "seq", "loc" COLLATE "C")
  WHERE "node_type" = 'chat-message' AND "deleted_at" IS NULL AND "seq" IS NOT NULL;

-- #1606 / #1607 — comment-node invariants. One source, shared verbatim with
-- migration 20261005200000_comment_nodes (pinned by src/lib/comments/invariantsSql.test.ts).
\ir comment-invariants.sql
\ir boot-prompt-invariants.sql
\ir boot-prompt-pointer-invariants.sql
\ir compiled-prompt-revision-invariants.sql
\ir boot-prompt-approval-invariants.sql

-- #1655: compiled automation versions.
\ir automation-invariants.sql

-- #2441: append-only automation adoption events.
\ir automation-adoption-invariants.sql

-- #2484: an App's prefix-scoped write grant for userless runs, and its append-only events.
\ir app-memory-write-grant-invariants.sql

-- #430: the Git-mirror obligation's shape (closed error classes) and its attempt sequence.
\ir git-mirror-obligation-invariants.sql

-- #1705: agent task shape + the append-only team event stream. One source,
-- shared verbatim with migration 20261008010000_agent_tasks (pinned by
-- src/lib/agentTasks/invariants.test.ts).
\ir agent-task-invariants.sql

-- #2553: the hierarchical task handle (counters, number-filling and permanence triggers, the reserved AT0, NOT NULL). One source,
-- shared verbatim with migration 20261027100000_agent_task_number (pinned by src/lib/agentTasks/taskNumber2553.test.ts).
\ir agent-task-number-backfill.sql
\ir agent-task-number-invariants.sql

-- #2651: a task's latest hand-back (code, optional text, time). One source, shared verbatim with migration
-- 20261101090000_agent_task_hand_back (pinned by src/lib/agentTasks/invariants.test.ts).
\ir agent-task-hand-back-invariants.sql

-- #2649: a task's references are one JSON array of at most 20 items. One source, shared verbatim with migration
-- 20261101120000_agent_task_references (pinned by src/lib/agentTasks/invariants.test.ts).
\ir agent-task-references-invariants.sql

-- #3125 S1: an App's properties are a JSON object when set. One source, shared verbatim with migration
-- 20261101150000_app_properties (pinned by src/api/graphql/schema/appProperties3125.test.ts).
\ir app-properties-invariants.sql

-- #1706: stall alarms (one per episode), alarm wakes, availability for work and
-- per-App stall windows. One source, shared verbatim with migration
-- 20261024100200_context_reset_availability (the newest to carry it) (pinned by src/lib/agentTasks/invariants.test.ts).
\ir agent-task-stall-invariants.sql

-- #1707: a session's model family and host registrations. One source, shared
-- verbatim with migration 20261010010000_agent_task_matching (pinned by
-- src/lib/agentTasks/invariants.test.ts).
\ir agent-task-matching-invariants.sql
\ir task-blocker-invariants.sql

-- #1747: tickers, subscriptions, wake settings, the may-subscribe-workers grant
-- and the App ticker-settings bounds. One source, shared verbatim with migration
-- 20261011020000_tickers (pinned by src/lib/tickers/invariants.test.ts).
\ir ticker-invariants.sql
\ir ticker-tick-code-invariants.sql
\ir ticker-generated-live-unique.sql
\ir agent-ticker-template-invariants.sql
\ir delivery-settings-invariants.sql
\ir channel-checks-invariants.sql

-- #2022: stop signals, their coverage history and the stop holds of queued tasks. One source, shared verbatim with
-- migration 20261020030000_stop_signals (pinned by src/lib/stopSignals/invariants.test.ts).
\ir stop-signal-invariants.sql

-- #1749: App key scopes (cor:aut:010:03). One source, shared verbatim with migration
-- 20261011190000_app_key_scopes (pinned by src/lib/appKeyScopes/appKeyScopes.test.ts).
\ir app-key-scope-invariants.sql

-- #1709: host operations and the record of host-key use. One source, shared
-- verbatim with migration 20261024100100_context_reset_host_operations (the newest to carry it) (pinned by
-- src/lib/hostOperations/invariants.test.ts). After agent-task-matching-invariants.sql,
-- whose host_operation_token_ok it uses.
\ir host-operation-invariants.sql

-- #2162: a worker's context reset (cor:agt:050:27). One source, shared verbatim with migration
-- 20261024100000_context_reset (pinned by src/lib/contextReset/invariants.test.ts).
\ir context-reset-invariants.sql

-- #1709 slice 2: launch grants and host-launched sessions. One source, shared
-- verbatim with migration 20261014030000_host_launch (pinned by
-- src/lib/hostOperations/launch.test.ts).
\ir host-launch-invariants.sql

-- #1631: shared passkey registry invariant guards.
\ir passkey-invariants.sql

-- #1897: sign-in lineage guards. One source, shared verbatim with migration
-- 20261019120000_sign_in_lineage.
\ir signin-invariants.sql

-- #1631 PR1b slice 2: fresh sign-ins bound to the ceremony browser. One source, shared verbatim with migration
-- 20261021080000_fresh_sign_ins (pinned by src/lib/passkeys/freshSignIn1631.test.ts).
\ir fresh-sign-in-invariants.sql

-- #2204: OIDC nonce hash on pending logins. One source, shared verbatim with migration
-- 20261023120000_pending_login_provider_nonce (pinned by src/auth/providerNonce.test.ts).
\ir login-nonce-invariants.sql

-- #1631 PR2: passkey registration lifecycle (cancel tokens). One source, shared verbatim with migration
-- 20261022030000_passkey_revoke (pinned by src/lib/passkeys/cancel1631.test.ts).
\ir passkey-registration-invariants.sql
-- #1897 slice B1: pending email sign-ins. One source, shared verbatim with migration
-- 20261021120000_pending_email_sign_ins (pinned by src/auth/pendingEmailSignIn1897.test.ts).
\ir pending-email-sign-in-invariants.sql

-- #1632: signing requests, append-only signature records, the content-change
-- marker. One source, shared verbatim with migration 20261013160000_signing_requests.
\ir signing-invariants.sql

-- #1885: an Agent extends at most one base Agent; no cycles, at most 4 in a
-- chain. One source, shared verbatim with migration 20261014120000_agent_base
-- (pinned by src/api/graphql/schema/resolvers.agentBase1885.test.ts).
\ir agent-base-invariants.sql

-- #1903: session liveness's activity probe, max(created_at) over a session's
-- counts_as_activity events. Partial, so Prisma's schema language can't model
-- it; `db push` and `migrate diff` leave it alone (verified on Prisma 6.19), so
-- this file is what builds it on push-managed DBs. Same definition as migration
-- 20261014040000_usage_events_session_activity_idx, which builds it
-- CONCURRENTLY for production; production went down for an hour without it
-- (ops:alpha:incident-2026-10-14-pool-exhaustion-liveness-query).
CREATE INDEX IF NOT EXISTS usage_events_session_activity_idx
  ON usage_events (session_id, created_at) WHERE counts_as_activity;

-- #1647: the admin-erasure audit is append-only and its reason is trimmed, 1-500 code points
-- (Prisma can model neither; the migration carries the same statements).
ALTER TABLE user_deletion_audits DROP CONSTRAINT IF EXISTS chk_user_deletion_reason;
ALTER TABLE user_deletion_audits ADD CONSTRAINT chk_user_deletion_reason
  CHECK (reason = btrim(reason) AND char_length(reason) BETWEEN 1 AND 500);
CREATE OR REPLACE FUNCTION hadron_user_deletion_audit_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'user_deletion_audits is append-only';
END $$;
DROP TRIGGER IF EXISTS user_deletion_audits_immutable ON user_deletion_audits;
CREATE TRIGGER user_deletion_audits_immutable
  BEFORE UPDATE OR DELETE ON user_deletion_audits
  FOR EACH ROW EXECUTE FUNCTION hadron_user_deletion_audit_immutable();

-- #2245 (R170.6): the Agent-clone audit is append-only and names exactly one target
-- (Prisma can model neither; the migration carries the same statements).
ALTER TABLE agent_clone_audits DROP CONSTRAINT IF EXISTS chk_agent_clone_audit_one_target;
ALTER TABLE agent_clone_audits ADD CONSTRAINT chk_agent_clone_audit_one_target
  CHECK ((target_org_id IS NOT NULL) <> (target_user_id IS NOT NULL));
CREATE OR REPLACE FUNCTION hadron_agent_clone_audit_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'agent_clone_audits is append-only';
END $$;
DROP TRIGGER IF EXISTS agent_clone_audits_immutable ON agent_clone_audits;
CREATE TRIGGER agent_clone_audits_immutable
  BEFORE UPDATE OR DELETE ON agent_clone_audits
  FOR EACH ROW EXECUTE FUNCTION hadron_agent_clone_audit_immutable();

-- #1162: newly introduced typed Worker/session references fence hard deletion.
\ir worker-reference-invariants.sql

-- S12 explicit reporting choice (legacy UNSET retained).
\ir worker-team-choice-invariants.sql
-- #423: outgoing-edge lookup/delete must not scan every tenant’s edges.
CREATE INDEX IF NOT EXISTS "edges_source_id_idx" ON "edges"("source_id");
-- #2047: the served-prompt record — one owner, owner-consistent identity, immutable, deleted only with its owner. After
-- the #1162 fence file: it puts the record's worker/session columns under that fence function.
\ir served-prompt-invariants.sql
\ir served-prompt-app-invariants.sql

-- #2755: the dark-worker alarm's window, episodes and their worker fence (the fence function is #1162's, above).
\ir dark-alarm-invariants.sql

-- #2014: the team-chat post limit's episodes and their worker fence.
\ir post-limit-invariants.sql

-- #2479: per-trigger run budget limits.
\ir trigger-run-budget-invariants.sql

-- #451: delete-path FK columns need a leading index (the same statements as the four 20261031110x migrations).
CREATE INDEX IF NOT EXISTS "usage_events_node_id_idx" ON "usage_events"("node_id");
CREATE INDEX IF NOT EXISTS "sessions_agent_id_idx" ON "sessions"("agent_id");
CREATE INDEX IF NOT EXISTS "sessions_memory_id_idx" ON "sessions"("memory_id");
CREATE INDEX IF NOT EXISTS "agents_organization_id_idx" ON "agents"("organization_id");
