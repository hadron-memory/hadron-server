-- #2162: the 'resetting' availability mark (cor:agt:050:27). The file below is the current stall invariants, verbatim.

-- #1706 (Task Management T2): stall alarms, their wakes, availability for work,
-- and per-App stall windows.
-- Source of truth for these objects; the migration carries a byte-identical copy
-- (pinned by src/lib/agentTasks/invariants.test.ts) and post-push.sql includes this file.

-- cor:agt:050:13 — an episode key belongs to a stall alarm on a task. The
-- unique index agent_team_events_episode_uniq (task_id, type, episode_start)
-- is what makes one alarm per episode hold; this keeps the key off every
-- other event. IS NOT NULL, not = 'alarm': the T1 shape CHECK already pins
-- severity to NULL or 'alarm', and a NULL comparison would pass a CHECK.
ALTER TABLE agent_team_events DROP CONSTRAINT IF EXISTS chk_agent_team_events_episode;
ALTER TABLE agent_team_events ADD CONSTRAINT chk_agent_team_events_episode CHECK (
  episode_start IS NULL OR (severity IS NOT NULL AND task_id IS NOT NULL AND chain IS NOT NULL)
);

-- cor:agt:050:19 — a wake is one owner of the alarm's chain; it is woken no
-- earlier than it falls due.
ALTER TABLE agent_team_alarm_schedule DROP CONSTRAINT IF EXISTS chk_agent_team_alarm_schedule_shape;
ALTER TABLE agent_team_alarm_schedule ADD CONSTRAINT chk_agent_team_alarm_schedule_shape CHECK (
  chain_index >= 0 AND (woken_at IS NULL OR woken_at >= due_at)
);

-- cor:agt:060:02 — available or unavailable; a reason only when unavailable
-- (Proposed), from the closed set (`held` was dropped, team chat #7449); an
-- `until` only on an unavailable record; one of cor:agt:060:08's setters
-- (`reports-to`, #1759: the worker it reports to, clearing a stall), or
-- `lapse` (#1766): the platform recording that an `until` passed. #1709: a
-- record a host set names that host, and only such a record does; a host
-- marks only out of tokens or host down, or clears its own mark.
ALTER TABLE worker_availability DROP CONSTRAINT IF EXISTS chk_worker_availability_shape;
ALTER TABLE worker_availability ADD CONSTRAINT chk_worker_availability_shape CHECK (
  CASE state
    WHEN 'available' THEN reason IS NULL AND until IS NULL
    WHEN 'unavailable' THEN reason IS NOT NULL AND reason IN ('stalled', 'out-of-tokens', 'host-down', 'other', 'resetting')
    ELSE false
  END AND
  set_by IN ('worker', 'holder', 'app-manager', 'reports-to', 'stall-rule', 'host', 'lapse', 'context-reset') AND
  ((set_by = 'host') = (set_by_host_id IS NOT NULL)) AND
  (set_by <> 'host' OR state = 'available' OR reason IN ('out-of-tokens', 'host-down')) AND
  -- #2162 (cor:agt:050:27): only the platform's reset writes `resetting`, an unavailable mark it sets is always that,
  -- and only that mark ends on activity after the old agent stopped. The reset may also write the mark's release.
  ((reason IS NOT DISTINCT FROM 'resetting') = (set_by = 'context-reset' AND state = 'unavailable')) AND
  (clears_on_activity_after IS NULL OR reason = 'resetting')
);

-- cor:agt:060:03 — the same state / reason shape per App and model family; a
-- family is a lowercase token (cor:agt:060:04).
ALTER TABLE model_family_availability DROP CONSTRAINT IF EXISTS chk_model_family_availability_shape;
ALTER TABLE model_family_availability ADD CONSTRAINT chk_model_family_availability_shape CHECK (
  family ~ '^[a-z0-9][a-z0-9._-]{0,63}$' AND
  CASE state
    WHEN 'available' THEN reason IS NULL AND until IS NULL
    WHEN 'unavailable' THEN reason IS NOT NULL AND reason IN ('stalled', 'out-of-tokens', 'host-down', 'other')
    ELSE false
  END
);

-- cor:agt:050:14–:17 "What Can Change" — a window is a positive number of
-- minutes, at most a week; NULL means the platform default. cor:agt:070:01
-- (#1763; Holger, team chat #10405): the host-registration lapse is a whole
-- number of check-ins from 2 to 10; NULL means the default, 3. cor:agt:050:10
-- (#1709): the grace before the platform ends a finished task's session is 1
-- to 1440 minutes; NULL means the default, 10.
ALTER TABLE agent_task_stall_schedule DROP CONSTRAINT IF EXISTS chk_agent_task_stall_schedule_range;
ALTER TABLE agent_task_stall_schedule ADD CONSTRAINT chk_agent_task_stall_schedule_range CHECK (
  (not_started_minutes IS NULL OR not_started_minutes BETWEEN 1 AND 10080) AND
  (no_progress_minutes IS NULL OR no_progress_minutes BETWEEN 1 AND 10080) AND
  (owner_reaction_minutes IS NULL OR owner_reaction_minutes BETWEEN 1 AND 10080) AND
  (assignment_minutes IS NULL OR assignment_minutes BETWEEN 1 AND 10080) AND
  (host_lapse_check_ins IS NULL OR host_lapse_check_ins BETWEEN 2 AND 10) AND
  (session_end_grace_minutes IS NULL OR session_end_grace_minutes BETWEEN 1 AND 1440) AND
  (host_report_timeout_minutes IS NULL OR host_report_timeout_minutes BETWEEN 5 AND 1440)
);
