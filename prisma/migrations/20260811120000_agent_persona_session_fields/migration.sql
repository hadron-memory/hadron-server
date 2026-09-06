-- #928 — team-persona phase 1 (hadron-concept 2026-08-11-agent-personas).
--
-- persona_name / persona_role / persona_prompt: a persona — a named AI team
--   member ("Iris") driven by external coding sessions or portal chat — IS an
--   Agent. Pure metadata: no server behavior forks on these columns.
-- transcript_path / host / tool: coding-session provenance on Session — where
--   the driving tool's transcript lives, on which machine, and which tool
--   drove it (the existing DEVELOPER session type covers coding sessions;
--   repo/branch/pr_number already exist).

ALTER TABLE "agents" ADD COLUMN "persona_name" TEXT;
ALTER TABLE "agents" ADD COLUMN "persona_role" TEXT;
ALTER TABLE "agents" ADD COLUMN "persona_prompt" TEXT;

ALTER TABLE "sessions" ADD COLUMN "transcript_path" TEXT;
ALTER TABLE "sessions" ADD COLUMN "host" TEXT;
ALTER TABLE "sessions" ADD COLUMN "tool" TEXT;

-- Persona names are unique per owner (org XOR user — chk_agent_owner_xor),
-- case-insensitively. Partial functional uniques, so they live here and in
-- post-push.sql (Prisma cannot express them). Deliberately NOT filtered on
-- deleted_at: a persona name binds to one agent forever (PR trailers and chat
-- history reference it — D-2026-08-11-006), so a soft-deleted agent keeps its
-- name reserved.
CREATE UNIQUE INDEX "agents_org_persona_name_uniq"
  ON "agents" ("organization_id", lower("persona_name"))
  WHERE "persona_name" IS NOT NULL AND "organization_id" IS NOT NULL;
CREATE UNIQUE INDEX "agents_owner_persona_name_uniq"
  ON "agents" ("owner_user_id", lower("persona_name"))
  WHERE "persona_name" IS NOT NULL AND "owner_user_id" IS NOT NULL;
