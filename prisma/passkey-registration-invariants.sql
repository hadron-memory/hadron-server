-- #1631 PR2 / cor:aut:040:07-08: passkey registration lifecycle invariants. One source, shared verbatim with migration
-- 20261021090000_passkey_registration (pinned by src/lib/passkeys/cancel1631.test.ts).

-- A first passkey's cancel link: one token per first passkey, stored as SHA-256, spent once, never deleted (the
-- cancel itself is recorded on the credential: cancelled_at, cancel_ip, cancel_user_agent).
ALTER TABLE "passkey_cancel_tokens" DROP CONSTRAINT IF EXISTS "chk_passkey_cancel_token_shape";
ALTER TABLE "passkey_cancel_tokens" ADD CONSTRAINT "chk_passkey_cancel_token_shape" CHECK (
  "token_hash" ~ '^[0-9a-f]{64}$' AND ("used_at" IS NULL OR "used_at" >= "created_at")
);
CREATE OR REPLACE FUNCTION hadron_guard_passkey_cancel_token() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE db_now timestamp(3) := (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3);
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Passkey cancel tokens are never deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.used_at IS NOT NULL THEN
      RAISE EXCEPTION 'A cancel token begins unused' USING ERRCODE = '23514';
    END IF;
    NEW.created_at := db_now;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.passkey_id, NEW.token_hash, NEW.created_at) IS DISTINCT FROM ROW(OLD.id, OLD.passkey_id, OLD.token_hash, OLD.created_at) THEN
    RAISE EXCEPTION 'Passkey cancel token identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.used_at IS NOT NULL AND NEW.used_at IS DISTINCT FROM OLD.used_at THEN
    RAISE EXCEPTION 'A cancel token is spent once' USING ERRCODE = '23514';
  END IF;
  IF OLD.used_at IS NULL AND NEW.used_at IS NOT NULL THEN NEW.used_at := db_now; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS passkey_cancel_token_guard ON passkey_cancel_tokens;
CREATE TRIGGER passkey_cancel_token_guard BEFORE INSERT OR UPDATE OR DELETE ON passkey_cancel_tokens
FOR EACH ROW EXECUTE FUNCTION hadron_guard_passkey_cancel_token();
