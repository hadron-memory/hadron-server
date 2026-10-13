-- #1632 / cor:dmo:130 (S2b-1): signing requests and append-only signature records.
-- One source of SQL (conventions:append-only-table-trigger): included by
-- post-push.sql, applied by globalSetup, and appended byte-identical to the
-- migration. Every timestamp here comes from the DB clock: clock_timestamp(),
-- not CURRENT_TIMESTAMP, because an edit queued behind a completion's node lock
-- must get a LATER time than the signature it waited for.

ALTER TABLE signing_requests DROP CONSTRAINT IF EXISTS chk_signing_request_shape;
ALTER TABLE signing_requests ADD CONSTRAINT chk_signing_request_shape CHECK (
  state IS NOT NULL AND state IN ('open','completed','declined','expired','stale','withdrawn')
  AND approval_hash ~ '^[0-9a-f]{64}$'
  AND payload_version IN ('hadron-signature-v1','hadron-signature-v3')
  AND revision >= 1
  AND (requester_user_id IS NOT NULL OR requester_app_id IS NOT NULL)
  AND expires_at > created_at
  AND ((state = 'open') = (ended_at IS NULL))
  AND (ended_at IS NULL OR ended_at >= created_at)
);

ALTER TABLE node_signatures DROP CONSTRAINT IF EXISTS chk_node_signature_shape;
ALTER TABLE node_signatures ADD CONSTRAINT chk_node_signature_shape CHECK (
  approval_hash ~ '^[0-9a-f]{64}$'
  AND payload_version IN ('hadron-signature-v1','hadron-signature-v3')
  AND revision >= 1
  AND octet_length(authenticator_data) >= 37
  AND octet_length(client_data_json) > 0
  AND octet_length(signature) > 0
);

-- The DB clock, as the naive-UTC timestamp(3) Prisma maps DateTime to.
CREATE OR REPLACE FUNCTION hadron_signing_now() RETURNS timestamp(3)
LANGUAGE sql VOLATILE AS $$ SELECT (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) $$;

-- Ends every open request of the given nodes: expired (at its deadline) when its
-- lifetime has already passed, otherwise stale (now). Used by the two content
-- and encryption triggers below.
CREATE OR REPLACE FUNCTION hadron_end_open_signing_requests(p_node_ids text[]) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE platform_now timestamp(3) := hadron_signing_now();
BEGIN
  UPDATE signing_requests SET state = 'expired'
   WHERE node_id = ANY(p_node_ids) AND state = 'open' AND expires_at <= platform_now;
  UPDATE signing_requests SET state = 'stale'
   WHERE node_id = ANY(p_node_ids) AND state = 'open';
END $$;

-- Requests: pinned fields immutable, one end, DB-clock times, deleted only with
-- their node (the FK cascade fires after the node row is gone).
CREATE OR REPLACE FUNCTION hadron_guard_signing_request() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE platform_now timestamp(3) := hadron_signing_now();
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM nodes WHERE id = OLD.node_id) THEN
      RAISE EXCEPTION 'Signing requests are kept for the node''s lifetime' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state IS DISTINCT FROM 'open' OR NEW.ended_at IS NOT NULL THEN
      RAISE EXCEPTION 'A signing request begins open' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM nodes n JOIN memories m ON m.id = n.memory_id
                WHERE n.id = NEW.node_id AND m.is_encrypted) THEN
      RAISE EXCEPTION 'Signing is not applicable to encrypted memories' USING ERRCODE = '23514';
    END IF;
    NEW.created_at := platform_now;
    RETURN NEW;
  END IF;
  -- UPDATE
  IF ROW(NEW.id, NEW.node_id, NEW.revision, NEW.approval_hash, NEW.payload_version, NEW.named_signer_id,
         NEW.requester_user_id, NEW.requester_app_id, NEW.requester_worker_id, NEW.requester_session_id,
         NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.node_id, OLD.revision, OLD.approval_hash, OLD.payload_version, OLD.named_signer_id,
         OLD.requester_user_id, OLD.requester_app_id, OLD.requester_worker_id, OLD.requester_session_id,
         OLD.created_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'A signing request''s pinned fields are immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.state <> 'open' THEN
    RAISE EXCEPTION 'A signing request ends exactly once' USING ERRCODE = '23514';
  END IF;
  IF NEW.state = 'open' THEN
    IF NEW.ended_at IS NOT NULL THEN
      RAISE EXCEPTION 'An open signing request has no end time' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.state = 'expired' THEN
    IF platform_now < OLD.expires_at THEN
      RAISE EXCEPTION 'A signing request expires only once its lifetime has passed' USING ERRCODE = '23514';
    END IF;
    NEW.ended_at := OLD.expires_at;
    RETURN NEW;
  END IF;
  IF platform_now >= OLD.expires_at THEN
    -- A system-driven stale end that loses the race with the deadline is, in
    -- truth, an expiry at the deadline. A person's end (withdraw, decline,
    -- complete) is refused instead; the caller re-reads and reports the expiry.
    IF NEW.state = 'stale' THEN
      NEW.state := 'expired';
      NEW.ended_at := OLD.expires_at;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'An expired signing request cannot end any other way' USING ERRCODE = '23514';
  END IF;
  IF NEW.state = 'completed' AND NOT EXISTS (SELECT 1 FROM node_signatures WHERE signing_request_id = NEW.id) THEN
    RAISE EXCEPTION 'A signing request completes only with its signature record' USING ERRCODE = '23514';
  END IF;
  NEW.ended_at := platform_now;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS signing_request_guard ON signing_requests;
