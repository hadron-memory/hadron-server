-- #2484 (cor:agt:010:01): an App's prefix-scoped write grant for its userless runs.
-- One source, shared verbatim with migration 20261027010000_app_memory_write_grants
-- (pinned by src/lib/appWriteGrant.test.ts) and applied by post-push.sql and the test
-- globalSetup.
--
-- A grant row is never edited: it ends once, by a terminal `revoked_at` stamped together
-- with `revoked_by`, and nothing else about it changes. A DELETE is refused unless the App
-- or the memory is already gone, which is the only way one happens (the ON DELETE CASCADE of
-- a hard delete). TRUNCATE fires no row trigger; it is the TEST-ONLY cleanup path
-- (src/test/helpers.ts cleanDb).
--
-- The prefix is REQUIRED and is a loc: segments of [A-Za-z0-9._-] that start and end
-- alphanumeric (src/lib/validateLoc.ts SEGMENT_RE), joined by single colons. An empty prefix
-- would be a memory-wide grant, which this table must not be able to express.
ALTER TABLE app_memory_write_grants DROP CONSTRAINT IF EXISTS chk_app_memory_write_grant_shape;
ALTER TABLE app_memory_write_grants ADD CONSTRAINT chk_app_memory_write_grant_shape CHECK (
  prefix ~ '^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?(:[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?)*$' AND
  granted_by <> '' AND
  (revoked_at IS NULL) = (revoked_by IS NULL) AND
  (revoked_by IS NULL OR revoked_by <> '')
);
-- At most one LIVE row per (App, memory, prefix): a second grant of the same thing is the
-- same grant; a revoked row never blocks a fresh one.
CREATE UNIQUE INDEX IF NOT EXISTS app_memory_write_grants_live_uq
  ON app_memory_write_grants (app_id, memory_id, prefix) WHERE revoked_at IS NULL;
CREATE OR REPLACE FUNCTION hadron_guard_app_memory_write_grant() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM apps WHERE id = OLD.app_id)
       AND EXISTS (SELECT 1 FROM memories WHERE id = OLD.memory_id) THEN
      RAISE EXCEPTION 'App memory write grants are append-only' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
     AND NEW.id = OLD.id AND NEW.app_id = OLD.app_id AND NEW.memory_id = OLD.memory_id
     AND NEW.prefix = OLD.prefix AND NEW.register_node_urn IS NOT DISTINCT FROM OLD.register_node_urn
     AND NEW.granted_by = OLD.granted_by AND NEW.created_at = OLD.created_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'App memory write grants are append-only' USING ERRCODE = '23514';
END $$;
DROP TRIGGER IF EXISTS app_memory_write_grant_guard ON app_memory_write_grants;
CREATE TRIGGER app_memory_write_grant_guard BEFORE UPDATE OR DELETE ON app_memory_write_grants
FOR EACH ROW EXECUTE FUNCTION hadron_guard_app_memory_write_grant();

ALTER TABLE app_memory_write_grant_events DROP CONSTRAINT IF EXISTS chk_app_memory_write_grant_event_shape;
ALTER TABLE app_memory_write_grant_events ADD CONSTRAINT chk_app_memory_write_grant_event_shape CHECK (
  action IN ('GRANT', 'REVOKE') AND prefix <> '' AND actor_user_id <> '' AND grant_id <> '' AND memory_id <> ''
);
CREATE OR REPLACE FUNCTION hadron_append_only_app_memory_write_grant_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM apps WHERE id = OLD.app_id) THEN
      RAISE EXCEPTION 'App memory write grant events are append-only' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'App memory write grant events are append-only' USING ERRCODE = '23514';
END $$;
DROP TRIGGER IF EXISTS app_memory_write_grant_event_append_only ON app_memory_write_grant_events;
CREATE TRIGGER app_memory_write_grant_event_append_only BEFORE UPDATE OR DELETE ON app_memory_write_grant_events
FOR EACH ROW EXECUTE FUNCTION hadron_append_only_app_memory_write_grant_event();
