-- #3997 (S2 of #3991) — App-owned secrets: the widened owner CHECK, the value/owner pairing, versions bound to their
-- App, the append-only event trail with its one-year purge rule, the tombstone, and "no secret outlives its App".
-- Prisma cannot model any of these. One source, shared verbatim with migration 20261114120000_app_secret_versions.

-- The owner types: user, org, app. (#696 narrowed to user/org; D-2026-11-12-001 made an App an owner again.)
ALTER TABLE secrets DROP CONSTRAINT IF EXISTS chk_secret_owner_type;
ALTER TABLE secrets ADD CONSTRAINT chk_secret_owner_type CHECK (owner_type IN ('user', 'org', 'app'));

-- An App row has NO value of its own (its value is its newest version); an org or user row always has one.
ALTER TABLE secrets DROP CONSTRAINT IF EXISTS chk_secret_app_value;
ALTER TABLE secrets ADD CONSTRAINT chk_secret_app_value CHECK ((owner_type = 'app') = (value_encrypted IS NULL));
ALTER TABLE secrets DROP CONSTRAINT IF EXISTS chk_secret_protected_app_only;
ALTER TABLE secrets ADD CONSTRAINT chk_secret_protected_app_only CHECK (owner_type = 'app' OR NOT protected);

ALTER TABLE secret_versions DROP CONSTRAINT IF EXISTS chk_secret_version_shape;
ALTER TABLE secret_versions ADD CONSTRAINT chk_secret_version_shape
  CHECK (version_no >= 1 AND size_bytes >= 0 AND value_encrypted <> '' AND key_version >= 1);

-- A version's App is its secret's owner, and that owner is an App (owner_id is not a foreign key, so a trigger).
CREATE OR REPLACE FUNCTION hadron_secret_version_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM secrets WHERE id = NEW.secret_id AND owner_type = 'app' AND owner_id = NEW.app_id) THEN
    RAISE EXCEPTION 'A secret version belongs to the App that owns its secret' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS secret_version_owner ON secret_versions;
CREATE TRIGGER secret_version_owner BEFORE INSERT OR UPDATE OF secret_id, app_id ON secret_versions
FOR EACH ROW EXECUTE FUNCTION hadron_secret_version_owner();

-- Append-only events. Update is never allowed. Delete is allowed only for the one-year purge (R25): the owner has a
-- tombstone at least a year old and is not a live App.
CREATE OR REPLACE FUNCTION hadron_secret_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND EXISTS (SELECT 1 FROM secret_owner_tombstones t
                 WHERE t.owner_type = OLD.owner_type AND t.owner_id = OLD.owner_id
                   AND t.deleted_at <= (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 year')
     AND NOT EXISTS (SELECT 1 FROM apps a WHERE a.id = OLD.owner_id AND a.deleted_at IS NULL) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Secret events are append-only' USING ERRCODE = '23514';
END $$;
DROP TRIGGER IF EXISTS secret_event_append_only ON secret_events;
CREATE TRIGGER secret_event_append_only BEFORE UPDATE OR DELETE ON secret_events
FOR EACH ROW EXECUTE FUNCTION hadron_secret_event_guard();

-- A tombstone is written once and never updated; it is deleted only after its year, and only when its owner has no
-- events left (the purge deletes it last).
CREATE OR REPLACE FUNCTION hadron_secret_tombstone_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND OLD.deleted_at <= (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 year'
     AND NOT EXISTS (SELECT 1 FROM secret_events e WHERE e.owner_type = OLD.owner_type AND e.owner_id = OLD.owner_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'A secret owner tombstone is written once and kept until its events are purged' USING ERRCODE = '23514';
END $$;
DROP TRIGGER IF EXISTS secret_owner_tombstone_guard ON secret_owner_tombstones;
CREATE TRIGGER secret_owner_tombstone_guard BEFORE UPDATE OR DELETE ON secret_owner_tombstones
FOR EACH ROW EXECUTE FUNCTION hadron_secret_tombstone_guard();

-- R20 + R25: no App row is deleted, by any path (deleteApp's reclaim, account erasure, a URN reclaim), while its secrets
-- or their ciphertext survive. Runs BEFORE the row goes, so the versions are gone before the cascade reaches the
-- restricted key rows. An owner that has events and no tombstone yet gets one now (a soft delete's tombstone stands).
CREATE OR REPLACE FUNCTION hadron_apps_secrets_gone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO secret_owner_tombstones (owner_type, owner_id)
    SELECT 'app', OLD.id WHERE EXISTS (SELECT 1 FROM secret_events WHERE owner_type = 'app' AND owner_id = OLD.id)
    ON CONFLICT DO NOTHING;
  DELETE FROM secrets WHERE owner_type = 'app' AND owner_id = OLD.id;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS apps_secrets_gone ON apps;
CREATE TRIGGER apps_secrets_gone BEFORE DELETE ON apps
FOR EACH ROW EXECUTE FUNCTION hadron_apps_secrets_gone();

-- #1162: the worker and session ids these tables record are typed references, under the same writer fence as every other one.
-- The fence function exists from migration 20261016050000; this file is applied after it.
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "secrets";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "secrets"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.created_by_worker_id', 's:$.created_by_session_id');
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "secret_versions";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "secret_versions"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.written_by_worker_id', 's:$.written_by_session_id');
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "secret_events";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "secret_events"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.worker_id', 's:$.session_id');
