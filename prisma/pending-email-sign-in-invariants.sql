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
