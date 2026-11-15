-- #4230 (S1b of #4229, decision G1): a typed launcher profile on the host assignment. The S1a column reserved for it
-- (launcher_profile, never written) gives way to effort and account_profile; with family and model they are the
-- profile, each a token, never a command. Additive for every reader: no row ever set launcher_profile.
ALTER TABLE "host_worker_assignments" DROP CONSTRAINT IF EXISTS chk_host_worker_assignments_shape;
ALTER TABLE "host_worker_assignments" DROP COLUMN "launcher_profile",
ADD COLUMN     "account_profile" TEXT,
ADD COLUMN     "effort" TEXT;

-- worker.start may carry the profile and the Agent's lifecycle: host_launcher_model_ok and host_operation_args_ok as
-- prisma/host-operation-invariants.sql defines them, verbatim. It only widens the start's optional keys; every stored operation still passes.
-- #4230 (S1b; #4251 blind P2, Peter #108855): the ONE grammar of a launcher model, used by the host assignment's stored
-- shape (prisma/host-assignment-invariants.sql) and by worker.start's argument check below, so every model an assignment
-- can hold is a model a start can carry: a host-operation token of at most 128 characters (S1a's shape; GLM-style names
-- such as z-ai/glm-4.6 included). The API's own rule for a new write is stricter (src/lib/hostOperations/assignments.ts).
CREATE OR REPLACE FUNCTION host_launcher_model_ok(t text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$ SELECT host_operation_token_ok(t) AND length(t) <= 128 $$;

-- cor:agt:070:03 — the closed set of typed operations, each with exactly its own
-- arguments (#1709's T6 table, Proposed): no other key, and every name argument
-- a host-operation token. There is no free-form or shell type, and no argument
-- that could carry one. `workerId` is the operation's worker column.
CREATE OR REPLACE FUNCTION host_operation_args_ok(op_type text, args jsonb, op_worker_id text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  required text[];
  optional text[] := '{}';
  k text;
  v jsonb;
BEGIN
  IF jsonb_typeof(args) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  CASE op_type
    WHEN 'worktree.create' THEN required := ARRAY['workerId', 'repo', 'baseBranch', 'branchName', 'label'];
    -- #4230 (S1b, decision G1): a start may carry its assignment's typed launcher profile and its Agent's lifecycle,
    -- never a command.
    WHEN 'worker.start' THEN required := ARRAY['workerId', 'worktree', 'family']; optional := ARRAY['taskId', 'model', 'effort', 'accountProfile', 'lifecycle'];
    WHEN 'worker.deliver' THEN required := ARRAY['workerId', 'sessionId', 'eventId'];
    WHEN 'worker.end' THEN required := ARRAY['workerId', 'sessionId'];
    WHEN 'worktree.remove' THEN required := ARRAY['workerId', 'worktree'];
    -- #2162 (cor:agt:050:27): reset a worker's context, a shed and never a session end.
    WHEN 'worker.reset-context' THEN required := ARRAY['workerId', 'sessionId', 'taskId', 'resetId'];
    ELSE RETURN false;
  END CASE;
  FOREACH k IN ARRAY required LOOP
    IF NOT args ? k THEN RETURN false; END IF;
  END LOOP;
  FOR k, v IN SELECT * FROM jsonb_each(args) LOOP
    IF NOT (k = ANY (required) OR k = ANY (optional)) THEN RETURN false; END IF;
    IF jsonb_typeof(v) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
    IF k IN ('workerId', 'sessionId', 'eventId', 'taskId', 'resetId') THEN
      IF NOT (v #>> '{}') ~ '^[A-Za-z0-9_-]{1,64}$' THEN RETURN false; END IF;
    ELSIF k = 'family' THEN
      IF NOT (v #>> '{}') ~ '^[a-z0-9][a-z0-9._-]{0,63}$' THEN RETURN false; END IF;
    ELSIF op_type = 'worker.start' AND k IN ('effort', 'accountProfile') THEN
      IF NOT (v #>> '{}') ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' THEN RETURN false; END IF;
    -- The model: the one launcher-model grammar the assignment store uses too (host_launcher_model_ok, above).
    ELSIF op_type = 'worker.start' AND k = 'model' THEN
      IF NOT host_launcher_model_ok(v #>> '{}') THEN RETURN false; END IF;
    ELSIF op_type = 'worker.start' AND k = 'lifecycle' THEN
      IF (v #>> '{}') NOT IN ('LONG_LIVED', 'SHORT_LIVED') THEN RETURN false; END IF;
    ELSIF NOT host_operation_token_ok(v #>> '{}') THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN args ->> 'workerId' = op_worker_id;
END;
$$;

-- Then the host-assignment invariants file, verbatim.
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
  -- The one launcher-model grammar, shared with worker.start's argument check (prisma/host-operation-invariants.sql).
  (model IS NULL OR host_launcher_model_ok(model)) AND
  -- #4230 (S1b, decision G1): the rest of the launcher profile, plain tokens with no slash, space or shell character.
  (effort IS NULL OR effort ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$') AND
  (account_profile IS NULL OR account_profile ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')
);

-- An assignment names only a worker of its own App, and a worker that has assignments keeps its App: the composite
-- foreign key (worker_id, app_id) -> workers (id, app_id), modelled in schema.prisma (#4241 blind review, Diego P2).
-- Foreign-key checks see committed rows at every isolation level, so it holds when an insert and a move race.

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
