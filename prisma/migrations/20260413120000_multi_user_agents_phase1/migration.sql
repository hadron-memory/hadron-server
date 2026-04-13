-- Multi-user agents: Phase 1
-- Adds user identity fields, App/AppKey/AppAgent, Session multi-user fields,
-- Memory userMemoryOfAgentId + anonymousExpiresAt, Agent type + surfaces.

-- ── Enum extensions ─────────────────────────────────────────────────

-- Extend IdentityProvider
ALTER TYPE "IdentityProvider" ADD VALUE IF NOT EXISTS 'APP';
ALTER TYPE "IdentityProvider" ADD VALUE IF NOT EXISTS 'GOOGLE';
ALTER TYPE "IdentityProvider" ADD VALUE IF NOT EXISTS 'MICROSOFT';

-- New enums
DO $$ BEGIN
  CREATE TYPE "CreateUserPermission" AS ENUM ('DENY', 'EXPLICIT', 'IMPLICIT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "IdentifyUserMethod" AS ENUM ('USER_ID', 'SECRET');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "AgentType" AS ENUM ('ASSISTANT', 'CHATBOT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── User identity fields ────────────────────────────────────────────

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "external_id" TEXT,
  ADD COLUMN IF NOT EXISTS "external_app_id" TEXT,
  ADD COLUMN IF NOT EXISTS "linked_at" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "users_external_app_id_external_id_key"
  ON "users"("external_app_id", "external_id")
  WHERE "external_id" IS NOT NULL;

-- ── App, AppKey, AppAgent ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "apps" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "create_user_permission" "CreateUserPermission" NOT NULL DEFAULT 'EXPLICIT',
  "identify_user_method" "IdentifyUserMethod" NOT NULL DEFAULT 'USER_ID',
  "session_timeout_seconds" INTEGER NOT NULL DEFAULT 900,
  "anonymous_ttl_days" INTEGER NOT NULL DEFAULT 7,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by" TEXT,
  "updated_at" TIMESTAMP(3),
  "updated_by" TEXT,
  "deleted_at" TIMESTAMP(3),
  "deleted_by" TEXT,
  CONSTRAINT "apps_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "apps_organization_id_idx" ON "apps"("organization_id");

CREATE TABLE IF NOT EXISTS "app_keys" (
  "id" TEXT NOT NULL,
  "app_id" TEXT NOT NULL,
  "key_hash" TEXT NOT NULL,
  "key_preview" TEXT NOT NULL,
  "label" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by" TEXT,
  "last_used_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  CONSTRAINT "app_keys_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "app_keys_key_hash_key" ON "app_keys"("key_hash");
CREATE INDEX IF NOT EXISTS "app_keys_app_id_idx" ON "app_keys"("app_id");

CREATE TABLE IF NOT EXISTS "app_agents" (
  "app_id" TEXT NOT NULL,
  "agent_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "app_agents_pkey" PRIMARY KEY ("app_id", "agent_id")
);

CREATE INDEX IF NOT EXISTS "app_agents_agent_id_idx" ON "app_agents"("agent_id");

-- Foreign keys
ALTER TABLE "users"
  ADD CONSTRAINT "users_external_app_id_fkey"
  FOREIGN KEY ("external_app_id") REFERENCES "apps"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "apps"
  ADD CONSTRAINT "apps_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "app_keys"
  ADD CONSTRAINT "app_keys_app_id_fkey"
  FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "app_agents"
  ADD CONSTRAINT "app_agents_app_id_fkey"
  FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "app_agents"
  ADD CONSTRAINT "app_agents_agent_id_fkey"
  FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Session multi-user fields ──────────────────────────────────────

ALTER TABLE "sessions"
  ADD COLUMN IF NOT EXISTS "app_id" TEXT,
  ADD COLUMN IF NOT EXISTS "user_id" TEXT,
  ADD COLUMN IF NOT EXISTS "agent_id" TEXT,
  ADD COLUMN IF NOT EXISTS "memory_id" TEXT,
  ADD COLUMN IF NOT EXISTS "expires_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "sessions_app_id_user_id_idx" ON "sessions"("app_id", "user_id");
CREATE INDEX IF NOT EXISTS "sessions_expires_at_idx" ON "sessions"("expires_at");

ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_app_id_fkey"
  FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_agent_id_fkey"
  FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_memory_id_fkey"
  FOREIGN KEY ("memory_id") REFERENCES "memories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Memory user-memory fields ──────────────────────────────────────

ALTER TABLE "memories"
  ADD COLUMN IF NOT EXISTS "user_memory_of_agent_id" TEXT,
  ADD COLUMN IF NOT EXISTS "anonymous_expires_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "memories_user_memory_of_agent_id_idx" ON "memories"("user_memory_of_agent_id");
CREATE INDEX IF NOT EXISTS "memories_anonymous_expires_at_idx" ON "memories"("anonymous_expires_at");

ALTER TABLE "memories"
  ADD CONSTRAINT "memories_user_memory_of_agent_id_fkey"
  FOREIGN KEY ("user_memory_of_agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Agent type + surfaces ──────────────────────────────────────────

ALTER TABLE "agents"
  ADD COLUMN IF NOT EXISTS "type" "AgentType" NOT NULL DEFAULT 'ASSISTANT',
  ADD COLUMN IF NOT EXISTS "surfaces" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Migration: existing agents with systemMemoryId are chatbots; give portal-chat surface
UPDATE "agents" SET "type" = 'CHATBOT' WHERE "system_memory_id" IS NOT NULL AND "type" = 'ASSISTANT';
UPDATE "agents" SET "surfaces" = ARRAY['portal-chat'] WHERE "surfaces" = ARRAY[]::TEXT[];
