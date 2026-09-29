-- D-2026-09-14-001, #1241 pass one: keep the authored text byte-for-byte.
-- Persona text historically headed the Worker briefing; when both fields
-- exist, retain that order with the same paragraph separator used elsewhere.
UPDATE "agents"
SET "system_prompt" = CASE
  WHEN "persona_prompt" IS NULL THEN "system_prompt"
  WHEN "system_prompt" IS NULL THEN "persona_prompt"
  ELSE "persona_prompt" || E'\n\n' || "system_prompt"
END
WHERE "persona_prompt" IS NOT NULL;

ALTER TABLE "agents" DROP COLUMN "persona_prompt";
