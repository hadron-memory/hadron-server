-- #4291 (S14 of #4229) — family, model and effort are run settings, not worker identity (decision record
-- hrn:node:hadronmemory.com:hadron-business:decisions:run-settings-are-not-worker-identity).
--
-- EXPAND-SAFE: one new enum type, additive NULLABLE columns with no default (no row is rewritten), and one
-- CREATE OR REPLACE of a function that only ADMITS one more optional key. The previous image runs against this schema
-- and never reads or writes any of it. No backfill: the worker's record fills from the first bind or report after
-- deploy, and an empty record is seeded at a start from the assignment's launcher profile.

CREATE TYPE "EffortLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'XHIGH', 'MAX', 'UNSET', 'NOT_APPLICABLE');

-- The session's applied effort, as it reports it.
ALTER TABLE "sessions" ADD COLUMN "effort" "EffortLevel";

-- The worker's record: what its session last reported. A report, never a control.
ALTER TABLE "workers"
  ADD COLUMN "last_used_family" TEXT,
  ADD COLUMN "last_used_model" TEXT,
  ADD COLUMN "last_used_effort" "EffortLevel";

-- The task's own run settings, and the settings its run actually used (read from the session at task start).
ALTER TABLE "agent_tasks"
  ADD COLUMN "run_family" TEXT,
  ADD COLUMN "run_model" TEXT,
  ADD COLUMN "run_tier" TEXT,
  ADD COLUMN "run_effort" "EffortLevel",
  ADD COLUMN "applied_family" TEXT,
  ADD COLUMN "applied_model" TEXT,
  ADD COLUMN "applied_effort" "EffortLevel";

-- worker.start may carry `tier` (high, mid or low) when its task names a generic tier instead of a model. The function
-- as prisma/host-operation-invariants.sql holds it (pinned by src/lib/hostOperations/invariants.test.ts).
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
    -- #4291 (S14): a start whose task names a generic tier carries the tier instead of a model.
    WHEN 'worker.start' THEN required := ARRAY['workerId', 'worktree', 'family']; optional := ARRAY['taskId', 'model', 'effort', 'accountProfile', 'lifecycle', 'tier'];
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
    ELSIF op_type = 'worker.start' AND k = 'tier' THEN
      IF (v #>> '{}') NOT IN ('high', 'mid', 'low') THEN RETURN false; END IF;
    ELSIF NOT host_operation_token_ok(v #>> '{}') THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN args ->> 'workerId' = op_worker_id;
END;
$$;
