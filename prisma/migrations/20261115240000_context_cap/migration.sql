-- #4225 S4b (epic #4229) — an Agent's context cap, and a context reset that belongs to no task.
-- AlterTable
ALTER TABLE "agents" ADD COLUMN "context_cap" INTEGER;

-- AlterTable
ALTER TABLE "context_resets" ALTER COLUMN "task_id" DROP NOT NULL;
ALTER TABLE "context_resets" ADD COLUMN "cause" TEXT NOT NULL DEFAULT 'task-end';

-- #4225: the reset operation names its task only when it has one, and may name its cause (host-operation-invariants.sql is
-- the one definition; this migration carries its text).
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
    -- #4225: the task is named only when there is one (a context-cap reset has none), and the cause is a closed set.
    WHEN 'worker.reset-context' THEN required := ARRAY['workerId', 'sessionId', 'resetId']; optional := ARRAY['taskId', 'cause'];
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
    ELSIF k = 'cause' THEN
      IF NOT (v #>> '{}') IN ('task-end', 'context-cap') THEN RETURN false; END IF;
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

-- #4225 S4b (epic #4229; cor:agt:050:27 part 12, Proposed): a reset may be asked for by an Agent's context cap, with no task.
-- `cause` is `task-end` (it names its task) or `context-cap` (it names none), and never changes; an Agent's cap is a
-- whole number of tokens from 1, or null for none. Every row stored before this carries `task-end` and its task.
ALTER TABLE context_resets DROP CONSTRAINT IF EXISTS chk_context_resets_cause;
ALTER TABLE context_resets ADD CONSTRAINT chk_context_resets_cause CHECK (
  cause IN ('task-end', 'context-cap') AND ((cause = 'task-end') = (task_id IS NOT NULL))
);

CREATE OR REPLACE FUNCTION context_reset_cause_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.cause IS DISTINCT FROM OLD.cause THEN
    RAISE EXCEPTION 'A context reset''s cause never changes' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_context_resets_cause_immutable ON context_resets;
CREATE TRIGGER trg_context_resets_cause_immutable
  BEFORE UPDATE ON context_resets
  FOR EACH ROW EXECUTE FUNCTION context_reset_cause_immutable();

ALTER TABLE agents DROP CONSTRAINT IF EXISTS chk_agents_context_cap;
ALTER TABLE agents ADD CONSTRAINT chk_agents_context_cap CHECK (context_cap IS NULL OR context_cap >= 1);
