-- #4259 — a failed relaunch may also give SETUP_FAILED (the host could not prepare the launch) or VERIFY_FAILED (the
-- launcher ran, but the host could not prove the agent came up). No new column: only the worker-terminal shape CHECK
-- widens, admitting every row the old one admitted, so re-adding it cannot refuse on existing data. Mirrors
-- prisma/host-operation-invariants.sql.

-- #2771 (proposed cor:agt:070:09) — a worker's stored terminal report holds exactly the server-built keys and nothing
-- else (no screen text), with its closed value sets, so a write that bypasses the resolver cannot store more.
-- #4225 — plus the context size: contextTokens (a whole number from 1 to 2147483647) with contextMeasuredAt, or both
-- null. Both keys may be absent: a row stored before #4225 has neither.
-- #4247 — plus the outcome of a refused or failed relaunch: repair (RELAUNCH_REFUSED or RELAUNCH_FAILED), repairReason (from
-- that outcome's own set) and repairAttempt (a whole number from 1), all three or none, and only on a dark report. An
-- ABSENT key makes its test SQL NULL, which a CHECK passes, so the three-key branch is wrapped in COALESCE(..., false).
-- #4259 — the failure set gains SETUP_FAILED and VERIFY_FAILED.
ALTER TABLE workers DROP CONSTRAINT IF EXISTS chk_workers_terminal_shape;
ALTER TABLE workers ADD CONSTRAINT chk_workers_terminal_shape CHECK (
  terminal IS NULL OR (
    jsonb_typeof(terminal) = 'object' AND
    terminal ?& ARRAY['host', 'status', 'prompt', 'reason', 'lastTurnAt', 'checkedAt', 'reportedAt'] AND
    (terminal - 'host' - 'status' - 'prompt' - 'reason' - 'lastTurnAt' - 'checkedAt' - 'reportedAt' - 'contextTokens' - 'contextMeasuredAt' - 'repair' - 'repairReason' - 'repairAttempt') = '{}'::jsonb AND
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
    jsonb_typeof(terminal -> 'reportedAt') = 'string' AND
    (CASE WHEN jsonb_typeof(terminal -> 'contextTokens') = 'number'
          THEN (terminal ->> 'contextTokens') ~ '^[1-9][0-9]{0,9}$' AND
               (terminal ->> 'contextTokens')::numeric <= 2147483647 AND
               COALESCE(jsonb_typeof(terminal -> 'contextMeasuredAt') = 'string', false)
          ELSE COALESCE(jsonb_typeof(terminal -> 'contextTokens'), 'null') = 'null' AND
               COALESCE(jsonb_typeof(terminal -> 'contextMeasuredAt'), 'null') = 'null' END) AND
    (NOT (terminal ?| ARRAY['repair', 'repairReason', 'repairAttempt']) OR
     COALESCE((terminal ->> 'status') = 'dark' AND
      jsonb_typeof(terminal -> 'repairAttempt') = 'number' AND
      (terminal ->> 'repairAttempt') ~ '^[1-9][0-9]{0,9}$' AND
      (terminal ->> 'repairAttempt')::numeric <= 2147483647 AND
      CASE (terminal ->> 'repair')
        WHEN 'RELAUNCH_REFUSED' THEN COALESCE((terminal ->> 'repairReason') IN ('IDENTITY_MISMATCH', 'DUPLICATE_AGENT', 'PAUSED', 'HALTED', 'LEAVE_ALONE', 'NO_LAUNCHER_PROFILE'), false)
        WHEN 'RELAUNCH_FAILED' THEN COALESCE((terminal ->> 'repairReason') IN ('LAUNCH_EXIT_NONZERO', 'TERMINAL_CREATE_REFUSED', 'TIMEOUT', 'SETUP_FAILED', 'VERIFY_FAILED'), false)
        ELSE false END, false))
  )
);
