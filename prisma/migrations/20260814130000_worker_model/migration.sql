-- #974 (re-cut) — the Worker model: persona = Agent dressing, Worker = named
-- casting. Specs cor:dmo:050:11, cor:agt:020 v0.0.3 (020:01/020:02/020:03
-- v0.0.3; 020:06 and cor:urn:010:03 rescinded); design of record
-- hadron-concept design-discussions/hadron-platform/2026-08-14-agent-persona-scoping
-- (D-2026-08-14-004/-005/-006, superseding D-2026-08-14-001…003).
--
-- FORWARD-FIX, not a revert: this migration both ADDS the Worker entity and
-- DROPS everything the superseded persona-as-agent cuts shipped —
-- 20260814120000's `team_app_id` + team-scoped name unique + CHECK, and
-- 20260811120000's `persona_name` + owner-wide name uniques — so it converges
-- fresh databases (which replay the whole chain), #975-migrated dev
-- databases, and the remote host onto the same shape. Every drop is guarded
-- IF EXISTS for exactly that reason. `persona_role` / `persona_prompt` stay:
-- they are the universal dressing (cor:agt:020:01).
--
-- No data backfill: the feature has no production users, and dev-fixture
-- personas (Iris/Rufus) are recreated as castings (issue #974).

-- ── The Worker table (cor:dmo:050:11) ───────────────────────────────────────
-- Workers RETIRE (`retired_at`), never soft-delete — no `deleted_at`. The
-- agent FK is RESTRICT (a referenced casting must never lose its agent
-- silently); the App FK cascades (hard App deletion takes its staff with it);
-- the memory FK is SET NULL (losing the working memory never destroys the
-- casting or its name reservation).
CREATE TABLE "workers" (
  "id"              TEXT NOT NULL,
  "app_id"          TEXT NOT NULL,
  "agent_id"        TEXT NOT NULL,
  "name"            TEXT NOT NULL,
  "role"            TEXT,
  "prompt_override" TEXT,
  "memory_id"       TEXT,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by"      TEXT,
  "updated_at"      TIMESTAMP(3),
  "updated_by"      TEXT,
  "retired_at"      TIMESTAMP(3),
  "retired_by"      TEXT,

  CONSTRAINT "workers_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "workers"
  ADD CONSTRAINT "workers_app_id_fkey"
  FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workers"
  ADD CONSTRAINT "workers_agent_id_fkey"
  FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "workers"
  ADD CONSTRAINT "workers_memory_id_fkey"
  FOREIGN KEY ("memory_id") REFERENCES "memories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "workers_app_id_idx" ON "workers"("app_id");
CREATE INDEX "workers_agent_id_idx" ON "workers"("agent_id");

-- Name unique per App, case-insensitively (cor:agt:020:02). A functional
-- unique, so it lives here and in post-push.sql (Prisma cannot express it).
-- Deliberately NOT filtered on retirement: a name binds to one casting
-- forever — PR trailers and chat archives reference it, and a recycled name
-- would silently re-attribute old work. Rows survive agent uninstall.
CREATE UNIQUE INDEX "workers_app_name_uniq"
  ON "workers" ("app_id", lower("name"));

-- ── Session.worker_id — the named identity (cor:agt:020:03) ─────────────────
-- `agent_id` keeps recording the role-agent; SET NULL so a (never-expected)
-- worker hard-delete cannot take sessions with it.
ALTER TABLE "sessions" ADD COLUMN "worker_id" TEXT;
ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_worker_id_fkey"
  FOREIGN KEY ("worker_id") REFERENCES "workers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "sessions_worker_id_idx" ON "sessions"("worker_id");

-- ── Drop the persona-as-agent name machinery ────────────────────────────────
-- #975's team scoping (team_app_id + team-scoped unique + CHECK) …
DROP INDEX IF EXISTS "agents_team_persona_name_uniq";
ALTER TABLE "agents" DROP CONSTRAINT IF EXISTS "chk_agent_persona_team_app";
DROP INDEX IF EXISTS "agents_team_app_id_idx";
ALTER TABLE "agents" DROP CONSTRAINT IF EXISTS "agents_team_app_id_fkey";
ALTER TABLE "agents" DROP COLUMN IF EXISTS "team_app_id";

-- … and #928's name column with its owner-wide uniques (already dropped on a
-- #975-migrated database — hence IF EXISTS).
DROP INDEX IF EXISTS "agents_org_persona_name_uniq";
DROP INDEX IF EXISTS "agents_owner_persona_name_uniq";
ALTER TABLE "agents" DROP COLUMN IF EXISTS "persona_name";
