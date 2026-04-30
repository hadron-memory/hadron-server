-- Spec: 005-agent-subscription
-- See `specs/005-agent-subscription/contracts/migration-sql.md` for the
-- canonical version + sequencing rationale + concurrent-traffic safety
-- analysis. SQL here is verbatim from that contract.

BEGIN;

-- ──────────────────────────────────────────────────────────────────────
-- 1. New types and tables
-- ──────────────────────────────────────────────────────────────────────

-- New enum: MemoryClass
CREATE TYPE "MemoryClass" AS ENUM ('system', 'app', 'knowledge', 'personal');

-- Add PERSONAL to existing MemoryVisibility enum
ALTER TYPE "MemoryVisibility" ADD VALUE IF NOT EXISTS 'PERSONAL';

-- New table: agent_subscriptions
CREATE TABLE "agent_subscriptions" (
  "user_id"       TEXT      NOT NULL,
  "agent_id"      TEXT      NOT NULL,
  "activated_at"  TIMESTAMPTZ,
  "expires_at"    TIMESTAMPTZ,
  "revoked_at"    TIMESTAMPTZ,
  "revoked_by"    TEXT,
  "created_at"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "created_by"    TEXT,
  "updated_at"    TIMESTAMPTZ,
  "updated_by"    TEXT,

  PRIMARY KEY ("user_id", "agent_id"),
  CONSTRAINT "agent_subscriptions_user_id_fkey"
    FOREIGN KEY ("user_id")  REFERENCES "users"  ("id") ON DELETE CASCADE,
  CONSTRAINT "agent_subscriptions_agent_id_fkey"
    FOREIGN KEY ("agent_id") REFERENCES "agents" ("id") ON DELETE CASCADE
);

CREATE INDEX "agent_subscriptions_agent_id_idx" ON "agent_subscriptions" ("agent_id");

-- ──────────────────────────────────────────────────────────────────────
-- 2. New columns on existing tables
-- ──────────────────────────────────────────────────────────────────────

-- Memory.userId — nullable; foreign key to users
ALTER TABLE "memories"
  ADD COLUMN "user_id" TEXT;

ALTER TABLE "memories"
  ADD CONSTRAINT "memories_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE SET NULL;

CREATE INDEX "memories_user_id_idx" ON "memories" ("user_id") WHERE "user_id" IS NOT NULL;

-- Memory.class — added nullable first, backfilled, then made NOT NULL
ALTER TABLE "memories"
  ADD COLUMN "class" "MemoryClass";

-- ──────────────────────────────────────────────────────────────────────
-- 3. Backfill
-- ──────────────────────────────────────────────────────────────────────

-- 'system' — memories pointed at by some Agent.system_memory_id
UPDATE "memories"
   SET "class" = 'system'
 WHERE "id" IN (SELECT "system_memory_id" FROM "agents" WHERE "system_memory_id" IS NOT NULL);

-- 'personal' — memories with a user_memory_of_agent_id pointer
UPDATE "memories"
   SET "class" = 'personal'
 WHERE "user_memory_of_agent_id" IS NOT NULL;

-- 'knowledge' — everything else (default)
UPDATE "memories"
   SET "class" = 'knowledge'
 WHERE "class" IS NULL;

-- 'app' — none backfilled; populated as new app memories are created post-migration

-- For existing personal-class memories: backfill user_id from Session attribution + flip visibility to PERSONAL
UPDATE "memories" AS m
   SET "user_id" = (
         SELECT s."user_id"
           FROM "sessions" s
          WHERE s."memory_id" = m."id"
            AND s."user_id" IS NOT NULL
          ORDER BY s."started_at" ASC
          LIMIT 1
       ),
       "visibility" = 'PERSONAL'
 WHERE m."class" = 'personal';

-- Personal-class memories with no Session attribution remain visibility=<previous> with user_id=NULL.
-- The CHECK constraint below would reject these — handle with a fallback:
-- if user_id is still NULL on a personal-class memory, downgrade its class to 'knowledge'
-- so the row stays valid. Operator can audit/fix manually if needed.
UPDATE "memories"
   SET "class" = 'knowledge',
       "visibility" = 'PRIVATE'
 WHERE "class" = 'personal'
   AND "user_id" IS NULL;

-- Now make class NOT NULL (every row has a value)
ALTER TABLE "memories"
  ALTER COLUMN "class" SET NOT NULL;

-- ──────────────────────────────────────────────────────────────────────
-- 4. CHECK constraint (after backfill so existing rows pass)
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE "memories"
  ADD CONSTRAINT "chk_personal_visibility_user"
  CHECK (("visibility" = 'PERSONAL') = ("user_id" IS NOT NULL));

-- ──────────────────────────────────────────────────────────────────────
-- 5. Drop unused columns (last — safest)
-- ──────────────────────────────────────────────────────────────────────

-- AppAgent.subscription_type — superseded by AgentMemoryItem.role per FR-006
ALTER TABLE "app_agents"
  DROP COLUMN "subscription_type";

-- User.external_id was originally going to drop here per spec R-5, but
-- discovered during implementation that createAppUser + startAgentSession
-- use it as the lookup-key for chatbot-provided external user-ids.
-- Dropping requires a separate design discussion to settle the chatbot
-- idempotency-lookup mechanism. Kept; deferred.

COMMIT;
