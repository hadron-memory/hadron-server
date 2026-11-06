-- #2771: a worker stores the latest terminal report a host made for it (cor:agt:070:09, proposed), and a host key's
-- use record gains the `terminal` action. The column is additive (existing rows NULL: no host has reported, no
-- backfill). The file below is the current host-operation invariants, verbatim: it carries the widened
-- `chk_host_key_uses_shape` and the new `chk_workers_terminal_shape`.
ALTER TABLE workers ADD COLUMN terminal jsonb;

-- #1709 (Task Management T6): host operations and the record of host-key use.
-- Source of truth for these objects; the migration carries a byte-identical copy
-- (pinned by src/lib/hostOperations/invariants.test.ts) and post-push.sql includes this file.
-- Uses host_operation_token_ok from prisma/agent-task-matching-invariants.sql.

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
    WHEN 'worker.start' THEN required := ARRAY['workerId', 'worktree', 'family']; optional := ARRAY['taskId'];
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
    ELSIF NOT host_operation_token_ok(v #>> '{}') THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN args ->> 'workerId' = op_worker_id;
END;
$$;

-- cor:agt:070:02 — the status runs issued → collected → succeeded | failed
-- (`collected` Proposed by #1709). Each stage stamps its time and nothing
-- later's; a success may carry a typed result, a failure carries its reason
-- and no result. The issuer is a person, a worker through its session, or the
-- platform, and names exactly the ids that kind has.
ALTER TABLE host_operations DROP CONSTRAINT IF EXISTS chk_host_operations_shape;
ALTER TABLE host_operations ADD CONSTRAINT chk_host_operations_shape CHECK (
  host_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
  host_operation_args_ok(type, args, worker_id) AND
  CASE status
    WHEN 'issued' THEN num_nonnulls(collected_at, finished_at, result, failure_reason) = 0
    WHEN 'collected' THEN collected_at IS NOT NULL AND num_nonnulls(finished_at, result, failure_reason) = 0
    -- #1881: an operation settled before any host collected it (its host lapsed, or its reason went away) has no
    -- collected_at; one collected keeps it.
    WHEN 'succeeded' THEN finished_at IS NOT NULL AND failure_reason IS NULL
      AND (result IS NULL OR jsonb_typeof(result) = 'object')
    WHEN 'failed' THEN finished_at IS NOT NULL AND result IS NULL
      AND failure_reason IS NOT NULL AND char_length(failure_reason) BETWEEN 1 AND 2000
    ELSE false
  END AND
  CASE issued_by
    WHEN 'user' THEN issued_by_user_id IS NOT NULL AND issued_by_worker_id IS NULL
    WHEN 'worker' THEN issued_by_worker_id IS NOT NULL
    WHEN 'platform' THEN num_nonnulls(issued_by_user_id, issued_by_worker_id, issued_by_agent_id) = 0
    ELSE false
  END
);

-- An operation is for a worker of its own App: no writer can queue one host's
-- work against another tenant's worker.
CREATE OR REPLACE FUNCTION host_operation_same_app() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers w WHERE w.id = NEW.worker_id AND w.app_id = NEW.app_id) THEN
    RAISE EXCEPTION 'host_operations: worker % is not in the operation''s App', NEW.worker_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'chk_host_operations_same_app';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_host_operations_same_app ON host_operations;
CREATE TRIGGER trg_host_operations_same_app
  BEFORE INSERT ON host_operations
  FOR EACH ROW EXECUTE FUNCTION host_operation_same_app();

-- What was issued, to whom and by whom never changes, and the status only moves
-- forward: issued → collected → succeeded | failed. An operation is removed only
-- with its App or its worker (the cascades).
--
-- Limits, recorded on purpose: TRUNCATE fires no row trigger (the test-only
-- cleanup path), and the table owner can disable the trigger; this guards the
-- application, not a DB superuser.
CREATE OR REPLACE FUNCTION host_operation_forward_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM apps WHERE id = OLD.app_id) AND EXISTS (SELECT 1 FROM workers WHERE id = OLD.worker_id) THEN
      RAISE EXCEPTION 'A host operation is kept as the record of what was issued' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW.id, NEW.app_id, NEW.host_id, NEW.type, NEW.args, NEW.worker_id, NEW.issued_by,
      NEW.issued_by_user_id, NEW.issued_by_worker_id, NEW.issued_by_agent_id, NEW.issued_at)
     IS DISTINCT FROM
     (OLD.id, OLD.app_id, OLD.host_id, OLD.type, OLD.args, OLD.worker_id, OLD.issued_by,
      OLD.issued_by_user_id, OLD.issued_by_worker_id, OLD.issued_by_agent_id, OLD.issued_at) THEN
    RAISE EXCEPTION 'A host operation''s type, arguments, host, worker and issuer never change' USING ERRCODE = '23514';
  END IF;
  -- #1881 (cor:agt:070:02, Holger #10765): nothing stays in flight forever. An operation never collected is settled
  -- by the platform when its host lapses or its reason goes away: failed, or (a worker.end whose session already
  -- ended, cor:agt:020:10) succeeded. It keeps no collected_at.
  IF NOT (
    (OLD.status = 'issued' AND NEW.status IN ('collected', 'succeeded', 'failed')) OR
    (OLD.status = 'collected' AND NEW.status IN ('succeeded', 'failed'))
  ) THEN
    RAISE EXCEPTION 'A host operation moves only issued → collected → succeeded | failed, or issued → succeeded | failed (was %, now %)', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'issued' AND NEW.status IN ('succeeded', 'failed') AND NEW.collected_at IS NOT NULL THEN
    RAISE EXCEPTION 'An operation settled before collection has no collected_at' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_host_operations_forward_only ON host_operations;
