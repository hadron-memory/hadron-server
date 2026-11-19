-- #3350: deliberately no grants are inferred from the old flag, including Apps where it was true.
ALTER TABLE apps DROP COLUMN run_team_snapshot_enabled;
CREATE TABLE app_automation_team_snapshot_grants (
 id TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE ON UPDATE CASCADE,
 trigger_kind TEXT NOT NULL, trigger_id TEXT NOT NULL, granted_by TEXT NOT NULL,
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, revoked_at TIMESTAMP(3), revoked_by TEXT
);
CREATE INDEX automation_team_snapshot_grants_app_created_idx ON app_automation_team_snapshot_grants(app_id, created_at);
CREATE TABLE app_automation_team_snapshot_grant_events (
 id TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE ON UPDATE CASCADE,
 trigger_kind TEXT NOT NULL, trigger_id TEXT NOT NULL, grant_id TEXT NOT NULL, action TEXT NOT NULL,
 actor_user_id TEXT NOT NULL, created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX automation_team_snapshot_events_app_created_idx ON app_automation_team_snapshot_grant_events(app_id, created_at);
CREATE INDEX automation_team_snapshot_events_grant_idx ON app_automation_team_snapshot_grant_events(grant_id);
-- #3350: terminal grants and append-only audit. Shared verbatim with its migration.
ALTER TABLE app_automation_team_snapshot_grants DROP CONSTRAINT IF EXISTS chk_app_automation_team_snapshot_grant_shape;
ALTER TABLE app_automation_team_snapshot_grants ADD CONSTRAINT chk_app_automation_team_snapshot_grant_shape CHECK (
  trigger_kind IN ('SCHEDULE', 'WEBHOOK') AND
  trigger_id <> '' AND
  granted_by <> '' AND
  (revoked_at IS NULL) = (revoked_by IS NULL) AND
  (revoked_by IS NULL OR revoked_by <> '')
);
-- At most one LIVE row per (App, trigger kind, trigger id); a revoked row never blocks a fresh one.
CREATE UNIQUE INDEX IF NOT EXISTS app_automation_team_snapshot_grants_live_uq
  ON app_automation_team_snapshot_grants (app_id, trigger_kind, trigger_id) WHERE revoked_at IS NULL;
CREATE OR REPLACE FUNCTION hadron_guard_app_automation_team_snapshot_grant() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM apps WHERE id = OLD.app_id) THEN
      RAISE EXCEPTION 'App automation team snapshot grants are append-only' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
     AND NEW.id = OLD.id AND NEW.app_id = OLD.app_id AND NEW.trigger_kind = OLD.trigger_kind
     AND NEW.trigger_id = OLD.trigger_id
     AND NEW.granted_by = OLD.granted_by AND NEW.created_at = OLD.created_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'App automation team snapshot grants are append-only' USING ERRCODE = '23514';
END $$;
DROP TRIGGER IF EXISTS app_automation_team_snapshot_grant_guard ON app_automation_team_snapshot_grants;
CREATE TRIGGER app_automation_team_snapshot_grant_guard BEFORE UPDATE OR DELETE ON app_automation_team_snapshot_grants
FOR EACH ROW EXECUTE FUNCTION hadron_guard_app_automation_team_snapshot_grant();

ALTER TABLE app_automation_team_snapshot_grant_events DROP CONSTRAINT IF EXISTS chk_app_automation_team_snapshot_grant_event_shape;
ALTER TABLE app_automation_team_snapshot_grant_events ADD CONSTRAINT chk_app_automation_team_snapshot_grant_event_shape CHECK (
  action IN ('GRANT', 'REVOKE') AND trigger_kind IN ('SCHEDULE', 'WEBHOOK') AND trigger_id <> '' AND
  actor_user_id <> '' AND grant_id <> ''
);
CREATE OR REPLACE FUNCTION hadron_append_only_app_automation_team_snapshot_grant_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM apps WHERE id = OLD.app_id) THEN
      RAISE EXCEPTION 'App automation team snapshot grant events are append-only' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'App automation team snapshot grant events are append-only' USING ERRCODE = '23514';
END $$;
DROP TRIGGER IF EXISTS app_automation_team_snapshot_grant_event_append_only ON app_automation_team_snapshot_grant_events;
CREATE TRIGGER app_automation_team_snapshot_grant_event_append_only BEFORE UPDATE OR DELETE ON app_automation_team_snapshot_grant_events
FOR EACH ROW EXECUTE FUNCTION hadron_append_only_app_automation_team_snapshot_grant_event();
