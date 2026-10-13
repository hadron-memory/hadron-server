-- #1631 / cor:aut:040:05 and SEC-3: durable public credentials, never deleted.
ALTER TABLE passkey_credentials DROP CONSTRAINT IF EXISTS chk_passkey_shape;
ALTER TABLE passkey_credentials ADD CONSTRAINT chk_passkey_shape CHECK (
  octet_length(credential_id) BETWEEN 1 AND 1023 AND octet_length(public_key) > 0
  AND octet_length(user_handle) = 32 AND algorithm IN (-7, -257)
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
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Passkey credentials are never deleted' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.id,NEW.owner_id,NEW.credential_id,NEW.public_key,NEW.algorithm,NEW.user_handle,NEW.registered_at,NEW.backup_eligible,NEW.registration_method,NEW.window_ends_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.owner_id,OLD.credential_id,OLD.public_key,OLD.algorithm,OLD.user_handle,OLD.registered_at,OLD.backup_eligible,OLD.registration_method,OLD.window_ends_at) THEN
    RAISE EXCEPTION 'Passkey identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'Passkey revocation is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.window_outcome IS NOT NULL AND ROW(NEW.window_outcome,NEW.window_ended_at) IS DISTINCT FROM ROW(OLD.window_outcome,OLD.window_ended_at) THEN
    RAISE EXCEPTION 'Passkey window outcome is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.cancelled_at IS NOT NULL AND ROW(NEW.cancelled_at,NEW.cancel_ip,NEW.cancel_user_agent) IS DISTINCT FROM ROW(OLD.cancelled_at,OLD.cancel_ip,OLD.cancel_user_agent) THEN
    RAISE EXCEPTION 'Passkey cancellation provenance is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.counter < OLD.counter OR (OLD.last_used_at IS NOT NULL AND (NEW.last_used_at IS NULL OR NEW.last_used_at < OLD.last_used_at)) THEN
    RAISE EXCEPTION 'Passkey use state cannot move backwards' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS passkey_credential_guard ON passkey_credentials;
CREATE TRIGGER passkey_credential_guard BEFORE UPDATE OR DELETE ON passkey_credentials
FOR EACH ROW EXECUTE FUNCTION hadron_guard_passkey_credential();
