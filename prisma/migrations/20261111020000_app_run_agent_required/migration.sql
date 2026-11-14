-- #3689 (cor:agt:010:01 rev 45): every run names an existing Agent.
--
-- 1. The data transition. The DO block is DUPLICATED VERBATIM from prisma/app-run-agent-pre-push.sql (which
--    push-synced dev/test databases run before `prisma db push`); change one, change the other. It fills a run with no
--    Agent from its App's only live ROW-installed Agent and deletes the rest (gate R3/R5), raising SQLSTATE HDPRF if a
--    child table refuses the delete.
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

-- 2. The guarantee: NOT NULL, and a foreign key to agents with its own leading index (#451). ON DELETE CASCADE
--    (gate R4): an Agent hard delete removes its runs; served_prompts' guard admits exactly that owner cascade.
ALTER TABLE "app_runs" ALTER COLUMN "agent_id" SET NOT NULL;

CREATE INDEX "app_runs_agent_id_idx" ON "app_runs"("agent_id");

ALTER TABLE "app_runs" ADD CONSTRAINT "app_runs_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
