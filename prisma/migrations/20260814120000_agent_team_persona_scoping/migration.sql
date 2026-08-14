-- #974 — persona scoping: team-bound personas, team-scoped names, derived
-- dot-compound slugs. Specs cor:agt:020:01 (v0.0.2), cor:agt:020:02 (v0.0.2),
-- cor:agt:020:06, cor:urn:010:03; design of record hadron-concept
-- design-discussions/hadron-platform/2026-08-14-agent-persona-scoping
-- (D-2026-08-14-001…003).
--
-- Supersedes the owner-wide persona-name scope shipped in 20260811120000:
-- team App A minting "Iris" must not block team App B from having one.

-- ── Guard 1: the dot reservation (cor:urn:010:03) ───────────────────────────
-- The validation this migration unblocks forbids `.` in user-supplied agent
-- and App slugs, so that a dotted slug can only ever be a server-derived
-- persona compound. Assert the existing population already satisfies it —
-- a pre-existing dotted slug would be indistinguishable from a persona
-- compound and would break the collision-freedom argument. The slug is
-- everything after the FIRST colon (an owner atom — a dotted org root or a
-- dot-free handle — never contains one).
DO $$
DECLARE
  offending TEXT;
BEGIN
  SELECT string_agg(urn, ', ') INTO offending
    FROM agents WHERE substr(urn, position(':' IN urn) + 1) LIKE '%.%';
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION
      'cor:urn:010:03 guard: agent slug(s) already contain "." — the dot is reserved for server-derived persona slugs. Rename before migrating: %', offending;
  END IF;
  SELECT string_agg(urn, ', ') INTO offending
    FROM apps WHERE substr(urn, position(':' IN urn) + 1) LIKE '%.%';
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION
      'cor:urn:010:03 guard: App slug(s) already contain "." — the dot is reserved for server-derived persona slugs. Rename before migrating: %', offending;
  END IF;
END $$;

-- ── Agent.teamAppId — the persona's required home team App ──────────────────
ALTER TABLE "agents" ADD COLUMN "team_app_id" TEXT;

ALTER TABLE "agents"
  ADD CONSTRAINT "agents_team_app_id_fkey"
  FOREIGN KEY ("team_app_id") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "agents_team_app_id_idx" ON "agents"("team_app_id");

-- Backfill from the roster join: every persona minted by createTeamPersona was
-- installed into its team App in the same call, so the AppAgent row IS the
-- team binding. Oldest join wins if a persona was later installed elsewhere
-- (pre-#974 there was nothing stopping that).
UPDATE "agents" a
   SET "team_app_id" = (
     SELECT aa."app_id" FROM "app_agents" aa
      WHERE aa."agent_id" = a."id"
      ORDER BY aa."created_at" ASC
      LIMIT 1
   )
 WHERE a."persona_name" IS NOT NULL;

-- ── Guard 2: no team-less persona survives the backfill ─────────────────────
-- Loud, not silent: nulling `persona_name` would release a permanent name
-- reservation (cor:agt:020:02), and guessing a team App is worse. Verified
-- clean on prod before this shipped (every persona had exactly one AppAgent).
DO $$
DECLARE
  orphans TEXT;
BEGIN
  SELECT string_agg(urn, ', ') INTO orphans
    FROM agents WHERE persona_name IS NOT NULL AND team_app_id IS NULL;
  IF orphans IS NOT NULL THEN
    RAISE EXCEPTION
      'cor:agt:020:01 backfill: persona agent(s) belong to no App, so their team App cannot be derived. Install them into their team App, or clear their persona fields, then re-run: %', orphans;
  END IF;
END $$;

-- The team-boundness invariant (cor:agt:020:01). One direction only: a
-- non-persona Agent may carry a team_app_id (it never does today), and a
-- persona may never be team-less.
ALTER TABLE "agents" DROP CONSTRAINT IF EXISTS "chk_agent_persona_team_app";
ALTER TABLE "agents"
  ADD CONSTRAINT "chk_agent_persona_team_app"
  CHECK ("persona_name" IS NULL OR "team_app_id" IS NOT NULL);

-- ── Re-scope the persona-name uniqueness (cor:agt:020:02 v0.0.2) ────────────
-- ONE index replaces the owner-wide pair: `team_app_id` determines the owner
-- (the persona is owned by its team App's owner), so (team App, name) IS the
-- spec's (owner, team App) scope. Still NOT filtered on deleted_at — a
-- soft-deleted persona, and a soft-deleted team App, keep the name reserved.
DROP INDEX IF EXISTS "agents_org_persona_name_uniq";
DROP INDEX IF EXISTS "agents_owner_persona_name_uniq";

CREATE UNIQUE INDEX "agents_team_persona_name_uniq"
  ON "agents" ("team_app_id", lower("persona_name"))
  WHERE "persona_name" IS NOT NULL;
