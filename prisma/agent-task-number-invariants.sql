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
