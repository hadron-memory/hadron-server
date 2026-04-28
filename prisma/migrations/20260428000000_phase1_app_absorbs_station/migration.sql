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
--   * New app_log table mirroring station_log.
--
-- Per the spec, no data backfill: any existing App rows simply pick up the
-- column defaults; existing AppAgent rows pick up role=OPERATE,
-- subscriptionType=READ_ONLY, trainingMode=false.

-- CreateEnum
CREATE TYPE "AppMembershipRole" AS ENUM ('OWNER', 'ADMIN', 'CONTRIBUTOR', 'READER');

-- CreateEnum
CREATE TYPE "AppType" AS ENUM ('WORKSTATION', 'CHATBOT', 'AGENT', 'AUTOMATION', 'CLOUD', 'IOT');

-- CreateEnum
CREATE TYPE "AppAgentRole" AS ENUM ('OPERATE', 'DEVELOP');

-- AlterTable: absorb Station fields onto App.
ALTER TABLE "apps" ADD COLUMN "app_type" "AppType" NOT NULL DEFAULT 'WORKSTATION';
ALTER TABLE "apps" ADD COLUMN "role" "AppMembershipRole" NOT NULL DEFAULT 'READER';
ALTER TABLE "apps" ADD COLUMN "description" TEXT;
ALTER TABLE "apps" ADD COLUMN "system_prompt" TEXT;
ALTER TABLE "apps" ADD COLUMN "agent_tools" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "apps" ADD COLUMN "ai_provider" TEXT;
ALTER TABLE "apps" ADD COLUMN "ai_model" TEXT;
ALTER TABLE "apps" ADD COLUMN "ai_api_key_encrypted" TEXT;
ALTER TABLE "apps" ADD COLUMN "expires_at" TIMESTAMP(3);

-- AlterTable: absorb StationAgentSubscription fields + add Invariant #6 role onto AppAgent.
ALTER TABLE "app_agents" ADD COLUMN "role" "AppAgentRole" NOT NULL DEFAULT 'OPERATE';
ALTER TABLE "app_agents" ADD COLUMN "subscription_type" "SubscriptionType" NOT NULL DEFAULT 'READ_ONLY';
ALTER TABLE "app_agents" ADD COLUMN "training_mode" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable: app_log mirrors station_log (renamed `station_id` -> `app_id`, FK retargeted).
CREATE TABLE "app_log" (
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
    "deleted_at" TIMESTAMP(3),
    "deleted_by" TEXT,

    CONSTRAINT "app_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "app_log_app_id_idx" ON "app_log"("app_id");

-- CreateIndex
CREATE INDEX "app_log_app_id_created_at_idx" ON "app_log"("app_id", "created_at");

-- CreateIndex
CREATE INDEX "app_log_level_idx" ON "app_log"("level");

-- CreateIndex
CREATE INDEX "app_log_created_at_idx" ON "app_log"("created_at");

-- AddForeignKey
ALTER TABLE "app_log" ADD CONSTRAINT "app_log_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;