CREATE TRIGGER trg_host_operations_forward_only
  BEFORE UPDATE OR DELETE ON host_operations
  FOR EACH ROW EXECUTE FUNCTION host_operation_forward_only();

-- cor:agt:070:07 — every use of a host key is recorded, and the record is kept:
-- never changed, removed only with its key (the cascade).
ALTER TABLE host_key_uses DROP CONSTRAINT IF EXISTS chk_host_key_uses_shape;
ALTER TABLE host_key_uses ADD CONSTRAINT chk_host_key_uses_shape CHECK (
  action IN ('register', 'collect', 'report', 'availability', 'read', 'session', 'issue', 'deliver', 'stop', 'reset', 'terminal') AND
  host_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
  (count IS NULL OR count >= 0) AND
  -- A refused report may name no operation it could see; an accepted one always names its own. #2162: so does a
  -- context-reset protocol step (`reset`).
  (CASE WHEN refused_code IS NULL THEN (action IN ('report', 'reset')) = (operation_id IS NOT NULL)
        ELSE (operation_id IS NULL OR action IN ('report', 'reset')) AND refused_code ~ '^[A-Z][A-Z0-9_]{0,63}$' END)
);

CREATE OR REPLACE FUNCTION host_key_use_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM app_keys WHERE id = OLD.app_key_id) THEN
      RAISE EXCEPTION 'Host key uses are append-only' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Host key uses are append-only' USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS trg_host_key_uses_append_only ON host_key_uses;
CREATE TRIGGER trg_host_key_uses_append_only
  BEFORE UPDATE OR DELETE ON host_key_uses
  FOR EACH ROW EXECUTE FUNCTION host_key_use_append_only();

-- cor:agt:050:10 — a request that a task's assignee end its session is open
-- until resolved once: the session ended, the platform issued worker.end for it
-- (naming that operation), or there was no live host. Its grace runs forward.
ALTER TABLE task_session_end_requests DROP CONSTRAINT IF EXISTS chk_task_session_end_requests_shape;
ALTER TABLE task_session_end_requests ADD CONSTRAINT chk_task_session_end_requests_shape CHECK (
  due_at >= requested_at AND
  ((resolved_at IS NULL) = (resolution IS NULL)) AND
  (resolution IS NULL OR resolution IN ('ended', 'end-issued', 'no-live-host')) AND
  ((resolution IS NOT DISTINCT FROM 'end-issued') = (operation_id IS NOT NULL))
);

-- #2771 (proposed cor:agt:070:09) — a worker's stored terminal report holds exactly the server-built keys and nothing
-- else (no screen text), with its closed value sets, so a write that bypasses the resolver cannot store more.
ALTER TABLE workers DROP CONSTRAINT IF EXISTS chk_workers_terminal_shape;
ALTER TABLE workers ADD CONSTRAINT chk_workers_terminal_shape CHECK (
  terminal IS NULL OR (
    jsonb_typeof(terminal) = 'object' AND
    terminal ?& ARRAY['host', 'status', 'prompt', 'reason', 'lastTurnAt', 'checkedAt', 'reportedAt'] AND
    (terminal - 'host' - 'status' - 'prompt' - 'reason' - 'lastTurnAt' - 'checkedAt' - 'reportedAt') = '{}'::jsonb AND
    jsonb_typeof(terminal -> 'host') = 'object' AND
    terminal -> 'host' ?& ARRAY['id', 'label'] AND
    ((terminal -> 'host') - 'id' - 'label') = '{}'::jsonb AND
    jsonb_typeof(terminal -> 'host' -> 'id') = 'string' AND
    jsonb_typeof(terminal -> 'host' -> 'label') = 'string' AND
    COALESCE((terminal ->> 'status') IN ('busy', 'idle', 'locked', 'dark'), false) AND
    COALESCE((terminal ->> 'prompt') IN ('empty', 'not_empty', 'menu', 'unknown'), false) AND
    (CASE WHEN (terminal ->> 'status') IN ('locked', 'dark')
          THEN COALESCE((terminal ->> 'reason') IN ('model_at_capacity', 'token_budget_exhausted', 'rate_limited', 'guardrail_triggered', 'menu_or_question', 'shed_staged_not_relaunched', 'unrecognized', 'no_turn_for_due_ticker', 'no_terminal', 'bare_shell', 'no_agent'), false)
          ELSE jsonb_typeof(terminal -> 'reason') = 'null' END) AND
    jsonb_typeof(terminal -> 'lastTurnAt') IN ('string', 'null') AND
    jsonb_typeof(terminal -> 'checkedAt') = 'string' AND
    jsonb_typeof(terminal -> 'reportedAt') = 'string'
  )
);
