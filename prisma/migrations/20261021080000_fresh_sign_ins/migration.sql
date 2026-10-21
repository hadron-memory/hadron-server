-- #1631 PR1b slice 2 / cor:aut:040:09: a fresh sign-in bound to the ceremony browser. It signs the person in to
-- nothing: no session, no handoff code. A row counts only once the same browser has confirmed it, and is spent once.

-- A pending IdP login started by the ceremony leg carries the ceremony browser's nonce hash. Such a state never
-- carries the portal's handoff fields, so a claimed state is either a login or a ceremony leg, never both.
ALTER TABLE "pending_login_states" ADD COLUMN IF NOT EXISTS "ceremony_nonce_hash" TEXT;

CREATE TABLE "fresh_sign_ins" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "browser_nonce_hash" TEXT NOT NULL,
    "leg_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "signed_in_at" TIMESTAMP(3),
    "confirmed_at" TIMESTAMP(3),
    "consumed_at" TIMESTAMP(3),
    "consumed_for" TEXT,

    CONSTRAINT "fresh_sign_ins_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "fresh_sign_ins_leg_hash_key" ON "fresh_sign_ins"("leg_hash");
CREATE INDEX "fresh_sign_ins_browser_nonce_hash_idx" ON "fresh_sign_ins"("browser_nonce_hash");
CREATE INDEX "fresh_sign_ins_created_at_idx" ON "fresh_sign_ins"("created_at");

ALTER TABLE "fresh_sign_ins" ADD CONSTRAINT "fresh_sign_ins_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- #1631 PR1b slice 2 / cor:aut:040:09: fresh-sign-in invariants. One source, shared verbatim with migration
-- 20261021080000_fresh_sign_ins (pinned by src/lib/passkeys/freshSignIn1631.test.ts).
ALTER TABLE "pending_login_states" DROP CONSTRAINT IF EXISTS "chk_pending_login_ceremony";
ALTER TABLE "pending_login_states" ADD CONSTRAINT "chk_pending_login_ceremony" CHECK (
  "ceremony_nonce_hash" IS NULL
  OR ("ceremony_nonce_hash" ~ '^[0-9a-f]{64}$' AND "return_to" IS NULL AND "client_state" IS NULL)
);

ALTER TABLE "fresh_sign_ins" DROP CONSTRAINT IF EXISTS "chk_fresh_sign_in_shape";
ALTER TABLE "fresh_sign_ins" ADD CONSTRAINT "chk_fresh_sign_in_shape" CHECK (
  "method" IN ('github', 'google', 'apple', 'email')
  AND "browser_nonce_hash" ~ '^[0-9a-f]{64}$' AND "leg_hash" ~ '^[0-9a-f]{64}$'
  AND "expires_at" > "created_at"
  -- An IdP leg is proved at its callback; the email leg is proved at the confirming POST, so it has no
  -- sign-in time until then.
  AND ("method" = 'email' OR "signed_in_at" IS NOT NULL)
  AND ("confirmed_at" IS NULL OR ("signed_in_at" IS NOT NULL AND "confirmed_at" >= "signed_in_at"))
  AND (("consumed_at" IS NULL AND "consumed_for" IS NULL)
    OR ("consumed_at" IS NOT NULL AND "confirmed_at" IS NOT NULL AND "consumed_at" >= "confirmed_at"
      AND "consumed_for" IS NOT NULL AND "consumed_for" IN ('register', 'end-window', 'revoke')))
  -- cor:aut:040:09: a magic link is never fresh enough to revoke.
  AND NOT ("method" = 'email' AND "consumed_for" = 'revoke')
);

-- Times come from the database clock, whatever the statement wrote; set-once columns move only from null;
-- identity never changes.
CREATE OR REPLACE FUNCTION hadron_guard_fresh_sign_in() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE db_now timestamp(3) := (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3);
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.confirmed_at IS NOT NULL OR NEW.consumed_at IS NOT NULL OR NEW.consumed_for IS NOT NULL THEN
      RAISE EXCEPTION 'A fresh sign-in begins unconfirmed and unspent' USING ERRCODE = '23514';
    END IF;
    NEW.created_at := db_now;
    IF NEW.signed_in_at IS NOT NULL THEN NEW.signed_in_at := db_now; END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.user_id, NEW.method, NEW.browser_nonce_hash, NEW.leg_hash, NEW.created_at, NEW.expires_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.user_id, OLD.method, OLD.browser_nonce_hash, OLD.leg_hash, OLD.created_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'Fresh sign-in identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF (OLD.signed_in_at IS NOT NULL AND NEW.signed_in_at IS DISTINCT FROM OLD.signed_in_at)
    OR (OLD.confirmed_at IS NOT NULL AND NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at)
    OR (OLD.consumed_at IS NOT NULL AND ROW(NEW.consumed_at, NEW.consumed_for) IS DISTINCT FROM ROW(OLD.consumed_at, OLD.consumed_for)) THEN
    RAISE EXCEPTION 'Fresh sign-in times are set once' USING ERRCODE = '23514';
  END IF;
  IF OLD.signed_in_at IS NULL AND NEW.signed_in_at IS NOT NULL THEN NEW.signed_in_at := db_now; END IF;
  IF OLD.confirmed_at IS NULL AND NEW.confirmed_at IS NOT NULL THEN NEW.confirmed_at := db_now; END IF;
  IF OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL THEN NEW.consumed_at := db_now; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS fresh_sign_in_guard ON fresh_sign_ins;
CREATE TRIGGER fresh_sign_in_guard BEFORE INSERT OR UPDATE ON fresh_sign_ins
FOR EACH ROW EXECUTE FUNCTION hadron_guard_fresh_sign_in();
