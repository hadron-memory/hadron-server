-- #5001 (cor:acl:140:07, :09; ruling 0255 item 19): one passkey touch over a SELECTION of one App's pending grants. One source of
-- SQL (conventions:append-only-table-trigger): included by post-push.sql AFTER grant-signing-invariants.sql and appended
-- byte-identical to migration 20261125130000_grant_selection_signing (pinned by src/lib/signing/grantSelection5001.test.ts).
-- Every timestamp is the DB clock (hadron_signing_now(), prisma/signing-invariants.sql).
--
-- A selection is one row; each of its grants is an ITEM, an ordinary grant_signing_requests row with selection_id set (so the
-- per-grant stale trigger and the activation guard in grant-invariants.sql stay per grant and unchanged). A selection begins
-- open and ends exactly once. When it ends, the items still open end with it (completed: stale; the others: the selection's own
-- end). The touch record (grant_selection_signatures) is insert-only against an open, unexpired selection, by the signer's own
-- unrevoked passkey, and keeps the signed item list: every item must be one of the selection's item requests at the version and
-- terms hash that request pinned, in ascending grant id, at most the cap. Both tables are deleted only with their App.
-- TRUNCATE fires no row trigger; it is the TEST-ONLY cleanup path (src/test/helpers.ts cleanDb).

ALTER TABLE grant_signing_selections DROP CONSTRAINT IF EXISTS chk_grant_signing_selection_shape;
ALTER TABLE grant_signing_selections ADD CONSTRAINT chk_grant_signing_selection_shape CHECK (
  id ~ '^[A-Za-z0-9_-]{22}$'
  AND state IS NOT NULL AND state IN ('open','completed','declined','expired','withdrawn')
  AND payload_version IN ('hadron-grant-selection-signature-v1')
  AND (requester_user_id IS NOT NULL OR requester_app_id IS NOT NULL)
  AND (requester_user_id IS NULL OR requester_user_id <> '')
  AND (requester_app_id IS NULL OR requester_app_id <> '')
  AND expires_at > created_at
  AND ((state = 'open') = (ended_at IS NULL))
  AND (ended_at IS NULL OR ended_at >= created_at)
);

ALTER TABLE grant_selection_signatures DROP CONSTRAINT IF EXISTS chk_grant_selection_signature_shape;
ALTER TABLE grant_selection_signatures ADD CONSTRAINT chk_grant_selection_signature_shape CHECK (
  payload_version IN ('hadron-grant-selection-signature-v1')
  AND signer_id <> ''
  AND jsonb_typeof(items) = 'array'
  AND jsonb_array_length(items) BETWEEN 1 AND 25
  AND rp_id IS NOT NULL AND rp_id <> ''
  AND octet_length(authenticator_data) >= 37
  AND substring(authenticator_data FROM 1 FOR 32) = sha256(convert_to(rp_id, 'UTF8'))
  AND octet_length(client_data_json) > 0
  AND octet_length(signature) > 0
);

