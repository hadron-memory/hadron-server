-- Phase 1 of the Station -> App migration (003-station-to-app).
-- Additive only: no Station tables modified, no existing App rows invalidated.
--
-- Adds:
--   * Three new enums: AppMembershipRole, AppType, AppAgentRole.
--   * Nine fields absorbed from Station onto App (skipping keyHash,
--     apiKeyShown, lastUsedAt — those duplicate AppKey semantics).
--   * Three fields onto AppAgent: role (per Constitution Invariant #6),
--     subscriptionType + trainingMode (1:1 carry from
--     StationAgentSubscription, deferred resolution per spec Q1).
--   * Standard audit + soft-delete fields onto AppAgent (project convention).
--   * New app_log table mirroring station_log (without soft-delete columns —
--     log entries are append-only).
--
-- Idempotent: every statement uses IF NOT EXISTS (or the equivalent
-- DO/EXCEPTION block for enum types, which Postgres doesn't support
-- IF NOT EXISTS on for CREATE TYPE).
--
-- Per the spec, no data backfill: any existing App rows simply pick up the
-- column defaults; existing AppAgent rows pick up role=OPERATE,
-- subscriptionType=READ_ONLY, trainingMode=false.

-- CreateEnum (Postgres doesn't support CREATE TYPE IF NOT EXISTS; emulate it).
DO $$ BEGIN
    CREATE TYPE "AppMembershipRole" AS ENUM ('OWNER', 'ADMIN', 'CONTRIBUTOR', 'READER');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE "AppType" AS ENUM ('WORKSTATION', 'CHATBOT', 'AGENT', 'AUTOMATION', 'CLOUD', 'IOT');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE "AppAgentRole" AS ENUM ('OPERATE', 'DEVELOP');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AlterTable: absorb Station fields onto App.
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "app_type" "AppType" NOT NULL DEFAULT 'WORKSTATION';
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "role" "AppMembershipRole" NOT NULL DEFAULT 'READER';
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "description" TEXT;
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "system_prompt" TEXT;
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "agent_tools" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "ai_provider" TEXT;
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "ai_model" TEXT;
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "ai_api_key_encrypted" TEXT;
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "expires_at" TIMESTAMP(3);

-- AlterTable: absorb StationAgentSubscription fields + add Invariant #6 role onto AppAgent.
ALTER TABLE "app_agents" ADD COLUMN IF NOT EXISTS "role" "AppAgentRole" NOT NULL DEFAULT 'OPERATE';
ALTER TABLE "app_agents" ADD COLUMN IF NOT EXISTS "subscription_type" "SubscriptionType" NOT NULL DEFAULT 'READ_ONLY';
ALTER TABLE "app_agents" ADD COLUMN IF NOT EXISTS "training_mode" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable: standard audit + soft-delete fields on AppAgent (project convention).
ALTER TABLE "app_agents" ADD COLUMN IF NOT EXISTS "created_by" TEXT;
ALTER TABLE "app_agents" ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP(3);
ALTER TABLE "app_agents" ADD COLUMN IF NOT EXISTS "updated_by" TEXT;
ALTER TABLE "app_agents" ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP(3);
ALTER TABLE "app_agents" ADD COLUMN IF NOT EXISTS "deleted_by" TEXT;

-- CreateTable: app_log mirrors station_log (renamed `station_id` -> `app_id`,
-- FK retargeted, soft-delete columns omitted — log entries are append-only).
CREATE TABLE IF NOT EXISTS "app_log" (
    "id" TEXT NOT NULL,
    "app_id" TEXT NOT NULL,
    "level" "LogLevel" NOT NULL,
    "memory_id" TEXT,
    "session_id" TEXT,
    "message" TEXT NOT NULL,
    "detail" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3),
    "updated_by" TEXT,

    CONSTRAINT "app_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "app_log_app_id_idx" ON "app_log"("app_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "app_log_app_id_created_at_idx" ON "app_log"("app_id", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "app_log_level_idx" ON "app_log"("level");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "app_log_created_at_idx" ON "app_log"("created_at");

-- AddForeignKey (Postgres doesn't support IF NOT EXISTS on ADD CONSTRAINT;
-- emulate idempotence via the same DO/EXCEPTION pattern used for enums).
DO $$ BEGIN
    ALTER TABLE "app_log" ADD CONSTRAINT "app_log_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
