-- #2044 (S7), cor:agt:040:06 — an App's INSTALL MEMORY: the per-(App, Agent)
-- class='system' memory that holds the App's customisation of an installed
-- Agent. Identity is by COLUMNS (install_of_agent_id + the existing app_id),
-- never by URN, mirroring #723's shared-memory key.
--
-- Additive: no existing row changes. Every current class='system' row has
-- app_id IS NULL and (now) install_of_agent_id IS NULL, which satisfies the
-- second arm of the replaced CHECK. No backfill. Also lives in
-- prisma/post-push.sql and src/test/globalSetup.ts (keep all three in sync).
ALTER TABLE "memories" ADD COLUMN "install_of_agent_id" TEXT;
ALTER TABLE "memories" ADD COLUMN "is_install_memory" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "memories"
  ADD CONSTRAINT "memories_install_of_agent_id_fkey"
  FOREIGN KEY ("install_of_agent_id") REFERENCES "agents"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "memories_install_of_agent_id_idx" ON "memories"("install_of_agent_id");

ALTER TABLE "memories" DROP CONSTRAINT IF EXISTS "chk_memory_class_app_id";
ALTER TABLE "memories"
  ADD CONSTRAINT "chk_memory_class_app_id"
  CHECK (
    (class = 'app' AND app_id IS NOT NULL AND install_of_agent_id IS NULL AND is_install_memory = false)
    OR (class = 'system' AND app_id IS NULL AND install_of_agent_id IS NULL AND is_install_memory = false)
    OR (class = 'system' AND app_id IS NOT NULL AND is_install_memory = true)
    OR (class IN ('knowledge', 'group', 'personal', 'private') AND install_of_agent_id IS NULL AND is_install_memory = false)
  );

-- ONE live install memory per (App, Agent). Soft-deleted rows do not hold the
-- slot (an authorised manual delete, R45, must free the pair). NULL
-- install_of_agent_id rows are unconstrained.
CREATE UNIQUE INDEX "memories_install_memory_live_uniq"
  ON "memories" ("app_id", "install_of_agent_id")
  WHERE "install_of_agent_id" IS NOT NULL AND "deleted_at" IS NULL;
