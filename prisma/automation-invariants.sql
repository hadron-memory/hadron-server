-- #1655: code and metadata immutable; approval and revocation append once.
ALTER TABLE automation_versions DROP CONSTRAINT IF EXISTS chk_automation_shape;
ALTER TABLE automation_versions ADD CONSTRAINT chk_automation_shape CHECK (
  number > 0 AND version_hash ~ '^[0-9a-f]{64}$' AND
  ((tier = 'PERSON' AND run_as_user_id IS NOT NULL AND run_as_user_id <> '') OR
   (tier = 'APP' AND run_as_user_id IS NULL)) AND
  (num_nonnulls(approval_hash, approved_by, approved_at) = 0 OR
   (num_nonnulls(approval_hash, approved_by, approved_at) = 3 AND approval_hash = version_hash)) AND
  num_nonnulls(revoked_by, revoked_at) IN (0, 2)
);
CREATE OR REPLACE FUNCTION hadron_immutable_automation_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['approval_hash','approved_by','approved_at','revoked_by','revoked_at'])
       IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['approval_hash','approved_by','approved_at','revoked_by','revoked_at']) THEN
    RAISE EXCEPTION 'Automation version is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.approved_at IS NOT NULL AND
     ROW(NEW.approval_hash,NEW.approved_by,NEW.approved_at) IS DISTINCT FROM
     ROW(OLD.approval_hash,OLD.approved_by,OLD.approved_at) THEN
    RAISE EXCEPTION 'Automation approval is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND
     ROW(NEW.revoked_by,NEW.revoked_at) IS DISTINCT FROM ROW(OLD.revoked_by,OLD.revoked_at) THEN
    RAISE EXCEPTION 'Automation revocation is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND
     ROW(NEW.approval_hash,NEW.approved_by,NEW.approved_at) IS DISTINCT FROM
     ROW(OLD.approval_hash,OLD.approved_by,OLD.approved_at) THEN
    RAISE EXCEPTION 'Revoked automation cannot be approved' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS automation_version_immutable ON automation_versions;
CREATE TRIGGER automation_version_immutable BEFORE UPDATE ON automation_versions
FOR EACH ROW EXECUTE FUNCTION hadron_immutable_automation_version();
