-- 008-agent-installation: best-effort rollback.
--
-- KNOWN LIMITATION: AppAgent data is unrecoverable from the up migration —
-- only role='DEVELOP' rows were logged via NOTICE; OPERATE rows were folded
-- into App.agent_id without preserving the AppAgent row itself. If a rollback
-- is required, restore app_agents from a pre-migration backup (per quickstart
-- O-3). This down script reverses schema changes only; it does not restore
-- data.

BEGIN;

-- Reverse the CHECK constraint
ALTER TABLE "memories" DROP CONSTRAINT IF EXISTS "chk_memory_class_app_id";

-- Re-create app_agents (data is unrecoverable — operator must restore from backup)
CREATE TYPE "AppAgentRole" AS ENUM ('OPERATE', 'DEVELOP');

CREATE TABLE "app_agents" (
  "app_id"        TEXT NOT NULL,
  "agent_id"      TEXT NOT NULL,
  "role"          "AppAgentRole" NOT NULL DEFAULT 'OPERATE',
  "training_mode" BOOLEAN NOT NULL DEFAULT FALSE,
  "created_at"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "created_by"    TEXT,
  "updated_at"    TIMESTAMPTZ,
  "updated_by"    TEXT,
  "deleted_at"    TIMESTAMPTZ,
  "deleted_by"    TEXT,
  PRIMARY KEY ("app_id", "agent_id"),
  CONSTRAINT "app_agents_app_id_fkey"   FOREIGN KEY ("app_id")   REFERENCES "apps"   ("id") ON DELETE CASCADE,
  CONSTRAINT "app_agents_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents" ("id") ON DELETE CASCADE
);

CREATE INDEX "app_agents_agent_id_idx" ON "app_agents" ("agent_id");

-- Drop new columns (memories.app_id, apps.surfaces/training_mode/agent_id, agents.installation_policy/memory_provisioning)
DROP INDEX IF EXISTS "memories_app_id_idx";
ALTER TABLE "memories" DROP COLUMN IF EXISTS "app_id";

DROP INDEX IF EXISTS "apps_agent_id_idx";
ALTER TABLE "apps" DROP CONSTRAINT IF EXISTS "apps_agent_id_fkey";
ALTER TABLE "apps" DROP COLUMN IF EXISTS "surfaces";
ALTER TABLE "apps" DROP COLUMN IF EXISTS "training_mode";
ALTER TABLE "apps" DROP COLUMN IF EXISTS "agent_id";

ALTER TABLE "agents" DROP COLUMN IF EXISTS "installation_policy";
ALTER TABLE "agents" DROP COLUMN IF EXISTS "memory_provisioning";

-- Drop new tables
DROP TABLE IF EXISTS "agent_imports";
DROP TABLE IF EXISTS "agent_org_grants";
DROP TABLE IF EXISTS "app_members";

COMMIT;
