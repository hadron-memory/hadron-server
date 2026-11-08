-- #1631 PR2 / cor:aut:040:07-08: passkey registration lifecycle invariants. One source, shared verbatim with migration
-- 20261022030000_passkey_revoke (pinned by src/lib/passkeys/cancel1631.test.ts).

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

-- The binding on a ceremony: all or nothing, consistent with its purpose and kind, set once.
ALTER TABLE "passkey_ceremonies" DROP CONSTRAINT IF EXISTS "chk_passkey_ceremony_registration";
ALTER TABLE "passkey_ceremonies" ADD CONSTRAINT "chk_passkey_ceremony_registration" CHECK (
  ("user_id" IS NULL AND "kind" IS NULL AND "registration_method" IS NULL AND "sign_in_browser_hash" IS NULL
    AND "vouch_passkey_id" IS NULL AND "user_handle" IS NULL)
  OR ("purpose" = 'REGISTER' AND "user_id" IS NOT NULL AND "user_handle" IS NOT NULL AND octet_length("user_handle") = 32
    AND (("kind" IS NOT NULL AND "kind" = 'first' AND "registration_method" IS NOT NULL
          AND "registration_method" IN ('github', 'google', 'apple', 'email')
          AND "sign_in_browser_hash" IS NOT NULL AND "sign_in_browser_hash" ~ '^[0-9a-f]{64}$' AND "vouch_passkey_id" IS NULL)
      OR ("kind" IS NOT NULL AND "kind" = 'later' AND "vouch_passkey_id" IS NOT NULL
          AND "registration_method" IS NULL AND "sign_in_browser_hash" IS NULL)))
  -- #1631 PR3 (cor:aut:040:08): a REVOKE ceremony is bound to its owner by the proof: another passkey's assertion
  -- (the prover, never revocable by its own ceremony) or this browser's fresh identity-provider sign-in, never a
  -- magic link. It carries no WebAuthn user handle.
  OR ("purpose" = 'REVOKE' AND "user_id" IS NOT NULL AND "kind" IS NOT NULL AND "kind" = 'revoke' AND "user_handle" IS NULL
    AND (("vouch_passkey_id" IS NOT NULL AND "registration_method" IS NULL AND "sign_in_browser_hash" IS NULL)
      OR ("vouch_passkey_id" IS NULL AND "registration_method" IS NOT NULL AND "registration_method" IN ('github', 'google', 'apple')
        AND "sign_in_browser_hash" IS NOT NULL AND "sign_in_browser_hash" ~ '^[0-9a-f]{64}$')))
  -- #1632 S2b-2 (cor:dmo:130:08): a SIGN ceremony is bound to the person the proof ceremony proved, set once. It
  -- carries no registration field. The proof ceremony itself (SIGN_PROOF) is never bound: it is spent proving.
  OR ("purpose" = 'SIGN' AND "user_id" IS NOT NULL AND "kind" IS NOT NULL AND "kind" = 'sign' AND "registration_method" IS NULL
    AND "sign_in_browser_hash" IS NULL AND "vouch_passkey_id" IS NULL AND "user_handle" IS NULL)
);
CREATE OR REPLACE FUNCTION hadron_guard_passkey_ceremony_binding() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.user_id IS NOT NULL AND ROW(NEW.user_id, NEW.kind, NEW.registration_method, NEW.sign_in_browser_hash, NEW.vouch_passkey_id, NEW.user_handle)
    IS DISTINCT FROM ROW(OLD.user_id, OLD.kind, OLD.registration_method, OLD.sign_in_browser_hash, OLD.vouch_passkey_id, OLD.user_handle) THEN
    RAISE EXCEPTION 'A registration ceremony is bound once' USING ERRCODE = '23514';
  END IF;
  IF OLD.consumed_at IS NOT NULL AND OLD.user_id IS NULL AND NEW.user_id IS NOT NULL THEN
    RAISE EXCEPTION 'A consumed ceremony cannot be bound' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS passkey_ceremony_binding_guard ON passkey_ceremonies;
CREATE TRIGGER passkey_ceremony_binding_guard BEFORE UPDATE ON passkey_ceremonies
FOR EACH ROW EXECUTE FUNCTION hadron_guard_passkey_ceremony_binding();

-- Notice outbox: a first passkey's notice carries a cancel token until it is sent; a later one's never does.
ALTER TABLE "passkey_registration_notices" DROP CONSTRAINT IF EXISTS "chk_passkey_registration_notice_shape";
ALTER TABLE "passkey_registration_notices" ADD CONSTRAINT "chk_passkey_registration_notice_shape" CHECK (
  "kind" IN ('first', 'later') AND "attempts" >= 0
  AND ("kind" = 'first' OR "cancel_token_enc" IS NULL)
  AND ("kind" = 'later' OR "sent_at" IS NOT NULL OR "failed_at" IS NOT NULL OR "cancel_token_enc" IS NOT NULL)
  AND ("sent_at" IS NULL OR "failed_at" IS NULL)
);
CREATE OR REPLACE FUNCTION hadron_guard_passkey_registration_notice() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Passkey registration notices are never deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND ROW(NEW.id, NEW.passkey_id, NEW.user_id, NEW.kind, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.passkey_id, OLD.user_id, OLD.kind, OLD.created_at) THEN
    RAISE EXCEPTION 'Passkey registration notice identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND ((OLD.sent_at IS NOT NULL AND NEW.sent_at IS DISTINCT FROM OLD.sent_at)
    OR (OLD.seen_at IS NOT NULL AND NEW.seen_at IS DISTINCT FROM OLD.seen_at)
    OR (OLD.cancel_token_enc IS NULL AND NEW.cancel_token_enc IS NOT NULL)) THEN
    RAISE EXCEPTION 'Passkey registration notice delivery is set once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS passkey_registration_notice_guard ON passkey_registration_notices;
CREATE TRIGGER passkey_registration_notice_guard BEFORE UPDATE OR DELETE ON passkey_registration_notices
FOR EACH ROW EXECUTE FUNCTION hadron_guard_passkey_registration_notice();
