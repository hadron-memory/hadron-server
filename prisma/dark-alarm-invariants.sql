-- #2755 — the dark-worker alarm's per-App window: 5 minutes to a day.
ALTER TABLE apps DROP CONSTRAINT IF EXISTS chk_apps_delivery_dark_alarm_window;
ALTER TABLE apps ADD CONSTRAINT chk_apps_delivery_dark_alarm_window CHECK (
  delivery_dark_alarm_window_seconds BETWEEN 300 AND 86400
);

-- #2755 — dark-worker episodes: at most ONE open episode per worker, across both reasons; a reason is one of two.
CREATE TABLE IF NOT EXISTS dark_worker_episodes (
  id         TEXT PRIMARY KEY,
  app_id     TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  worker_id  TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  event_id   TEXT NOT NULL UNIQUE REFERENCES agent_team_events(id) ON DELETE CASCADE,
  reason     TEXT NOT NULL,
  opened_at  TIMESTAMP(3) NOT NULL,
  ended_at   TIMESTAMP(3)
);
CREATE INDEX IF NOT EXISTS dark_worker_episodes_app_id_ended_at_idx ON dark_worker_episodes (app_id, ended_at);
ALTER TABLE dark_worker_episodes DROP CONSTRAINT IF EXISTS chk_dark_worker_episodes_shape;
ALTER TABLE dark_worker_episodes ADD CONSTRAINT chk_dark_worker_episodes_shape CHECK (
  reason IN ('overdue', 'wake-unacked') AND (ended_at IS NULL OR ended_at >= opened_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS dark_worker_episodes_one_open_uniq ON dark_worker_episodes (worker_id) WHERE ended_at IS NULL;
