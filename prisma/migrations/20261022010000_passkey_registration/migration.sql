-- #1631 PR2 / cor:aut:040:02, 07, 08: passkey registration and its safety lifecycle.

CREATE TABLE "passkey_cancel_tokens" (
    "id" TEXT NOT NULL,
    "passkey_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    "used_at" TIMESTAMP(3),

    CONSTRAINT "passkey_cancel_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "passkey_cancel_tokens_passkey_id_key" ON "passkey_cancel_tokens"("passkey_id");
CREATE UNIQUE INDEX "passkey_cancel_tokens_token_hash_key" ON "passkey_cancel_tokens"("token_hash");

ALTER TABLE "passkey_cancel_tokens" ADD CONSTRAINT "passkey_cancel_tokens_passkey_id_fkey"
  FOREIGN KEY ("passkey_id") REFERENCES "passkey_credentials"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A registration ceremony is bound at its options step to who registers and which kind of passkey (cor:aut:040:02),
-- each column set once; finish consumes it. Other ceremony purposes leave these null.
ALTER TABLE "passkey_ceremonies" ADD COLUMN IF NOT EXISTS "user_id" TEXT;
ALTER TABLE "passkey_ceremonies" ADD COLUMN IF NOT EXISTS "kind" TEXT;
ALTER TABLE "passkey_ceremonies" ADD COLUMN IF NOT EXISTS "registration_method" TEXT;
ALTER TABLE "passkey_ceremonies" ADD COLUMN IF NOT EXISTS "sign_in_browser_hash" TEXT;
ALTER TABLE "passkey_ceremonies" ADD COLUMN IF NOT EXISTS "vouch_passkey_id" TEXT;
ALTER TABLE "passkey_ceremonies" ADD COLUMN IF NOT EXISTS "user_handle" BYTEA;
ALTER TABLE "passkey_ceremonies" ADD CONSTRAINT "passkey_ceremonies_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "passkey_ceremonies" ADD CONSTRAINT "passkey_ceremonies_vouch_passkey_id_fkey"
  FOREIGN KEY ("vouch_passkey_id") REFERENCES "passkey_credentials"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Every registration is followed by an email notice (cor:aut:040:02). The outbox row is written in the registering
-- transaction, so a passkey never exists without its notice; a first passkey's carries its cancel token encrypted
-- until sent, then cleared. seen_at records the in-app notice.
CREATE TABLE "passkey_registration_notices" (
    "id" TEXT NOT NULL,
    "passkey_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "cancel_token_enc" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lease_until" TIMESTAMP(3),
    "claim_token" TEXT,
    "sent_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "seen_at" TIMESTAMP(3),

    CONSTRAINT "passkey_registration_notices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "passkey_registration_notices_passkey_id_key" ON "passkey_registration_notices"("passkey_id");
CREATE INDEX "passkey_registration_notices_user_id_idx" ON "passkey_registration_notices"("user_id");
CREATE INDEX "passkey_registration_notices_sent_at_idx" ON "passkey_registration_notices"("sent_at");
ALTER TABLE "passkey_registration_notices" ADD CONSTRAINT "passkey_registration_notices_passkey_id_fkey"
  FOREIGN KEY ("passkey_id") REFERENCES "passkey_credentials"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "passkey_registration_notices" ADD CONSTRAINT "passkey_registration_notices_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- #1631 PR2 / cor:aut:040:07-08: passkey registration lifecycle invariants. One source, shared verbatim with migration
-- 20261022010000_passkey_registration (pinned by src/lib/passkeys/cancel1631.test.ts).

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

-- The registration binding on a ceremony: all or nothing, REGISTER purpose only, consistent with its kind, set once.
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
