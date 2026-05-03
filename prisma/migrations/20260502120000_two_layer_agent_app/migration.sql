-- 008-agent-installation: Two-layer Agent (definition) + App (deployment).
-- Spec: specs/008-agent-installation/spec.md
-- Contract: specs/008-agent-installation/contracts/migration-sql.md
--
-- Sequencing within the transaction:
--   1. New tables (no existing-table dependencies)
--   2. New columns on existing tables
--   3. Backfill App.agent_id from app_agents fold (handles fan-out + orphans)
--   3d. Log AppAgent.role='DEVELOP' rows for operator notification (R-10)
--   4. Backfill Memory.app_id from Session attribution (personal class)
--   5. CHECK constraints (after backfill so existing rows pass)
--   6. Drop the now-unused app_agents table

BEGIN;

-- ──────────────────────────────────────────────────────────────────────
-- 1. New tables
-- ──────────────────────────────────────────────────────────────────────

-- Constraint + index names follow Prisma's introspection convention so
-- `prisma migrate diff` reports a clean state when comparing this
-- migration's output against schema.prisma. Prisma also defaults FKs to
-- ON UPDATE CASCADE and uses TIMESTAMP(3) for DateTime columns; we match.
CREATE TABLE "app_members" (
  "app_id"      TEXT NOT NULL,
  "user_id"     TEXT NOT NULL,
  "role"        TEXT NOT NULL,
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by"  TEXT,
  "updated_at"  TIMESTAMP(3),
  "updated_by"  TEXT,

  CONSTRAINT "app_members_pkey" PRIMARY KEY ("app_id", "user_id")
);

CREATE INDEX "app_members_user_id_idx" ON "app_members" ("user_id");

CREATE TABLE "agent_org_grants" (
  "org_id"        TEXT NOT NULL,
  "agent_id"      TEXT NOT NULL,
  "activated_at"  TIMESTAMP(3),
  "expires_at"    TIMESTAMP(3),
  "revoked_at"    TIMESTAMP(3),
  "revoked_by"    TEXT,
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by"    TEXT,
  "updated_at"    TIMESTAMP(3),
  "updated_by"    TEXT,

  CONSTRAINT "agent_org_grants_pkey" PRIMARY KEY ("org_id", "agent_id")
);

CREATE INDEX "agent_org_grants_agent_id_idx" ON "agent_org_grants" ("agent_id");

CREATE TABLE "agent_imports" (
  "parent_agent_id"           TEXT    NOT NULL,
  "imported_agent_id"         TEXT    NOT NULL,
  "position"                  INTEGER NOT NULL,
  "required"                  BOOLEAN NOT NULL DEFAULT TRUE,
  "agent_org_grant_org_id"    TEXT    NOT NULL,
  "agent_org_grant_agent_id"  TEXT    NOT NULL,
  "created_at"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by"                TEXT,

  CONSTRAINT "agent_imports_pkey" PRIMARY KEY ("parent_agent_id", "imported_agent_id")
);

CREATE UNIQUE INDEX "agent_imports_parent_agent_id_position_key" ON "agent_imports" ("parent_agent_id", "position");
CREATE INDEX "agent_imports_imported_agent_id_idx" ON "agent_imports" ("imported_agent_id");

