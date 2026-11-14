-- #3689 (cor:agt:010:01 rev 45): every run names an existing Agent, so app_runs.agent_id becomes NOT NULL with a
-- foreign key to agents. Existing runs are test rows only (ruling 0248 row 8, Holger 2026-11-07: "we have zero
-- production runs, just a handful of tests"): a run with no Agent takes its App's only installed Agent, and every run
-- that still names none, or names an Agent row that does not exist, is deleted with its cascading children.
--
-- "Installed" here is a ROW install (app_agents) whose Agent is live (deleted_at IS NULL); installs derived through
-- agent_imports are not counted (gate R5: under-counting only errs toward the ruled delete branch).
--
-- The DO block below is DUPLICATED VERBATIM in prisma/migrations/20261111020000_app_run_agent_required/migration.sql
-- (pinned by src/test/integration/3689-apprun-agent-required.test.ts). Change one, change the other. It guards on the
-- column still being nullable, so it is a no-op on a fresh database, on a migrated one, and on a second run. A child
-- table that refuses the delete stops the transition with SQLSTATE HDPRF (CLAUDE.md, #3770) instead of guessing.
DO $$
DECLARE
  filled  INTEGER := 0;
  deleted INTEGER := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'app_runs'
      AND column_name = 'agent_id' AND is_nullable = 'YES'
  ) THEN
    RETURN;
  END IF;

  WITH only_install AS (
    SELECT aa.app_id, min(aa.agent_id) AS agent_id
    FROM app_agents aa
    JOIN agents a ON a.id = aa.agent_id AND a.deleted_at IS NULL
    GROUP BY aa.app_id
    HAVING count(*) = 1
  )
  UPDATE app_runs r SET agent_id = oi.agent_id
  FROM only_install oi
  WHERE r.agent_id IS NULL AND r.app_id = oi.app_id;
  GET DIAGNOSTICS filled = ROW_COUNT;

  BEGIN
    DELETE FROM app_runs r
    WHERE r.agent_id IS NULL
       OR NOT EXISTS (SELECT 1 FROM agents a WHERE a.id = r.agent_id);
    GET DIAGNOSTICS deleted = ROW_COUNT;
  EXCEPTION WHEN raise_exception OR restrict_violation OR foreign_key_violation THEN
    RAISE EXCEPTION 'app_runs agent backfill: a child table refused deleting run(s): %', SQLERRM
      USING ERRCODE = 'HDPRF';
  END;

  RAISE NOTICE 'app_runs agent backfill: % run(s) filled from their App''s only installed Agent, % run(s) deleted', filled, deleted;
END $$;