-- Selections: begin open, pinned fields immutable, one end, DB-clock times, deleted only with their App.
CREATE OR REPLACE FUNCTION hadron_guard_grant_signing_selection() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  platform_now timestamp(3) := hadron_signing_now();
  lifetime interval;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM apps WHERE id = OLD.app_id) THEN
      RAISE EXCEPTION 'Grant signing selections are kept for the App''s lifetime' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state IS DISTINCT FROM 'open' OR NEW.ended_at IS NOT NULL THEN
      RAISE EXCEPTION 'A grant signing selection begins open' USING ERRCODE = '23514';
    END IF;
    -- The inserter states both times from ONE clock read; the lifetime is their difference, and the start is re-stamped here.
    lifetime := NEW.expires_at - NEW.created_at;
    NEW.created_at := platform_now;
    NEW.expires_at := platform_now + lifetime;
    RETURN NEW;
  END IF;
  -- UPDATE
  IF ROW(NEW.id, NEW.app_id, NEW.payload_version, NEW.requester_user_id, NEW.requester_app_id, NEW.requester_worker_id,
         NEW.requester_session_id, NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.app_id, OLD.payload_version, OLD.requester_user_id, OLD.requester_app_id, OLD.requester_worker_id,
         OLD.requester_session_id, OLD.created_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'A grant signing selection''s pinned fields are immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.state <> 'open' THEN
    RAISE EXCEPTION 'A grant signing selection ends exactly once' USING ERRCODE = '23514';
  END IF;
  IF NEW.state = 'open' THEN
    IF NEW.ended_at IS NOT NULL THEN
      RAISE EXCEPTION 'An open grant signing selection has no end time' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.state = 'expired' THEN
    IF platform_now < OLD.expires_at THEN
      RAISE EXCEPTION 'A grant signing selection expires only once its lifetime has passed' USING ERRCODE = '23514';
    END IF;
    NEW.ended_at := OLD.expires_at;
    RETURN NEW;
  END IF;
  IF platform_now >= OLD.expires_at THEN
    RAISE EXCEPTION 'An expired grant signing selection cannot end any other way' USING ERRCODE = '23514';
  END IF;
  IF NEW.state = 'completed' AND NOT EXISTS (SELECT 1 FROM grant_selection_signatures WHERE selection_id = NEW.id) THEN
    RAISE EXCEPTION 'A grant signing selection completes only with its touch record' USING ERRCODE = '23514';
  END IF;
  NEW.ended_at := platform_now;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS grant_signing_selection_guard ON grant_signing_selections;
CREATE TRIGGER grant_signing_selection_guard BEFORE INSERT OR UPDATE OR DELETE ON grant_signing_selections
FOR EACH ROW EXECUTE FUNCTION hadron_guard_grant_signing_selection();

-- When a selection ends, the items still open end with it (ruling R6: a new request is needed for what did not activate). A
-- completed selection leaves its failed items stale; the other ends carry through; an expiry ends them at the same deadline.
CREATE OR REPLACE FUNCTION hadron_end_selection_items() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.state = 'open' AND NEW.state <> 'open' THEN
    UPDATE grant_signing_requests
       SET state = CASE WHEN NEW.state = 'completed' THEN 'stale' ELSE NEW.state END
     WHERE selection_id = NEW.id AND state = 'open';
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS grant_signing_selection_end_items ON grant_signing_selections;
CREATE TRIGGER grant_signing_selection_end_items AFTER UPDATE OF state ON grant_signing_selections
FOR EACH ROW EXECUTE FUNCTION hadron_end_selection_items();

-- Touch records: insert-only against an open, unexpired selection, by the signer's own unrevoked passkey, over items that are
-- exactly some of the selection's item requests at their pins, ascending by grant id; never updated; deleted only with the App.
CREATE OR REPLACE FUNCTION hadron_guard_grant_selection_signature() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  platform_now timestamp(3);
  sel grant_signing_selections%ROWTYPE;
  prev text := NULL;
  item jsonb;
  gid text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM grant_signing_selections WHERE id = OLD.selection_id) THEN
      RAISE EXCEPTION 'Grant selection signature records are never deleted' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Grant selection signature records are append-only' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO sel FROM grant_signing_selections WHERE id = NEW.selection_id FOR UPDATE;
  platform_now := hadron_signing_now();
  IF NOT FOUND OR sel.state <> 'open' OR platform_now >= sel.expires_at THEN
    RAISE EXCEPTION 'A selection signature needs an open signing selection' USING ERRCODE = '23514';
  END IF;
  IF NEW.payload_version IS DISTINCT FROM sel.payload_version THEN
    RAISE EXCEPTION 'A selection signature must sign exactly what its selection pinned' USING ERRCODE = '23514';
  END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(NEW.items) LOOP
    IF jsonb_typeof(item) <> 'object' OR (SELECT count(*) FROM jsonb_object_keys(item)) <> 3
       OR jsonb_typeof(item -> 'grantId') <> 'string' OR jsonb_typeof(item -> 'version') <> 'number'
       OR jsonb_typeof(item -> 'termsHash') <> 'string' THEN
      RAISE EXCEPTION 'A selection signature item is a grant id, a version and a terms hash' USING ERRCODE = '23514';
    END IF;
    gid := item ->> 'grantId';
    -- Strictly ascending by byte order of the id (the order the payload is built in): no duplicate, no reordering.
    IF prev IS NOT NULL AND convert_to(gid, 'UTF8') <= convert_to(prev, 'UTF8') THEN
      RAISE EXCEPTION 'A selection signature lists its items in ascending grant id, once each' USING ERRCODE = '23514';
    END IF;
    prev := gid;
    IF NOT EXISTS (SELECT 1 FROM grant_signing_requests r
                    WHERE r.selection_id = NEW.selection_id AND r.grant_id = gid
                      AND r.version = (item ->> 'version')::int AND r.terms_hash = item ->> 'termsHash'
                      AND r.payload_version = sel.payload_version) THEN
      RAISE EXCEPTION 'A selection signature item must be an item of its selection at its pinned terms' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM passkey_credentials
                  WHERE id = NEW.passkey_credential_id AND owner_id = NEW.signer_id AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'A selection signature needs the signer''s own unrevoked passkey' USING ERRCODE = '23514';
  END IF;
  NEW.verified_at := platform_now;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS grant_selection_signature_guard ON grant_selection_signatures;
CREATE TRIGGER grant_selection_signature_guard BEFORE INSERT OR UPDATE OR DELETE ON grant_selection_signatures
FOR EACH ROW EXECUTE FUNCTION hadron_guard_grant_selection_signature();

-- #5001: the selection's FK-free requester worker and session ids join the closed #1162 fence inventory (this file's own entry in
-- src/lib/workerReferenceFence1162.test.ts laterFences).
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "grant_signing_selections";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "grant_signing_selections"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.requester_worker_id', 's:$.requester_session_id');