-- FK constraints. Names follow Prisma's `<table>_<column>_fkey` convention
-- (the agent_imports composite FK uses the underscore-joined column name
-- list, matching what `prisma migrate dev` would emit). All FKs include
-- ON UPDATE CASCADE to match Prisma's default.
ALTER TABLE "app_members"
  ADD CONSTRAINT "app_members_app_id_fkey"
  FOREIGN KEY ("app_id") REFERENCES "apps" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "app_members"
  ADD CONSTRAINT "app_members_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_org_grants"
  ADD CONSTRAINT "agent_org_grants_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organizations" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_org_grants"
  ADD CONSTRAINT "agent_org_grants_agent_id_fkey"
  FOREIGN KEY ("agent_id") REFERENCES "agents" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_imports"
  ADD CONSTRAINT "agent_imports_parent_agent_id_fkey"
  FOREIGN KEY ("parent_agent_id") REFERENCES "agents" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_imports"
  ADD CONSTRAINT "agent_imports_imported_agent_id_fkey"
  FOREIGN KEY ("imported_agent_id") REFERENCES "agents" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "agent_imports"
  ADD CONSTRAINT "agent_imports_agent_org_grant_org_id_agent_org_grant_agent_fkey"
  FOREIGN KEY ("agent_org_grant_org_id", "agent_org_grant_agent_id")
  REFERENCES "agent_org_grants" ("org_id", "agent_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ──────────────────────────────────────────────────────────────────────
-- 2. New columns on existing tables
-- ──────────────────────────────────────────────────────────────────────

-- Agent: declarative knobs (per FR-008 / FR-009)
ALTER TABLE "agents"
  ADD COLUMN "memory_provisioning"  JSONB NOT NULL DEFAULT '{"appMemory": "shared"}'::jsonb,
  ADD COLUMN "installation_policy"  JSONB NOT NULL DEFAULT '{"maxMembers": "unlimited", "memberRoles": ["owner"]}'::jsonb;

-- App: agent FK + training mode + surfaces (per FR-002 / FR-014 / FR-022 / FR-024)
ALTER TABLE "apps"
  ADD COLUMN "agent_id"      TEXT,
  ADD COLUMN "training_mode" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "surfaces"      TEXT[]  NOT NULL DEFAULT ARRAY['chat']::TEXT[];

ALTER TABLE "apps"
  ADD CONSTRAINT "apps_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "apps_agent_id_idx" ON "apps" ("agent_id");

-- Memory: app_id pivot (per FR-011 / R-3)
ALTER TABLE "memories"
  ADD COLUMN "app_id" TEXT;

-- ON DELETE CASCADE: hard App deletion cleans up its personal/app memories.
-- A SET NULL cascade would conflict with chk_memory_class_app_id (added in
-- step 5) which prohibits app_id IS NULL when class IN ('app', 'personal').
-- The AppMember-removal orphan-retention path (FR-015) is independent — it
-- deletes from app_members, not apps.
ALTER TABLE "memories"
  ADD CONSTRAINT "memories_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Full (not partial) index — Prisma's introspection produces this shape.
CREATE INDEX "memories_app_id_idx" ON "memories" ("app_id");

-- ──────────────────────────────────────────────────────────────────────
-- 3. Backfill: App.agent_id from app_agents fold (handles fan-out + orphans)
-- ──────────────────────────────────────────────────────────────────────

-- 3a. Apps with exactly one AppAgent row: set agent_id directly.
UPDATE "apps" a
   SET "agent_id"      = aa."agent_id",
       "training_mode" = aa."training_mode"
  FROM "app_agents" aa
 WHERE aa."app_id" = a."id"
   AND (SELECT COUNT(*) FROM "app_agents" WHERE "app_id" = a."id") = 1;

-- 3b. Apps with N>1 AppAgent rows: fan out.
-- For each (App, Agent) pair beyond the first, INSERT a copy of the App row
-- (with a new app id, derived urn, agent_id set to the second/third/... AppAgent's
-- agent_id), and duplicate the App's AppKey rows to the new App.
--
-- The "first" AppAgent is picked deterministically by (created_at, agent_id) ordering
-- so the migration is reproducible.
DO $$
DECLARE
  app_record RECORD;
  agent_record RECORD;
  new_app_id TEXT;
  is_first BOOLEAN;
BEGIN
  FOR app_record IN
    SELECT a."id", a."urn"
      FROM "apps" a
     WHERE (SELECT COUNT(*) FROM "app_agents" WHERE "app_id" = a."id") > 1
  LOOP
    is_first := TRUE;
    FOR agent_record IN
      SELECT "agent_id", "training_mode"
        FROM "app_agents"
       WHERE "app_id" = app_record."id"
       ORDER BY "created_at" ASC, "agent_id" ASC
    LOOP
      IF is_first THEN
        -- The "first" AppAgent stays with the original App row.
        UPDATE "apps"
           SET "agent_id"      = agent_record."agent_id",
               "training_mode" = agent_record."training_mode"
         WHERE "id" = app_record."id";
        is_first := FALSE;
      ELSE
        -- Fan out: clone the App row + AppKey rows.
        new_app_id := gen_random_uuid()::TEXT;

        INSERT INTO "apps" (
          "id", "organization_id", "urn", "name", "app_type", "role",
          "description", "system_prompt", "agent_tools",
          "ai_provider", "ai_model", "ai_api_key_encrypted",
          "expires_at", "create_user_permission", "identify_user_method",
          "session_timeout_seconds", "anonymous_ttl_days",
          "agent_id", "training_mode", "surfaces",
          "created_at", "created_by"
        )
        SELECT
          new_app_id, "organization_id", "urn" || ':fanned-' || agent_record."agent_id",
          "name" || ' (' || agent_record."agent_id" || ')',
          "app_type", "role",
          "description", "system_prompt", "agent_tools",
          "ai_provider", "ai_model", "ai_api_key_encrypted",
          "expires_at", "create_user_permission", "identify_user_method",
          "session_timeout_seconds", "anonymous_ttl_days",
          agent_record."agent_id", agent_record."training_mode", "surfaces",
          NOW(), 'migration:008-agent-installation'
          FROM "apps" WHERE "id" = app_record."id";

        -- Duplicate AppKey rows to the new App.
        -- key_hash must remain unique across app_keys; the suffix preserves
        -- uniqueness while keeping the original wire token traceable. Note
        -- per contracts/migration-sql.md: the original wire token authenticates
        -- only into the original App; fanned copies need fresh keys post-migration.
        INSERT INTO "app_keys" (
          "id", "app_id", "key_hash", "key_preview", "label",
          "last_used_at", "revoked_at",
          "created_at", "created_by"
        )
        SELECT
          gen_random_uuid()::TEXT, new_app_id,
          "key_hash" || ':fanned-' || agent_record."agent_id",
          "key_preview", "label",
          "last_used_at", "revoked_at",
          NOW(), 'migration:008-agent-installation'
          FROM "app_keys" WHERE "app_id" = app_record."id";
      END IF;
    END LOOP;
  END LOOP;
END $$;

-- 3c. Orphan Apps (zero AppAgent rows): leave agent_id NULL — flagged for
-- operator review. No action needed; the column default is NULL.

-- 3d. Log AppAgent.role='DEVELOP' rows for operator notification (R-10).
-- The migration runner captures the NOTICE; the matching `app_log` row is
-- inserted in the same loop so the App owner sees the deprecation in the
-- portal next time they look. Per spec FR-007 / R-10 / task T021.
DO $$
DECLARE
  develop_record RECORD;
BEGIN
  FOR develop_record IN
    SELECT "app_id", "agent_id" FROM "app_agents" WHERE "role" = 'DEVELOP'
  LOOP
    RAISE NOTICE 'AppAgent.role=DEVELOP migrated: app_id=% agent_id=% (DEVELOP-from-App is no longer supported; use the Agent-ownership surface to edit Agent definitions)',
      develop_record."app_id", develop_record."agent_id";

    INSERT INTO "app_log" (
      "id", "app_id", "level", "message", "detail",
      "created_at", "created_by"
    )
    VALUES (
      gen_random_uuid()::TEXT,
      develop_record."app_id",
      'WARN',
      'DEVELOP-from-App is no longer supported. To edit this Agent''s design, open the Agent in its owning org''s ownership surface.',
      jsonb_build_object(
        'source', 'migration:008-agent-installation',
        'reason', 'AppAgent.role=DEVELOP dropped per spec 008 R-10',
        'agentId', develop_record."agent_id"
      ),
      NOW(),
      'migration:008-agent-installation'
    );
  END LOOP;
END $$;

-- ──────────────────────────────────────────────────────────────────────
-- 4. Backfill: Memory.app_id from Session attribution (personal class only)
-- ──────────────────────────────────────────────────────────────────────

-- 4a. For each personal-class memory with a user_memory_of_agent_id, find the
-- most recent session of (memory.user_id, memory.user_memory_of_agent_id) that
-- has a non-null app_id; set memory.app_id to that session's app_id.
UPDATE "memories" m
   SET "app_id" = (
         SELECT s."app_id"
           FROM "sessions" s
          WHERE s."user_id"  = m."user_id"
            AND s."app_id"   IS NOT NULL
            -- Match the agent via App.agent_id post-step-3
            AND EXISTS (
              SELECT 1 FROM "apps" a
               WHERE a."id" = s."app_id"
                 AND a."agent_id" = m."user_memory_of_agent_id"
            )
          ORDER BY s."started_at" DESC
          LIMIT 1
       )
 WHERE m."class" = 'personal'
   AND m."app_id" IS NULL;

-- 4b. Personal-class memories with no Session attribution: downgrade to
-- 'knowledge' (R-3 fallback). The downgrade clears `user_id` and resets
-- `visibility` to PRIVATE — a knowledge-class memory can't carry a
-- per-user owner per the chk_personal_visibility_user invariant
-- (PERSONAL ⇔ user_id IS NOT NULL). Operator can audit via the NOTICE.
DO $$
DECLARE
  orphan_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO orphan_count
    FROM "memories"
   WHERE "class" = 'personal' AND "app_id" IS NULL;

  IF orphan_count > 0 THEN
    RAISE NOTICE 'Downgrading % personal-class memories with no Session attribution to class=knowledge (no App pivot found)', orphan_count;

    UPDATE "memories"
       SET "class"      = 'knowledge',
           "user_id"    = NULL,
           "visibility" = 'PRIVATE'
     WHERE "class" = 'personal' AND "app_id" IS NULL;
  END IF;
END $$;

-- ──────────────────────────────────────────────────────────────────────
-- 5. CHECK constraints (after backfill so existing rows pass)
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE "memories"
  ADD CONSTRAINT "chk_memory_class_app_id"
  CHECK (
    (class IN ('app', 'personal') AND app_id IS NOT NULL)
    OR (class IN ('system', 'knowledge') AND app_id IS NULL)
  );

-- ──────────────────────────────────────────────────────────────────────
-- 6. Drop the now-unused app_agents table
-- ──────────────────────────────────────────────────────────────────────

DROP TABLE "app_agents";

-- The AppAgentRole enum was only used by app_agents.role. Drop after the
-- table is gone so no dependent objects remain.
DROP TYPE IF EXISTS "AppAgentRole";

COMMIT;
