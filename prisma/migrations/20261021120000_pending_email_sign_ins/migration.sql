-- #1897 slice B1: an email sign-in waiting for its passkey. It publishes nothing: no handoff code, JWT, cookie
-- or key exists until the pending row completes.
CREATE TABLE "pending_email_sign_ins" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "continuation" TEXT NOT NULL,
    "client_state_hash" TEXT,
    "redirect" TEXT,
    "is_new" BOOLEAN,
    "return_to" TEXT,
    "browser_hash" TEXT NOT NULL,
    "ceremony_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),
    "sign_in_id" TEXT,

    CONSTRAINT "pending_email_sign_ins_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "pending_email_sign_ins_user_id_idx" ON "pending_email_sign_ins"("user_id");
CREATE UNIQUE INDEX "pending_email_sign_ins_browser_hash_key" ON "pending_email_sign_ins"("browser_hash");
CREATE INDEX "pending_email_sign_ins_created_at_idx" ON "pending_email_sign_ins"("created_at");

ALTER TABLE "pending_email_sign_ins" ADD CONSTRAINT "pending_email_sign_ins_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- The sign-in a pending flow produced belongs to the same user (same-owner composite FK, as for codes and keys).
ALTER TABLE "pending_email_sign_ins" ADD CONSTRAINT "pending_email_sign_ins_sign_in_id_user_id_fkey"
  FOREIGN KEY ("sign_in_id", "user_id") REFERENCES "sign_ins"("id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- #1897 slice B1: pending email sign-in invariants. One source, shared verbatim with migration
-- 20261021120000_pending_email_sign_ins (pinned by src/auth/pendingEmailSignIn1897.test.ts).
ALTER TABLE "pending_email_sign_ins" DROP CONSTRAINT IF EXISTS "chk_pending_email_sign_in_shape";
ALTER TABLE "pending_email_sign_ins" ADD CONSTRAINT "chk_pending_email_sign_in_shape" CHECK (
  "browser_hash" ~ '^[0-9a-f]{64}$'
  AND "expires_at" > "created_at"
  -- Each continuation carries exactly its own columns, so a pending flow is a portal exchange or an OAuth
  -- resume, never both.
  AND (("continuation" = 'PORTAL' AND "redirect" IS NOT NULL AND "is_new" IS NOT NULL AND "return_to" IS NULL)
    OR ("continuation" = 'OAUTH' AND "return_to" IS NOT NULL AND "client_state_hash" IS NULL
        AND "redirect" IS NULL AND "is_new" IS NULL))
  -- Completion is one act: the time and the sign-in it produced arrive together or not at all.
  AND (("completed_at" IS NULL AND "sign_in_id" IS NULL) OR ("completed_at" IS NOT NULL AND "sign_in_id" IS NOT NULL))
);

-- Times come from the database clock; identity and continuation never change; completion is set once.
CREATE OR REPLACE FUNCTION hadron_guard_pending_email_sign_in() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE db_now timestamp(3) := (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3);
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.completed_at IS NOT NULL OR NEW.sign_in_id IS NOT NULL THEN
      RAISE EXCEPTION 'A pending email sign-in begins uncompleted' USING ERRCODE = '23514';
    END IF;
    NEW.created_at := db_now;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.user_id, NEW.continuation, NEW.client_state_hash, NEW.redirect, NEW.is_new, NEW.return_to,
         NEW.browser_hash, NEW.created_at, NEW.expires_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.user_id, OLD.continuation, OLD.client_state_hash, OLD.redirect, OLD.is_new, OLD.return_to,
         OLD.browser_hash, OLD.created_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'A pending email sign-in''s identity and continuation never change' USING ERRCODE = '23514';
  END IF;
  IF OLD.completed_at IS NOT NULL AND ROW(NEW.completed_at, NEW.sign_in_id) IS DISTINCT FROM ROW(OLD.completed_at, OLD.sign_in_id) THEN
    RAISE EXCEPTION 'A pending email sign-in completes once' USING ERRCODE = '23514';
  END IF;
  IF OLD.completed_at IS NULL AND NEW.completed_at IS NOT NULL THEN NEW.completed_at := db_now; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pending_email_sign_in_guard ON pending_email_sign_ins;
CREATE TRIGGER pending_email_sign_in_guard BEFORE INSERT OR UPDATE ON pending_email_sign_ins
FOR EACH ROW EXECUTE FUNCTION hadron_guard_pending_email_sign_in();
