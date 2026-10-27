-- #2553 (Task Management T12): the per-App task number behind the handle AT<n>.
-- Order: (a) counter table + nullable column, (b) backfill per App by created_at, id and set each
-- counter to the App's count, then the invariants file below (the NOT NULL, the number-filling
-- trigger and the permanence trigger), then (c) the unique. A re-run is a no-op: only NULL rows are
-- numbered and the counter only moves up. The invariants block is a byte-identical copy of
-- prisma/agent-task-number-invariants.sql (pinned by src/lib/agentTasks/taskNumber2553.test.ts).

CREATE TABLE IF NOT EXISTS "agent_task_counters" (
  "app_id" TEXT NOT NULL,
  "last_number" BIGINT NOT NULL,
  CONSTRAINT "agent_task_counters_pkey" PRIMARY KEY ("app_id")
);
ALTER TABLE "agent_task_counters" DROP CONSTRAINT IF EXISTS "agent_task_counters_app_id_fkey";
ALTER TABLE "agent_task_counters" ADD CONSTRAINT "agent_task_counters_app_id_fkey"
  FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_tasks" ADD COLUMN IF NOT EXISTS "task_number" BIGINT;

WITH numbered AS (
  SELECT t.id,
         COALESCE(c.last_number, 0) + ROW_NUMBER() OVER (PARTITION BY t.app_id ORDER BY t.created_at, t.id) AS n
    FROM agent_tasks t LEFT JOIN agent_task_counters c ON c.app_id = t.app_id
   WHERE t.task_number IS NULL
)
UPDATE agent_tasks t SET task_number = numbered.n FROM numbered WHERE t.id = numbered.id;

INSERT INTO agent_task_counters (app_id, last_number)
  SELECT app_id, MAX(task_number) FROM agent_tasks GROUP BY app_id
  ON CONFLICT (app_id) DO UPDATE SET last_number = GREATEST(agent_task_counters.last_number, EXCLUDED.last_number);

CREATE UNIQUE INDEX IF NOT EXISTS "agent_tasks_app_id_task_number_key" ON "agent_tasks"("app_id", "task_number");

-- #2553 (Task Management T12): the per-App short number behind the task handle AT<n>.
-- Source of truth for these objects; the migration carries a byte-identical copy
-- (pinned by src/lib/agentTasks/taskNumber2553.test.ts) and post-push.sql includes this file.

-- The number is part of identity, so a row never lacks one. insertTask states it explicitly;
-- this trigger covers any writer that leaves it out. The counter row is its own row (not the
-- App row), so it serializes creates within one App and nothing else.
CREATE OR REPLACE FUNCTION agent_tasks_assign_number() RETURNS trigger AS $$
BEGIN
  IF NEW.task_number IS NULL THEN
    INSERT INTO agent_task_counters (app_id, last_number) VALUES (NEW.app_id, 1)
      ON CONFLICT (app_id) DO UPDATE SET last_number = agent_task_counters.last_number + 1
      RETURNING last_number INTO NEW.task_number;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_agent_tasks_assign_number ON agent_tasks;
CREATE TRIGGER trg_agent_tasks_assign_number BEFORE INSERT ON agent_tasks
  FOR EACH ROW EXECUTE FUNCTION agent_tasks_assign_number();

-- A committed number is never changed (cor:agt:050:01, Proposed handle paragraph).
CREATE OR REPLACE FUNCTION agent_tasks_number_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.task_number IS DISTINCT FROM OLD.task_number THEN
    RAISE EXCEPTION 'agent_tasks.task_number is permanent' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_agent_tasks_number_immutable ON agent_tasks;
CREATE TRIGGER trg_agent_tasks_number_immutable BEFORE UPDATE OF task_number ON agent_tasks
  FOR EACH ROW EXECUTE FUNCTION agent_tasks_number_immutable();

ALTER TABLE agent_tasks ALTER COLUMN task_number SET NOT NULL;
