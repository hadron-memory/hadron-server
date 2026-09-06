-- #974 (first cut, SUPERSEDED SAME DAY) — team-bound personas. The design was
-- replaced by the Worker model (D-2026-08-14-004/-005/-006) before any
-- deployment depended on it; the follow-up migration 20260814130000_worker_model
-- drops everything this one adds.
--
-- ── Edited 2026-08-14 with the #974 re-cut (PR #978 review — codex P1) ──────
-- The original file (see git history) opened with two RAISE EXCEPTION guards:
-- the cor:urn:010:03 dot-slug reservation (RESCINDED — dotted slugs are legal
-- again, and a pre-existing one would have made an otherwise valid database
-- undeployable, blocked by a rule that no longer exists) and the
-- persona-orphan backfill guard (pointless — persona_name is dropped by the
-- next migration either way). It also created the team-scoped name unique and
-- the chk_agent_persona_team_app CHECK, both of which could likewise refuse on
-- data the rescinded model cared about and the Worker model does not.
--
-- Editing an APPLIED migration is safe here because `prisma migrate deploy`
-- skips applied migrations by NAME without checksum verification (verified
-- empirically), and any deployment that carries this edited file also carries
-- 20260814130000, whose guarded IF EXISTS drops converge every path — a
-- database that ran the ORIGINAL file and one that runs this reduced file end
-- up byte-identical after the chain completes. Only the structural pieces the
-- next migration expects to drop are kept.

-- Agent.team_app_id — dropped again by 20260814130000.
ALTER TABLE "agents" ADD COLUMN "team_app_id" TEXT;

ALTER TABLE "agents"
  ADD CONSTRAINT "agents_team_app_id_fkey"
  FOREIGN KEY ("team_app_id") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "agents_team_app_id_idx" ON "agents"("team_app_id");

-- Retire the #928 owner-wide persona-name uniques (also re-dropped IF EXISTS
-- by 20260814130000, so order is immaterial).
DROP INDEX IF EXISTS "agents_org_persona_name_uniq";
DROP INDEX IF EXISTS "agents_owner_persona_name_uniq";
