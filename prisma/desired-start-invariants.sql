-- #4231 (S8 of #4229) — a platform start's reason: only the platform's no-task start of a worker says why, and the one
-- reason is DESIRED_RUNNING (a long-lived worker that should run and has no session, cor:agt:070:05 S7, Proposed).
ALTER TABLE host_operations DROP CONSTRAINT IF EXISTS chk_host_operations_issued_reason;
ALTER TABLE host_operations ADD CONSTRAINT chk_host_operations_issued_reason CHECK (
  issued_reason IS NULL
  OR (issued_reason = 'DESIRED_RUNNING' AND type = 'worker.start' AND issued_by = 'platform' AND NOT (args ? 'taskId'))
);
-- The trip's count: one worker's failed platform starts by finish time.
CREATE INDEX IF NOT EXISTS host_operations_failed_platform_start_idx ON host_operations (worker_id, finished_at)
  WHERE type = 'worker.start' AND issued_by = 'platform' AND status = 'failed';

-- #4231 — start-failing episodes: one per trip, at most ONE open per worker; closed an hour after it opened.
CREATE TABLE IF NOT EXISTS start_failing_episodes (
  id         TEXT PRIMARY KEY,
  app_id     TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE ON UPDATE CASCADE,
  worker_id  TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE ON UPDATE CASCADE,
  event_id   TEXT NOT NULL UNIQUE REFERENCES agent_team_events(id) ON DELETE CASCADE ON UPDATE CASCADE,
  opened_at  TIMESTAMP(3) NOT NULL,
  ended_at   TIMESTAMP(3)
);
CREATE INDEX IF NOT EXISTS start_failing_episodes_app_id_ended_at_idx ON start_failing_episodes (app_id, ended_at);
ALTER TABLE start_failing_episodes DROP CONSTRAINT IF EXISTS chk_start_failing_episodes_shape;
ALTER TABLE start_failing_episodes ADD CONSTRAINT chk_start_failing_episodes_shape CHECK (ended_at IS NULL OR ended_at >= opened_at);
CREATE UNIQUE INDEX IF NOT EXISTS start_failing_episodes_one_open_uniq ON start_failing_episodes (worker_id) WHERE ended_at IS NULL;

-- #1162: the episode's worker column is a typed Worker reference, under the same writer fence as every other one.
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "start_failing_episodes";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "start_failing_episodes"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.worker_id');
