-- #4997: the project marker on agent tasks (cor:agt:050:01, cor:agt:150 A project). Expand-safe: one additive boolean column.
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS is_project BOOLEAN NOT NULL DEFAULT false;

-- Backfill: every task S1 (#4447) counts as a project today, a top-level task other than AT0, is marked, so the set of
-- projects does not change at deploy. (Report 2 then counts each project's tasks at any depth, once, under the nearest
-- marked ancestor, per cor:agt:150 "What a project counts"; with no nested marker yet, that differs from S1 only for a
-- project with grandchildren.) Deterministic and refuses nothing on data. AT0 has task_number 0. The guard trigger is
-- dropped first: a database that already carries it (post-push.sql on a pushed schema) would refuse the UPDATE, and the
-- tail below re-creates it.
DROP TRIGGER IF EXISTS trg_agent_tasks_project_marker_immutable ON agent_tasks;
UPDATE agent_tasks SET is_project = true WHERE parent_task_id IS NULL AND task_number > 0 AND NOT is_project;

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
