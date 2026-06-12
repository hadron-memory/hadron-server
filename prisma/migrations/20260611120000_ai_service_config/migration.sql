-- 036-ai-service-config: named AI service configuration registry.
--
-- Why this migration exists:
--   AI provider/model/key settings move from ad-hoc columns on agents/apps
--   into one registry table, ai_service_configs, owned by exactly one of
--   HadronServer / Organization / App / Agent and resolved by name walking
--   App -> Agent -> Org (of the App) -> HadronServer (first enabled hit
--   wins; well-known fallback name 'default'). This is the prerequisite
--   for headless LLM use and the portal chatbot (spec 036).
--
-- DELIBERATE DATA DROP — NO BACKFILL:
--   The legacy agents.ai_* / apps.ai_* columns are dropped WITHOUT
--   migrating their values. Confirmed disposable 2026-06-11 (Holger):
--   "None of the existing AI configuration need to survive. We can
--   manually fill them back in. Nothing in production depends on it."
--   After deploy, operators re-enter keys via the portal (the legacy
--   GraphQL operations stay, registry-backed) or createAiServiceConfig.
--
-- Constraint sync rule: chk_ai_service_config_owner and the four partial
-- unique indexes below are duplicated in prisma/post-push.sql and
-- src/test/globalSetup.ts (db-push-managed DBs don't replay migrations).
-- All three sites MUST stay in sync; CHECKs use DROP+ADD, never
-- IF NOT EXISTS.

CREATE TABLE "ai_service_configs" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hadron_server_id" TEXT,
    "organization_id" TEXT,
    "app_id" TEXT,
    "agent_id" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "api_key_encrypted" TEXT,
    "api_key_preview" TEXT,
    "params" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3),
    "updated_by" TEXT,

    CONSTRAINT "ai_service_configs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ai_service_configs_hadron_server_id_idx" ON "ai_service_configs"("hadron_server_id");
CREATE INDEX "ai_service_configs_organization_id_idx" ON "ai_service_configs"("organization_id");
CREATE INDEX "ai_service_configs_app_id_idx" ON "ai_service_configs"("app_id");
CREATE INDEX "ai_service_configs_agent_id_idx" ON "ai_service_configs"("agent_id");

ALTER TABLE "ai_service_configs" ADD CONSTRAINT "ai_service_configs_hadron_server_id_fkey"
  FOREIGN KEY ("hadron_server_id") REFERENCES "hadron_server"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_service_configs" ADD CONSTRAINT "ai_service_configs_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_service_configs" ADD CONSTRAINT "ai_service_configs_app_id_fkey"
  FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_service_configs" ADD CONSTRAINT "ai_service_configs_agent_id_fkey"
  FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Exactly one owner (synced: post-push.sql, globalSetup.ts).
ALTER TABLE "ai_service_configs"
  DROP CONSTRAINT IF EXISTS "chk_ai_service_config_owner";
ALTER TABLE "ai_service_configs"
  ADD CONSTRAINT "chk_ai_service_config_owner"
  CHECK (num_nonnulls(hadron_server_id, organization_id, app_id, agent_id) = 1);

-- Per-owner name uniqueness (synced: post-push.sql, globalSetup.ts).
CREATE UNIQUE INDEX "ai_service_configs_server_name_uniq"
  ON "ai_service_configs" ("hadron_server_id", "name") WHERE "hadron_server_id" IS NOT NULL;
CREATE UNIQUE INDEX "ai_service_configs_org_name_uniq"
  ON "ai_service_configs" ("organization_id", "name") WHERE "organization_id" IS NOT NULL;
CREATE UNIQUE INDEX "ai_service_configs_app_name_uniq"
  ON "ai_service_configs" ("app_id", "name") WHERE "app_id" IS NOT NULL;
CREATE UNIQUE INDEX "ai_service_configs_agent_name_uniq"
  ON "ai_service_configs" ("agent_id", "name") WHERE "agent_id" IS NOT NULL;

-- Drop the superseded legacy columns (no backfill — see header).
ALTER TABLE "agents"
  DROP COLUMN IF EXISTS "ai_provider",
  DROP COLUMN IF EXISTS "ai_model",
  DROP COLUMN IF EXISTS "ai_api_key_encrypted",
  DROP COLUMN IF EXISTS "ai_api_key_preview";
ALTER TABLE "apps"
  DROP COLUMN IF EXISTS "ai_provider",
  DROP COLUMN IF EXISTS "ai_model",
  DROP COLUMN IF EXISTS "ai_api_key_encrypted";
