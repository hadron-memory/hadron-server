-- #4233 (S10 of #4229) — the sweep run record and the stale-sweep episodes. One source, shared verbatim with migration
-- 20261115190000_host_sweep_runs. Idempotent: every statement is IF NOT EXISTS or drop-then-add.
CREATE TABLE IF NOT EXISTS host_sweep_runs (
  id          TEXT PRIMARY KEY,
  app_id      TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE ON UPDATE CASCADE,
  host_id     TEXT NOT NULL,
  run_key     TEXT NOT NULL,
  started_at  TIMESTAMP(3) NOT NULL,
  ended_at    TIMESTAMP(3) NOT NULL,
  mode        "SweepMode" NOT NULL,
  planned     INTEGER NOT NULL,
  applied     INTEGER NOT NULL,
  skipped     INTEGER NOT NULL,
  failed      INTEGER NOT NULL,
  lines       JSONB NOT NULL DEFAULT '[]',
  recorded_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  posted_at   TIMESTAMP(3)
);
CREATE UNIQUE INDEX IF NOT EXISTS host_sweep_runs_run_uniq ON host_sweep_runs (app_id, host_id, run_key);
CREATE INDEX IF NOT EXISTS host_sweep_runs_host_recent_idx ON host_sweep_runs (app_id, host_id, recorded_at DESC);
ALTER TABLE host_sweep_runs DROP CONSTRAINT IF EXISTS chk_host_sweep_runs_shape;
ALTER TABLE host_sweep_runs ADD CONSTRAINT chk_host_sweep_runs_shape CHECK (
  mode <> 'OFF' AND ended_at >= started_at AND
  planned >= 0 AND applied >= 0 AND skipped >= 0 AND failed >= 0 AND
  host_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
  run_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$' AND
  jsonb_typeof(lines) = 'array' AND jsonb_array_length(lines) <= 50
);

CREATE TABLE IF NOT EXISTS host_sweep_episodes (
  id        TEXT PRIMARY KEY,
  app_id    TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE ON UPDATE CASCADE,
  host_id   TEXT NOT NULL,
  event_id  TEXT NOT NULL UNIQUE REFERENCES agent_team_events(id) ON DELETE CASCADE ON UPDATE CASCADE,
  opened_at TIMESTAMP(3) NOT NULL,
  ended_at  TIMESTAMP(3)
);
CREATE INDEX IF NOT EXISTS host_sweep_episodes_app_id_ended_at_idx ON host_sweep_episodes (app_id, ended_at);
ALTER TABLE host_sweep_episodes DROP CONSTRAINT IF EXISTS chk_host_sweep_episodes_shape;
ALTER TABLE host_sweep_episodes ADD CONSTRAINT chk_host_sweep_episodes_shape CHECK (ended_at IS NULL OR ended_at >= opened_at);
CREATE UNIQUE INDEX IF NOT EXISTS host_sweep_episodes_one_open_uniq ON host_sweep_episodes (app_id, host_id) WHERE ended_at IS NULL;
