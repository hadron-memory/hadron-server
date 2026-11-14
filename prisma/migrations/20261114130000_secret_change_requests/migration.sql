-- Any committed secret mutation invalidates earlier proposals, including same-millisecond changes.
ALTER TABLE secrets ADD COLUMN IF NOT EXISTS change_revision integer NOT NULL DEFAULT 0;
CREATE OR REPLACE FUNCTION hadron_secret_change_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.change_revision := OLD.change_revision + 1; RETURN NEW; END $$;
DROP TRIGGER IF EXISTS secret_change_revision ON secrets;
CREATE TRIGGER secret_change_revision BEFORE UPDATE ON secrets FOR EACH ROW EXECUTE FUNCTION hadron_secret_change_revision();
-- #3999: staged values are request-bound; terminal requests retain no ciphertext.
CREATE TABLE secret_change_requests (
 id text PRIMARY KEY,
 app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE ON UPDATE CASCADE,
 secret_id text,
 secret_name text NOT NULL,
 secret_kind text NOT NULL,
 metadata jsonb NOT NULL,
 operation text NOT NULL,
 requester_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
 state text NOT NULL DEFAULT 'open',
 snapshot text NOT NULL,
 staged_value_encrypted text,
 key_version integer,
 size_bytes integer,
 protected_result boolean,
 write_version boolean NOT NULL DEFAULT true,
 created_at timestamp(3) NOT NULL DEFAULT (clock_timestamp() AT TIME ZONE 'UTC'),
 expires_at timestamp(3) NOT NULL,
 ended_at timestamp(3)
);
ALTER TABLE secret_change_requests DROP CONSTRAINT IF EXISTS chk_secret_change_shape;
ALTER TABLE secret_change_requests ADD CONSTRAINT chk_secret_change_shape CHECK (
 operation IN ('STORE','DELETE','SET_PROTECTED','CLEAR_PROTECTED') AND
 state IN ('open','completed','declined','expired','withdrawn','stale') AND
 ((staged_value_encrypted IS NULL) OR (operation = 'STORE' AND state = 'open' AND key_version IS NOT NULL)) AND
 ((state = 'open') = (ended_at IS NULL))
);
CREATE INDEX secret_change_requests_secret_open ON secret_change_requests(app_id,secret_name,state);
CREATE INDEX secret_change_requests_expiry ON secret_change_requests(expires_at) WHERE state = 'open';
CREATE FUNCTION hadron_guard_secret_change_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'UPDATE' THEN
  IF OLD.state <> 'open' OR
    (NEW.id,NEW.app_id,NEW.secret_id,NEW.secret_name,NEW.secret_kind,NEW.metadata,NEW.operation,NEW.requester_id,NEW.snapshot,NEW.created_at,NEW.expires_at,NEW.key_version,NEW.size_bytes,NEW.protected_result,NEW.write_version)
    IS DISTINCT FROM
    (OLD.id,OLD.app_id,OLD.secret_id,OLD.secret_name,OLD.secret_kind,OLD.metadata,OLD.operation,OLD.requester_id,OLD.snapshot,OLD.created_at,OLD.expires_at,OLD.key_version,OLD.size_bytes,OLD.protected_result,OLD.write_version)
  THEN RAISE EXCEPTION 'secret change request immutable'; END IF;
  IF NEW.state = 'open' AND NEW.staged_value_encrypted IS DISTINCT FROM OLD.staged_value_encrypted
  THEN RAISE EXCEPTION 'secret change request immutable'; END IF;
 END IF;
 IF NEW.state <> 'open' THEN NEW.staged_value_encrypted := NULL; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER secret_change_requests_guard BEFORE INSERT OR UPDATE ON secret_change_requests
 FOR EACH ROW EXECUTE FUNCTION hadron_guard_secret_change_request();
-- External deletion (App deletion, auto-delete) must not leave staged copies behind.
CREATE FUNCTION hadron_end_deleted_secret_changes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE secret_change_requests SET state='stale',ended_at=(clock_timestamp() AT TIME ZONE 'UTC')
 WHERE secret_id=OLD.id AND state='open';
 RETURN OLD;
END $$;
CREATE TRIGGER secret_changes_secret_deleted AFTER DELETE ON secrets FOR EACH ROW EXECUTE FUNCTION hadron_end_deleted_secret_changes();
CREATE FUNCTION hadron_clear_deleted_app_changes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN DELETE FROM secret_change_requests WHERE app_id=NEW.id; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER secret_changes_app_deleted AFTER UPDATE OF deleted_at ON apps FOR EACH ROW EXECUTE FUNCTION hadron_clear_deleted_app_changes();
