-- Spec 040 — headless agent runs (plan: specs/040-headless-runs/plan.md).
-- AppRun (run record = v1 activation, cor:agt:010:02), AgentSchedule
-- (per-kind trigger, D-2026-07-04-E), QuotaCounter + ActionTicket (two-tier
-- quotas, cor:acl:050:01/:04).
-- Hand-derived from `prisma migrate diff` with the known phantom-drift
-- artifacts (HNSW / tsv raw-SQL objects) stripped — see
-- findings:prisma-dev-db-phantom-drift.

Already up to date
Done in 254ms using pnpm v11.5.2
Already up to date
Done in 218ms using pnpm v11.5.2
-- CreateEnum
CREATE TYPE "AppRunStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AppRunTriggerKind" AS ENUM ('SCHEDULE', 'WEBHOOK', 'MANUAL', 'INTEGRATION');

-- CreateTable
CREATE TABLE "app_runs" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "app_id" TEXT NOT NULL,
    "agent_id" TEXT,
    "user_id" TEXT,
    "trigger_kind" "AppRunTriggerKind" NOT NULL,
    "trigger_id" TEXT,
    "entry_node_urn" TEXT NOT NULL,
    "event_data" JSONB,
    "policy" JSONB,
    "budget_tokens" INTEGER,
    "budget_actions" INTEGER,
    "status" "AppRunStatus" NOT NULL DEFAULT 'PENDING',
    "cur_node_urn" TEXT,
    "parent_run_id" TEXT,
    "failure" JSONB,
    "timeout_ms" INTEGER,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "published_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,

    CONSTRAINT "app_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_schedules" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "app_id" TEXT NOT NULL,
    "agent_id" TEXT,
    "user_id" TEXT,
    "name" TEXT NOT NULL,
    "cron" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "entry_node_urn" TEXT NOT NULL,
    "event_data" JSONB,
    "policy" JSONB,
    "ai_config_name" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_run_at" TIMESTAMP(3),
    "next_run_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3),
    "updated_by" TEXT,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" TEXT,

    CONSTRAINT "agent_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quota_counters" (
    "id" TEXT NOT NULL,
    "scope_kind" TEXT NOT NULL,
    "scope_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "window" TEXT NOT NULL,
    "used" INTEGER NOT NULL DEFAULT 0,
    "limit" INTEGER NOT NULL,
    "reset_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quota_counters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "action_tickets" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "app_id" TEXT,
    "action" TEXT NOT NULL,
    "minted_by" TEXT NOT NULL,
    "note" TEXT,
    "consumed_by_run_id" TEXT,
    "consumed_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "action_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "app_runs_status_published_at_idx" ON "app_runs"("status", "published_at");

-- CreateIndex
CREATE INDEX "app_runs_app_id_created_at_idx" ON "app_runs"("app_id", "created_at");

-- CreateIndex
CREATE INDEX "app_runs_trigger_id_status_idx" ON "app_runs"("trigger_id", "status");

-- CreateIndex
CREATE INDEX "app_runs_organization_id_created_at_idx" ON "app_runs"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "agent_schedules_enabled_next_run_at_idx" ON "agent_schedules"("enabled", "next_run_at");

-- CreateIndex
CREATE INDEX "agent_schedules_app_id_deleted_at_idx" ON "agent_schedules"("app_id", "deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "quota_counters_scope_kind_scope_id_action_window_key" ON "quota_counters"("scope_kind", "scope_id", "action", "window");

-- CreateIndex
CREATE INDEX "action_tickets_organization_id_action_consumed_at_idx" ON "action_tickets"("organization_id", "action", "consumed_at");