CREATE TRIGGER signing_request_guard BEFORE INSERT OR UPDATE OR DELETE ON signing_requests
FOR EACH ROW EXECUTE FUNCTION hadron_guard_signing_request();

-- Signature records: insert-only against an open, unexpired request whose pins
-- they repeat, by the named signer (if any) with their own unrevoked passkey;
-- never updated; deleted only with their node.
CREATE OR REPLACE FUNCTION hadron_guard_node_signature() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  platform_now timestamp(3) := hadron_signing_now();
  req signing_requests%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM nodes WHERE id = OLD.node_id) THEN
      RAISE EXCEPTION 'Signature records are never deleted' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Signature records are append-only' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO req FROM signing_requests WHERE id = NEW.signing_request_id FOR UPDATE;
  IF NOT FOUND OR req.state <> 'open' OR platform_now >= req.expires_at THEN
    RAISE EXCEPTION 'A signature needs an open signing request' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.node_id, NEW.revision, NEW.approval_hash, NEW.payload_version)
     IS DISTINCT FROM ROW(req.node_id, req.revision, req.approval_hash, req.payload_version) THEN
    RAISE EXCEPTION 'A signature must sign exactly what its request pinned' USING ERRCODE = '23514';
  END IF;
  IF req.named_signer_id IS NOT NULL AND NEW.signer_id IS DISTINCT FROM req.named_signer_id THEN
    RAISE EXCEPTION 'Only the named signer may sign this request' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM passkey_credentials
                  WHERE id = NEW.passkey_credential_id AND owner_id = NEW.signer_id AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'A signature needs the signer''s own unrevoked passkey' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM nodes n JOIN memories m ON m.id = n.memory_id
              WHERE n.id = NEW.node_id AND m.is_encrypted) THEN
    RAISE EXCEPTION 'Signing is not applicable to encrypted memories' USING ERRCODE = '23514';
  END IF;
  NEW.verified_at := platform_now;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS node_signature_guard ON node_signatures;
CREATE TRIGGER node_signature_guard BEFORE INSERT OR UPDATE OR DELETE ON node_signatures
FOR EACH ROW EXECUTE FUNCTION hadron_guard_node_signature();

-- The content-change marker, and staleness (#10015): only a change to title
-- (name), abstract or content moves nodes.content_changed_at and ends the
-- node's open requests. Any other write to the marker is reverted, so
-- application code cannot set or rewind it. A node moving into an encrypted
-- memory ends its open requests stale too (#10017; refused until E2, guarded
-- now so E2 cannot forget it). Column-scoped, so ordinary writes (tags,
-- properties, operational fields) never pay for the comparison.
CREATE OR REPLACE FUNCTION hadron_node_content_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.content_changed_at := NULL;
    RETURN NEW;
  END IF;
  IF ROW(NEW.name, NEW.abstract, NEW.content) IS DISTINCT FROM ROW(OLD.name, OLD.abstract, OLD.content) THEN
    NEW.content_changed_at := hadron_signing_now();
    PERFORM hadron_end_open_signing_requests(ARRAY[NEW.id]);
  ELSE
    NEW.content_changed_at := OLD.content_changed_at;
  END IF;
  IF NEW.memory_id IS DISTINCT FROM OLD.memory_id
     AND EXISTS (SELECT 1 FROM memories WHERE id = NEW.memory_id AND is_encrypted) THEN
    PERFORM hadron_end_open_signing_requests(ARRAY[NEW.id]);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS node_content_change_insert ON nodes;
CREATE TRIGGER node_content_change_insert BEFORE INSERT ON nodes
FOR EACH ROW EXECUTE FUNCTION hadron_node_content_change();
DROP TRIGGER IF EXISTS node_content_change ON nodes;
CREATE TRIGGER node_content_change BEFORE UPDATE OF name, abstract, content, content_changed_at, memory_id ON nodes
FOR EACH ROW EXECUTE FUNCTION hadron_node_content_change();

-- A node entering an encrypted memory ends its open requests stale (#10017).
-- Moving in is refused today (E2), so the live route is encrypting the memory
-- in place.
CREATE OR REPLACE FUNCTION hadron_memory_encrypted_signing() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.is_encrypted AND NOT OLD.is_encrypted THEN
    PERFORM hadron_end_open_signing_requests(ARRAY(
      SELECT DISTINCT sr.node_id FROM signing_requests sr JOIN nodes n ON n.id = sr.node_id
       WHERE n.memory_id = NEW.id AND sr.state = 'open'));
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS memory_encrypted_signing ON memories;
CREATE TRIGGER memory_encrypted_signing AFTER UPDATE OF is_encrypted ON memories
FOR EACH ROW EXECUTE FUNCTION hadron_memory_encrypted_signing();
