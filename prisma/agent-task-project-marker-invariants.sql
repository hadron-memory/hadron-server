-- #4997 (hrn:node:hadronmemory.com:specs:cor:agt:050:01 Project marker; hrn:node:hadronmemory.com:specs:cor:agt:150 A project): the
-- project marker is set only at creation and never changed, as the parent is, and AT0 is never marked. One source, shared
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

-- AT0, the platform's own root and the visible "No project" bucket, is never a project.
ALTER TABLE agent_tasks DROP CONSTRAINT IF EXISTS chk_agent_tasks_at0_unmarked;
ALTER TABLE agent_tasks ADD CONSTRAINT chk_agent_tasks_at0_unmarked CHECK (handle IS DISTINCT FROM 'AT0' OR NOT is_project);
