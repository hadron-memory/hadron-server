-- #4531 (cor:agt:050:34) — the dark-team episodes. One source, shared verbatim with migration
-- 20261124120000_team_dark_episodes. Idempotent: every statement is IF NOT EXISTS or drop-then-add.
CREATE TABLE IF NOT EXISTS team_dark_episodes (
  id                 TEXT PRIMARY KEY,
  app_id             TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE ON UPDATE CASCADE,
  event_id           TEXT NOT NULL REFERENCES agent_team_events(id) ON DELETE CASCADE ON UPDATE CASCADE,
  recovered_event_id TEXT REFERENCES agent_team_events(id) ON DELETE CASCADE ON UPDATE CASCADE,
  opened_at          TIMESTAMP(3) NOT NULL,
  ended_at           TIMESTAMP(3)
);
-- Unique INDEXES, as Prisma models @unique and `db push` builds them, so push and the migration leave the same catalog.
CREATE UNIQUE INDEX IF NOT EXISTS team_dark_episodes_event_id_key ON team_dark_episodes (event_id);
CREATE UNIQUE INDEX IF NOT EXISTS team_dark_episodes_recovered_event_id_key ON team_dark_episodes (recovered_event_id);
CREATE INDEX IF NOT EXISTS team_dark_episodes_app_id_ended_at_idx ON team_dark_episodes (app_id, ended_at);
-- A recovered episode is ended (an episode that ended with its App has no recovered event); an end is never before its open.
ALTER TABLE team_dark_episodes DROP CONSTRAINT IF EXISTS chk_team_dark_episodes_shape;
ALTER TABLE team_dark_episodes ADD CONSTRAINT chk_team_dark_episodes_shape CHECK (
  (ended_at IS NULL OR ended_at >= opened_at) AND
  (recovered_event_id IS NULL OR ended_at IS NOT NULL)
);
-- One OPEN episode per App: the race between two passes or instances is decided here.
CREATE UNIQUE INDEX IF NOT EXISTS team_dark_episodes_one_open_uniq ON team_dark_episodes (app_id) WHERE ended_at IS NULL;
