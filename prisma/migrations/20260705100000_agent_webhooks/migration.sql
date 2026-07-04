-- Spec 040 Day 3 — AgentWebhook trigger table (D-2026-05-02 shape; plan §8).
-- Derived via prisma migrate diff (direct binary — no pnpm preamble, see
-- findings:pnpm11-preamble-pollutes-ci-capture) with the known phantom-drift
-- artifacts stripped (findings:prisma-dev-db-phantom-drift).

-- CreateTable
CREATE TABLE "agent_webhooks" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "app_id" TEXT NOT NULL,
    "agent_id" TEXT,
    "user_id" TEXT,
    "name" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "args_schema" JSONB,
    "entry_node_urn" TEXT NOT NULL,
    "event_data" JSONB,
    "policy" JSONB,
    "ai_config_name" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_called_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3),
    "updated_by" TEXT,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" TEXT,

    CONSTRAINT "agent_webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_webhooks_secret_key" ON "agent_webhooks"("secret");

-- CreateIndex
CREATE INDEX "agent_webhooks_app_id_deleted_at_idx" ON "agent_webhooks"("app_id", "deleted_at");

