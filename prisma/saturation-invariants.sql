-- #3819 slice 1 (cor:agt:060:15) — the saturation episodes. One source, shared verbatim with migration
-- 20261121190000_saturation_episodes. Idempotent: every statement is IF NOT EXISTS or drop-then-add.
CREATE TABLE IF NOT EXISTS saturation_episodes (
  id        TEXT PRIMARY KEY,
  app_id    TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE ON UPDATE CASCADE,
  family    TEXT NOT NULL,
  tier      TEXT NOT NULL,
  role      TEXT NOT NULL,
  event_id  TEXT NOT NULL REFERENCES agent_team_events(id) ON DELETE CASCADE ON UPDATE CASCADE,
  opened_at TIMESTAMP(3) NOT NULL,
  ended_at  TIMESTAMP(3)
);
-- A unique INDEX, as Prisma models @unique and `db push` builds it, so push and the migration leave the same catalog
-- (no constraint form: nothing names it in ON CONFLICT; compare #4333).
CREATE UNIQUE INDEX IF NOT EXISTS saturation_episodes_event_id_key ON saturation_episodes (event_id);
CREATE INDEX IF NOT EXISTS saturation_episodes_app_id_ended_at_idx ON saturation_episodes (app_id, ended_at);
-- A combination is keyed like agent_match_outcomes: an open dimension is '', the role is lower case.
ALTER TABLE saturation_episodes DROP CONSTRAINT IF EXISTS chk_saturation_episodes_shape;
ALTER TABLE saturation_episodes ADD CONSTRAINT chk_saturation_episodes_shape CHECK (
  (ended_at IS NULL OR ended_at >= opened_at) AND
  tier IN ('', 'high', 'mid', 'low') AND
  role = lower(role)
);
-- One OPEN episode per (App, combination): the race between two passes or instances is decided here.
CREATE UNIQUE INDEX IF NOT EXISTS saturation_episodes_one_open_uniq ON saturation_episodes (app_id, family, tier, role) WHERE ended_at IS NULL;
