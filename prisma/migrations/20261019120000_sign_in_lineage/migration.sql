-- #1897 foundation A: revocable sign-ins and the lineage of what descends from them.
CREATE TABLE "sign_ins" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "completed_by_passkey_id" TEXT,
    "completed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "end_reason" TEXT,
    CONSTRAINT "sign_ins_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sign_ins_id_user_id_key" ON "sign_ins"("id", "user_id");
CREATE INDEX "sign_ins_user_id_idx" ON "sign_ins"("user_id");
CREATE INDEX "sign_ins_completed_by_passkey_id_idx" ON "sign_ins"("completed_by_passkey_id");
ALTER TABLE "sign_ins" ADD CONSTRAINT "sign_ins_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sign_ins" ADD CONSTRAINT "sign_ins_completed_by_passkey_id_fkey" FOREIGN KEY ("completed_by_passkey_id") REFERENCES "passkey_credentials"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "auth_codes" ADD COLUMN "sign_in_id" TEXT;
ALTER TABLE "auth_handoff_codes" ADD COLUMN "sign_in_id" TEXT;
ALTER TABLE "user_api_keys" ADD COLUMN "origin_sign_in_id" TEXT;
CREATE INDEX "auth_codes_sign_in_id_idx" ON "auth_codes"("sign_in_id");
CREATE INDEX "auth_handoff_codes_sign_in_id_idx" ON "auth_handoff_codes"("sign_in_id");
CREATE INDEX "user_api_keys_origin_sign_in_id_idx" ON "user_api_keys"("origin_sign_in_id");
ALTER TABLE "auth_codes" ADD CONSTRAINT "auth_codes_sign_in_id_user_id_fkey" FOREIGN KEY ("sign_in_id", "user_id") REFERENCES "sign_ins"("id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "auth_handoff_codes" ADD CONSTRAINT "auth_handoff_codes_sign_in_id_user_id_fkey" FOREIGN KEY ("sign_in_id", "user_id") REFERENCES "sign_ins"("id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "user_api_keys" ADD CONSTRAINT "user_api_keys_origin_sign_in_id_user_id_fkey" FOREIGN KEY ("origin_sign_in_id", "user_id") REFERENCES "sign_ins"("id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- #1897 / R66: a sign-in's identity and lineage are immutable; it is ended once, never deleted
-- while anything descends from it. Descendants (handoff code, auth code, key) carry the root
-- from creation and never change it.
ALTER TABLE sign_ins DROP CONSTRAINT IF EXISTS chk_sign_in_shape;
ALTER TABLE sign_ins ADD CONSTRAINT chk_sign_in_shape CHECK (
  method <> '' AND expires_at > completed_at
  AND ((ended_at IS NULL AND end_reason IS NULL) OR (ended_at IS NOT NULL AND end_reason IS NOT NULL AND end_reason <> ''))
);
CREATE OR REPLACE FUNCTION hadron_guard_sign_in() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- The credential that completed a sign-in belongs to the sign-in's own user (Baloo P2-1, #2116).
  IF NEW.completed_by_passkey_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM passkey_credentials WHERE id = NEW.completed_by_passkey_id AND owner_id = NEW.user_id) THEN
    RAISE EXCEPTION 'A sign-in is completed by its own user''s credential' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
      OR NEW.method IS DISTINCT FROM OLD.method
      OR NEW.completed_by_passkey_id IS DISTINCT FROM OLD.completed_by_passkey_id
      OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
      OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
      RAISE EXCEPTION 'A sign-in''s identity and lineage never change' USING ERRCODE = '23514';
    END IF;
    IF OLD.ended_at IS NOT NULL AND (NEW.ended_at IS DISTINCT FROM OLD.ended_at OR NEW.end_reason IS DISTINCT FROM OLD.end_reason) THEN
      RAISE EXCEPTION 'A sign-in is ended once' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS sign_ins_guard ON sign_ins;
CREATE TRIGGER sign_ins_guard BEFORE INSERT OR UPDATE ON sign_ins
  FOR EACH ROW EXECUTE FUNCTION hadron_guard_sign_in();

CREATE OR REPLACE FUNCTION hadron_guard_sign_in_root() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE old_root text; new_root text;
BEGIN
  IF TG_TABLE_NAME = 'user_api_keys' THEN old_root := OLD.origin_sign_in_id; new_root := NEW.origin_sign_in_id;
  ELSE old_root := OLD.sign_in_id; new_root := NEW.sign_in_id; END IF;
  IF old_root IS DISTINCT FROM new_root THEN
    RAISE EXCEPTION 'The sign-in root of a credential never changes' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS user_api_keys_sign_in_root ON user_api_keys;
CREATE TRIGGER user_api_keys_sign_in_root BEFORE UPDATE ON user_api_keys
  FOR EACH ROW EXECUTE FUNCTION hadron_guard_sign_in_root();
DROP TRIGGER IF EXISTS auth_codes_sign_in_root ON auth_codes;
CREATE TRIGGER auth_codes_sign_in_root BEFORE UPDATE ON auth_codes
  FOR EACH ROW EXECUTE FUNCTION hadron_guard_sign_in_root();
DROP TRIGGER IF EXISTS auth_handoff_codes_sign_in_root ON auth_handoff_codes;
CREATE TRIGGER auth_handoff_codes_sign_in_root BEFORE UPDATE ON auth_handoff_codes
  FOR EACH ROW EXECUTE FUNCTION hadron_guard_sign_in_root();

CREATE OR REPLACE FUNCTION hadron_guard_sign_in_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM user_api_keys WHERE origin_sign_in_id = OLD.id) THEN
    RAISE EXCEPTION 'A sign-in with descendant keys is never deleted' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS sign_ins_no_delete_with_keys ON sign_ins;
CREATE TRIGGER sign_ins_no_delete_with_keys BEFORE DELETE ON sign_ins
  FOR EACH ROW EXECUTE FUNCTION hadron_guard_sign_in_delete();
