-- #4222 (S1a of #4229): the workers the platform says a host runs, and the App's setup-source switch.
-- Source of truth for these objects; the migration carries a byte-identical copy
-- (pinned by src/api/graphql/schema/resolvers.hostAssignment4222.test.ts) and post-push.sql includes this file,
-- after agent-task-matching-invariants.sql (host_operation_token_ok) and worker-reference-invariants.sql (the fence).

-- cor:agt:070:01 (change Proposed): who states which workers a host runs. `host` until the App opts in.
ALTER TABLE apps DROP CONSTRAINT IF EXISTS chk_apps_host_setup_source;
ALTER TABLE apps ADD CONSTRAINT chk_apps_host_setup_source CHECK (host_setup_source IN ('host', 'server'));

-- cor:agt:070:03: the platform never names a path or a command. Every field a host acts on is a name token (never
-- an option, never a path escape), the family a lowercase family token, the host id a host token.
ALTER TABLE host_worker_assignments DROP CONSTRAINT IF EXISTS chk_host_worker_assignments_shape;
ALTER TABLE host_worker_assignments ADD CONSTRAINT chk_host_worker_assignments_shape CHECK (
  host_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
  host_operation_token_ok(workdir) AND
  family ~ '^[a-z0-9][a-z0-9._-]{0,63}$' AND
  (model IS NULL OR (host_operation_token_ok(model) AND length(model) <= 128)) AND
  (launcher_profile IS NULL OR (host_operation_token_ok(launcher_profile) AND length(launcher_profile) <= 128))
);

-- An assignment names only a worker of its own App. The writer checks this too; the trigger makes it a database
-- fact, so no later writer can assign another tenant's worker to a host. The worker row is locked FOR SHARE before
-- it is judged, which conflicts with any update of the row: a concurrent move of the worker to another App either
-- committed first (this check then reads the new App and refuses) or waits for this insert to commit (and the
-- trigger below then sees this assignment and refuses the move). A plain read would let both commit (#4241 blind
-- delta, Diego P2).
CREATE OR REPLACE FUNCTION host_worker_assignment_same_app() RETURNS trigger AS $$
DECLARE
  worker_app TEXT;
BEGIN
  SELECT w.app_id INTO worker_app FROM workers w WHERE w.id = NEW.worker_id FOR SHARE;
  IF worker_app IS DISTINCT FROM NEW.app_id THEN
    RAISE EXCEPTION 'host_worker_assignments: worker % is not in the assignment''s App', NEW.worker_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'chk_host_worker_assignments_same_app';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_host_worker_assignments_same_app ON host_worker_assignments;
CREATE TRIGGER trg_host_worker_assignments_same_app
  BEFORE INSERT OR UPDATE ON host_worker_assignments
  FOR EACH ROW EXECUTE FUNCTION host_worker_assignment_same_app();

-- The same fact from the worker's side: a worker that has assignments keeps its App, so no move of a worker leaves
-- an assignment naming it in the App it left (#4241 blind review, Diego P2-2). Remove its assignments first. A BEFORE
-- UPDATE row trigger runs once the row is locked, so an assignment insert holding the row FOR SHARE has committed by
-- then, and this check reads it.
CREATE OR REPLACE FUNCTION host_worker_assignment_worker_app_fixed() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM host_worker_assignments ha WHERE ha.worker_id = NEW.id AND ha.app_id <> NEW.app_id) THEN
    RAISE EXCEPTION 'workers: worker % has host assignments in its App, so its App does not change', NEW.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'chk_host_worker_assignments_same_app';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_workers_host_assignment_app_fixed ON workers;
CREATE TRIGGER trg_workers_host_assignment_app_fixed
  BEFORE UPDATE OF app_id ON workers
  FOR EACH ROW WHEN (OLD.app_id IS DISTINCT FROM NEW.app_id)
  EXECUTE FUNCTION host_worker_assignment_worker_app_fixed();

-- #1162: the worker id an assignment records is a typed reference, under the same writer fence as every other one.
-- The fence function exists from migration 20261016050000; post-push.sql applies this file after
-- worker-reference-invariants.sql, which defines it.
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "host_worker_assignments";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "host_worker_assignments"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.worker_id');
