-- #4225 S4a (epic #4229) — a worker's terminal report may carry its context size. No new column: the two keys join
-- the stored `workers.terminal` object, so only its shape CHECK changes. The new CHECK admits every row the old one
-- admitted (the keys may be absent), so re-adding it cannot refuse on existing data. Mirrors
-- prisma/host-operation-invariants.sql.

-- #2771 (proposed cor:agt:070:09) — a worker's stored terminal report holds exactly the server-built keys and nothing
-- else (no screen text), with its closed value sets, so a write that bypasses the resolver cannot store more.
-- #4225 — plus the context size: contextTokens (a whole number from 1 to 2147483647) with contextMeasuredAt, or both
-- null. Both keys may be absent: a row stored before #4225 has neither.
ALTER TABLE workers DROP CONSTRAINT IF EXISTS chk_workers_terminal_shape;
ALTER TABLE workers ADD CONSTRAINT chk_workers_terminal_shape CHECK (
  terminal IS NULL OR (
    jsonb_typeof(terminal) = 'object' AND
    terminal ?& ARRAY['host', 'status', 'prompt', 'reason', 'lastTurnAt', 'checkedAt', 'reportedAt'] AND
    (terminal - 'host' - 'status' - 'prompt' - 'reason' - 'lastTurnAt' - 'checkedAt' - 'reportedAt' - 'contextTokens' - 'contextMeasuredAt') = '{}'::jsonb AND
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
               COALESCE(jsonb_typeof(terminal -> 'contextMeasuredAt'), 'null') = 'null' END)
  )
);
