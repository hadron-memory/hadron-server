-- #1631 / cor:aut:040:05 and SEC-3: durable public credentials, never deleted.
ALTER TABLE passkey_credentials DROP CONSTRAINT IF EXISTS chk_passkey_shape;
ALTER TABLE passkey_credentials ADD CONSTRAINT chk_passkey_shape CHECK (
  octet_length(credential_id) BETWEEN 1 AND 1023 AND octet_length(public_key) > 0
  AND octet_length(user_handle) = 32 AND algorithm IN (-7, -257)
  -- #1631 PR1b (Eden #10470): the enrollment RP ID is a bare lowercase host, never a URL or a port.
  AND length(enrollment_rp_id) <= 253
  AND enrollment_rp_id ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$'
  AND counter BETWEEN 0 AND 4294967295
  AND transports IS NOT NULL AND (NOT backed_up OR backup_eligible)
  AND (last_used_at IS NULL OR last_used_at >= registered_at)
  AND (revoked_at IS NULL OR revoked_at >= registered_at)
  AND ((window_ends_at IS NULL AND registration_method IS NULL AND window_ended_at IS NULL AND window_outcome IS NULL)
    OR (window_ends_at IS NOT NULL AND window_ends_at >= registered_at + interval '72 hours'
      AND registration_method IS NOT NULL AND registration_method <> ''
      AND ((window_ended_at IS NULL AND window_outcome IS NULL)
        OR (window_ended_at IS NOT NULL AND window_outcome IS NOT NULL AND window_ended_at >= registered_at AND window_outcome IN ('ran-out','ended-early','cancelled')))))
  AND CASE WHEN window_outcome = 'ran-out' THEN window_ended_at >= window_ends_at
    WHEN window_outcome = 'ended-early' THEN window_ended_at < window_ends_at
    WHEN window_outcome = 'cancelled' THEN revoked_at IS NOT NULL AND window_ended_at = revoked_at AND revoked_at < window_ends_at
    ELSE true END
  AND CASE WHEN revoked_at IS NOT NULL AND window_ends_at IS NOT NULL AND revoked_at < window_ends_at
    AND (window_ended_at IS NULL OR window_ended_at > revoked_at)
    THEN window_outcome IS NOT DISTINCT FROM 'cancelled' AND window_ended_at IS NOT DISTINCT FROM revoked_at ELSE true END
  AND (cancelled_at IS NULL AND cancel_ip IS NULL AND cancel_user_agent IS NULL
    OR (cancelled_at IS NOT NULL AND cancel_ip IS NOT NULL AND cancel_user_agent IS NOT NULL
      AND revoked_at IS NOT NULL AND window_outcome IS NOT NULL AND window_ended_at IS NOT NULL
      AND revoked_at = cancelled_at AND window_outcome = 'cancelled' AND window_ended_at = cancelled_at))
);
CREATE OR REPLACE FUNCTION hadron_guard_passkey_credential() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE platform_now timestamp(3) := (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3);
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Passkey credentials are never deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' AND (NEW.window_outcome IS NOT NULL OR NEW.window_ended_at IS NOT NULL
    OR NEW.revoked_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL OR NEW.cancel_ip IS NOT NULL
    OR NEW.cancel_user_agent IS NOT NULL OR NEW.last_used_at IS NOT NULL OR NEW.counter <> 0) THEN
    RAISE EXCEPTION 'Passkey credentials must begin with unused, open lifecycle state' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.registered_at IS DISTINCT FROM platform_now THEN
    RAISE EXCEPTION 'Passkey registration must use the platform clock' USING ERRCODE = '23514';
  END IF;
  IF NEW.revoked_at IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.revoked_at IS NULL) AND NEW.revoked_at IS DISTINCT FROM platform_now THEN
    RAISE EXCEPTION 'Passkey revocation must use the platform clock' USING ERRCODE = '23514';
  END IF;
  IF NEW.cancelled_at IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.cancelled_at IS NULL) AND NEW.cancelled_at IS DISTINCT FROM platform_now THEN
    RAISE EXCEPTION 'Passkey cancellation must use the platform clock' USING ERRCODE = '23514';
  END IF;
  IF NEW.window_ended_at IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.window_ended_at IS NULL) AND NEW.window_ended_at IS DISTINCT FROM platform_now THEN
    RAISE EXCEPTION 'Passkey window closure must use the platform clock' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;
  IF OLD.revoked_at IS NOT NULL AND ROW(NEW.last_used_at,NEW.counter,NEW.backed_up) IS DISTINCT FROM ROW(OLD.last_used_at,OLD.counter,OLD.backed_up) THEN
    RAISE EXCEPTION 'Revoked passkey cannot be used' USING ERRCODE = '23514';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND OLD.cancelled_at IS NULL AND ROW(NEW.cancelled_at,NEW.cancel_ip,NEW.cancel_user_agent) IS DISTINCT FROM ROW(OLD.cancelled_at,OLD.cancel_ip,OLD.cancel_user_agent) THEN
    RAISE EXCEPTION 'Cancel provenance cannot be attached after revocation' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.id,NEW.owner_id,NEW.credential_id,NEW.public_key,NEW.algorithm,NEW.user_handle,NEW.enrollment_rp_id,NEW.registered_at,NEW.backup_eligible,NEW.registration_method,NEW.window_ends_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.owner_id,OLD.credential_id,OLD.public_key,OLD.algorithm,OLD.user_handle,OLD.enrollment_rp_id,OLD.registered_at,OLD.backup_eligible,OLD.registration_method,OLD.window_ends_at) THEN
    RAISE EXCEPTION 'Passkey identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'Passkey revocation is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.window_outcome IS NOT NULL AND ROW(NEW.window_outcome,NEW.window_ended_at) IS DISTINCT FROM ROW(OLD.window_outcome,OLD.window_ended_at) THEN
    RAISE EXCEPTION 'Passkey window outcome is immutable' USING ERRCODE = '23514';
  END IF;
  -- #1631 PR3 / cor:aut:040:05 (#10404): account deletion is the one exception. It erases the cancel IP address and
  -- user agent to '' (once), and only while the owner is deleted; the cancel time stays.
  IF OLD.cancelled_at IS NOT NULL AND ROW(NEW.cancelled_at,NEW.cancel_ip,NEW.cancel_user_agent) IS DISTINCT FROM ROW(OLD.cancelled_at,OLD.cancel_ip,OLD.cancel_user_agent)
    AND NOT (NEW.cancelled_at IS NOT DISTINCT FROM OLD.cancelled_at
      AND (NEW.cancel_ip IS NOT DISTINCT FROM OLD.cancel_ip OR NEW.cancel_ip = '')
      AND (NEW.cancel_user_agent IS NOT DISTINCT FROM OLD.cancel_user_agent OR NEW.cancel_user_agent = '')
      AND EXISTS (SELECT 1 FROM users u WHERE u.id = OLD.owner_id AND u.deleted_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'Passkey cancellation provenance is immutable' USING ERRCODE = '23514';
  END IF;
  -- The label is set at registration and never edited (cor:aut:040:05); account deletion erases it to the fixed text
  -- 'Erased passkey' (Holger, 2026-10-21), once.
  IF NEW.label IS DISTINCT FROM OLD.label
    AND NOT (NEW.label = 'Erased passkey' AND EXISTS (SELECT 1 FROM users u WHERE u.id = OLD.owner_id AND u.deleted_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'Passkey label is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.counter < OLD.counter OR (OLD.last_used_at IS NOT NULL AND (NEW.last_used_at IS NULL OR NEW.last_used_at < OLD.last_used_at)) THEN
    RAISE EXCEPTION 'Passkey use state cannot move backwards' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS passkey_credential_guard ON passkey_credentials;
CREATE TRIGGER passkey_credential_guard BEFORE INSERT OR UPDATE OR DELETE ON passkey_credentials
FOR EACH ROW EXECUTE FUNCTION hadron_guard_passkey_credential();
