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

-- 008-agent-installation, relaxed by 034-memory-class-access: app_id is
-- REQUIRED only for class='app'; FORBIDDEN for system/knowledge/group;
-- OPTIONAL for personal/private (set when provisioned inside an app — the
-- (app, user) scope; NULL when free-standing / user-owned).
ALTER TABLE memories
  DROP CONSTRAINT IF EXISTS chk_memory_class_app_id;
ALTER TABLE memories
  ADD CONSTRAINT chk_memory_class_app_id
  CHECK (
    (class = 'app' AND app_id IS NOT NULL)
    OR (class IN ('system', 'knowledge', 'group') AND app_id IS NULL)
    OR (class IN ('personal', 'private'))
  );

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

-- ─── 036-ai-service-config ──────────────────────────────────────────────
-- A config belongs to exactly one owner (HadronServer / Organization /
-- App / Agent). Synced with the 036 migration and src/test/globalSetup.ts.
ALTER TABLE ai_service_configs
  DROP CONSTRAINT IF EXISTS chk_ai_service_config_owner;
ALTER TABLE ai_service_configs
  ADD CONSTRAINT chk_ai_service_config_owner
  CHECK (num_nonnulls(hadron_server_id, organization_id, app_id, agent_id) = 1);

-- Per-owner name uniqueness (Prisma cannot express partial uniques).
CREATE UNIQUE INDEX IF NOT EXISTS ai_service_configs_server_name_uniq
  ON ai_service_configs (hadron_server_id, name) WHERE hadron_server_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ai_service_configs_org_name_uniq
  ON ai_service_configs (organization_id, name) WHERE organization_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ai_service_configs_app_name_uniq
  ON ai_service_configs (app_id, name) WHERE app_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ai_service_configs_agent_name_uniq
  ON ai_service_configs (agent_id, name) WHERE agent_id IS NOT NULL;

-- ─── 325-user-urn: handle is the hrn:user:<handle> slug ──────────────────
-- Case-insensitive uniqueness on the handle (lowercase-canonical), so a new
-- lowercased handle can never collide-by-case with an existing one. Prisma's
-- plain @unique is case-sensitive and can't express a functional index; this
-- is the real guarantee. Synced with the 325 migration + src/test/globalSetup.ts.
-- Partial (WHERE handle IS NOT NULL): handle-less users don't bloat the index.
CREATE UNIQUE INDEX IF NOT EXISTS users_handle_lower_uniq
  ON users (lower(handle)) WHERE handle IS NOT NULL;

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
