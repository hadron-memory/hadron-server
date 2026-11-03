-- #2763 — coordinator-cadence episodes: at most ONE open episode per coordinator, and an episode never ends before it opens.
CREATE TABLE IF NOT EXISTS coordinator_cadence_episodes (
  id         TEXT PRIMARY KEY,
  app_id     TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE ON UPDATE CASCADE,
  worker_id  TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE ON UPDATE CASCADE,
  event_id   TEXT NOT NULL UNIQUE REFERENCES agent_team_events(id) ON DELETE CASCADE ON UPDATE CASCADE,
  opened_at  TIMESTAMP(3) NOT NULL,
  ended_at   TIMESTAMP(3)
);
CREATE INDEX IF NOT EXISTS coordinator_cadence_episodes_app_id_ended_at_idx ON coordinator_cadence_episodes (app_id, ended_at);
ALTER TABLE coordinator_cadence_episodes DROP CONSTRAINT IF EXISTS chk_coordinator_cadence_episodes_shape;
ALTER TABLE coordinator_cadence_episodes ADD CONSTRAINT chk_coordinator_cadence_episodes_shape CHECK (ended_at IS NULL OR ended_at >= opened_at);
CREATE UNIQUE INDEX IF NOT EXISTS coordinator_cadence_episodes_one_open_uniq ON coordinator_cadence_episodes (worker_id) WHERE ended_at IS NULL;

-- #2763 — the evaluator's first-observed row per coordinator.
CREATE TABLE IF NOT EXISTS coordinator_cadence_clocks (
  worker_id   TEXT PRIMARY KEY REFERENCES workers(id) ON DELETE CASCADE ON UPDATE CASCADE,
  app_id      TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE ON UPDATE CASCADE,
  observed_at TIMESTAMP(3) NOT NULL
);

-- #1162: both tables carry a typed Worker reference, so both sit under the writer fence (the function is #1162's).
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "coordinator_cadence_episodes";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "coordinator_cadence_episodes"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.worker_id');
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "coordinator_cadence_clocks";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "coordinator_cadence_clocks"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.worker_id');
