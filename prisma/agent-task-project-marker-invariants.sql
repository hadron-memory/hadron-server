-- #4997 (hrn:node:hadronmemory.com:specs:cor:agt:050:01 Project marker; hrn:node:hadronmemory.com:specs:cor:agt:150 A project): the
-- project marker is set only at creation and never changed, as the parent is; every top-level task other than AT0 is
-- marked, and AT0 never is. One source, shared
-- verbatim with migration 20261124150000_agent_task_is_project (pinned by src/lib/agentTasks/invariants.test.ts).
-- Idempotent: CREATE OR REPLACE, then drop-then-add.
CREATE OR REPLACE FUNCTION agent_tasks_project_marker_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.is_project IS DISTINCT FROM OLD.is_project THEN
    RAISE EXCEPTION 'agent_tasks.is_project is set at creation and never changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_agent_tasks_project_marker_immutable ON agent_tasks;
CREATE TRIGGER trg_agent_tasks_project_marker_immutable BEFORE UPDATE OF is_project ON agent_tasks
  FOR EACH ROW EXECUTE FUNCTION agent_tasks_project_marker_immutable();

-- A top-level task other than AT0 is a project: the only way to make one is `project: true`, which marks it (cor:agt:050:01
-- Project marker, ruling A). Marking it here as well keeps that true for a server that does not know the column, such as
-- the previous image still serving while this one migrates: its insert omits is_project, and the task would otherwise stay
-- unmarked, which the guard above makes permanent. AT0 is the explicit task_number 0 row and is left alone. Order-free
-- with trg_agent_tasks_assign_number, which numbers only a NULL task_number.
CREATE OR REPLACE FUNCTION agent_tasks_project_marker_top_level() RETURNS trigger AS $$
BEGIN
  IF NEW.parent_task_id IS NULL AND NEW.task_number IS DISTINCT FROM 0 THEN
    NEW.is_project := true;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_agent_tasks_project_marker_top_level ON agent_tasks;
CREATE TRIGGER trg_agent_tasks_project_marker_top_level BEFORE INSERT ON agent_tasks
  FOR EACH ROW EXECUTE FUNCTION agent_tasks_project_marker_top_level();

-- AT0, the platform's own root and the visible "No project" bucket, is never a project.
ALTER TABLE agent_tasks DROP CONSTRAINT IF EXISTS chk_agent_tasks_at0_unmarked;
ALTER TABLE agent_tasks ADD CONSTRAINT chk_agent_tasks_at0_unmarked CHECK (handle IS DISTINCT FROM 'AT0' OR NOT is_project);
