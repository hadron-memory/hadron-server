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

-- An assignment names only a worker of its own App, and a worker that has assignments keeps its App. A composite
-- foreign key, not a trigger: PostgreSQL's foreign-key checks see committed rows under every isolation level (a
-- REPEATABLE READ writer whose snapshot predates the other write gets a serialization failure), so neither an insert
-- naming another App's worker nor a move of an assigned worker to another App can commit, whichever commits first
-- (#4241 blind review, Diego P2-2 and its deltas). The resolver checks the App too; this makes it a database fact.
-- The target is unique trivially (id is the primary key); it exists so the key can name it. Moving an assigned worker
-- is refused (ON UPDATE NO ACTION): remove its assignments first. Deleting the worker removes them.
CREATE UNIQUE INDEX IF NOT EXISTS workers_host_assignment_owner_uniq ON workers (id, app_id);
ALTER TABLE host_worker_assignments DROP CONSTRAINT IF EXISTS host_worker_assignments_worker_app_fkey;
ALTER TABLE host_worker_assignments ADD CONSTRAINT host_worker_assignments_worker_app_fkey
  FOREIGN KEY (worker_id, app_id) REFERENCES workers (id, app_id) ON DELETE CASCADE;

-- Earlier heads of #4241 enforced this with triggers; a database that applied one of them drops them here.
DROP TRIGGER IF EXISTS trg_host_worker_assignments_same_app ON host_worker_assignments;
DROP FUNCTION IF EXISTS host_worker_assignment_same_app();
DROP TRIGGER IF EXISTS trg_workers_host_assignment_app_fixed ON workers;
DROP FUNCTION IF EXISTS host_worker_assignment_worker_app_fixed();

-- #1162: the worker id an assignment records is a typed reference, under the same writer fence as every other one.
-- The fence function exists from migration 20261016050000; post-push.sql applies this file after
-- worker-reference-invariants.sql, which defines it.
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "host_worker_assignments";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "host_worker_assignments"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.worker_id');
