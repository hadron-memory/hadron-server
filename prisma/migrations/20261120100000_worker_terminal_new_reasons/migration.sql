-- #4558 (hadron-cli#2677) — the terminal reason set gains no_screen (Orca gives no rendered screen for the
-- terminal) and multiple_terminals (more than one agent terminal bound to the worker). Both ride locked, as
-- unrecognized does: the stored status is unchanged and no terminal-status event follows (that event is not
-- built, cor:agt:050:11 slice S1c). Only the reason list of the worker-terminal shape CHECK widens, admitting
-- every row the old one admitted, so re-adding it cannot refuse on existing data (this migration refuses
-- nothing, and must not name the refusal SQLSTATE in a comment: refused-migration-boot.test.ts scans every
-- migration whose body carries that token and then rejects its bare CASE ... END tokens as transaction enders).
-- Based on 20261115260000_relaunch_failure_codes's definition (the last migration that redefined it); the
-- canonical copy test databases and CI read is prisma/host-operation-invariants.sql.

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
          THEN COALESCE((terminal ->> 'reason') IN ('model_at_capacity', 'token_budget_exhausted', 'rate_limited', 'guardrail_triggered', 'menu_or_question', 'shed_staged_not_relaunched', 'unrecognized', 'no_turn_for_due_ticker', 'no_terminal', 'bare_shell', 'no_agent', 'no_screen', 'multiple_terminals'), false)
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
