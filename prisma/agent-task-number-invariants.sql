-- #2553 (Task Management T12): the hierarchical task handle AT<n>(.<n>)* — counters, number-filling,
-- permanence and the reserved project AT0. Source of truth for these objects; the migration carries a
-- byte-identical copy (pinned by src/lib/agentTasks/taskNumber2553.test.ts) and post-push.sql includes this file.

-- One counter row per parent; parent_task_id NULL is the App's project counter. Prisma models the
-- (app_id, parent_task_id) unique (NULLs distinct, which is right for children); the project counter's
-- one-row-per-App rule is this partial index, which Prisma cannot express.
CREATE UNIQUE INDEX IF NOT EXISTS agent_task_counters_project_uniq
  ON agent_task_counters (app_id) WHERE parent_task_id IS NULL;

-- The number is part of identity, so a row never lacks one. insertTask states number and handle explicitly;
-- this trigger covers any writer that leaves them out. The counter row is its own row (not the App row, not
-- the parent task row), so it serializes creates under one parent and nothing else. Projects count from 1:
-- 0 is only ever the explicit AT0 row ensureProjectZero writes.
CREATE OR REPLACE FUNCTION agent_tasks_assign_number() RETURNS trigger AS $$
DECLARE
  parent_handle text;
BEGIN
  IF NEW.task_number IS NULL THEN
    IF NEW.parent_task_id IS NULL THEN
      INSERT INTO agent_task_counters (id, app_id, parent_task_id, last_number)
        VALUES (replace(gen_random_uuid()::text, '-', ''), NEW.app_id, NULL, 1)
        ON CONFLICT (app_id) WHERE parent_task_id IS NULL
        DO UPDATE SET last_number = agent_task_counters.last_number + 1
        RETURNING last_number INTO NEW.task_number;
    ELSE
      INSERT INTO agent_task_counters (id, app_id, parent_task_id, last_number)
        VALUES (replace(gen_random_uuid()::text, '-', ''), NEW.app_id, NEW.parent_task_id, 1)
        ON CONFLICT (app_id, parent_task_id)
        DO UPDATE SET last_number = agent_task_counters.last_number + 1
        RETURNING last_number INTO NEW.task_number;
    END IF;
  END IF;
  IF NEW.handle IS NULL THEN
    IF NEW.parent_task_id IS NULL THEN
      NEW.handle := 'AT' || NEW.task_number;
    ELSE
      SELECT handle INTO parent_handle FROM agent_tasks WHERE id = NEW.parent_task_id;
      NEW.handle := parent_handle || '.' || NEW.task_number;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_agent_tasks_assign_number ON agent_tasks;
CREATE TRIGGER trg_agent_tasks_assign_number BEFORE INSERT ON agent_tasks
  FOR EACH ROW EXECUTE FUNCTION agent_tasks_assign_number();

-- A committed number, handle and parentage are never changed: parentage is fixed at creation, so the handle
-- always matches the tree (cor:agt:050:01, Proposed handle paragraph). AT0 never leaves `backlog`, so the
-- matcher (pending only) and the stall evaluator (backlog is terminal there) never see it.
CREATE OR REPLACE FUNCTION agent_tasks_number_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.task_number IS DISTINCT FROM OLD.task_number
     OR NEW.handle IS DISTINCT FROM OLD.handle
     OR NEW.parent_task_id IS DISTINCT FROM OLD.parent_task_id THEN
    RAISE EXCEPTION 'agent_tasks.task_number, handle and parent_task_id are permanent' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.handle = 'AT0' AND NEW.status <> 'backlog' THEN
    RAISE EXCEPTION 'the project AT0 stays in backlog' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_agent_tasks_number_immutable ON agent_tasks;
CREATE TRIGGER trg_agent_tasks_number_immutable BEFORE UPDATE OF task_number, handle, parent_task_id, status ON agent_tasks
  FOR EACH ROW EXECUTE FUNCTION agent_tasks_number_immutable();

-- 0 is reserved: only the project AT0 (top level, handle AT0) may carry it. The handle is the dotted path.
ALTER TABLE agent_tasks DROP CONSTRAINT IF EXISTS chk_agent_tasks_handle;
ALTER TABLE agent_tasks ADD CONSTRAINT chk_agent_tasks_handle CHECK (
  task_number >= 0 AND
  handle ~ '^AT(0|[1-9][0-9]*)(\.[1-9][0-9]*)*$' AND
  (task_number > 0 OR (task_number = 0 AND parent_task_id IS NULL AND handle = 'AT0')) AND
  (parent_task_id IS NOT NULL OR handle = 'AT' || task_number) AND
  (parent_task_id IS NULL OR right(handle, length(task_number::text) + 1) = '.' || task_number)
);

ALTER TABLE agent_tasks ALTER COLUMN task_number SET NOT NULL;
ALTER TABLE agent_tasks ALTER COLUMN handle SET NOT NULL;
