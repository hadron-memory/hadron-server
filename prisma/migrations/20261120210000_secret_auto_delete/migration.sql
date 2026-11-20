-- #4001 / cor:sec:060:03: new or changed auto-delete terms and activation need a finite end.
-- Existing unbounded grants predate this invariant: ending, spending or moving their holder must
-- remain possible. The signing path separately refuses activating a historical unbounded mark.
ALTER TABLE grants DROP CONSTRAINT IF EXISTS chk_secret_auto_delete_limit;
CREATE OR REPLACE FUNCTION hadron_guard_secret_auto_delete_limit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(NEW.action, NEW.action_values, NEW.expires_at, NEW.max_uses)
       IS NOT DISTINCT FROM ROW(OLD.action, OLD.action_values, OLD.expires_at, OLD.max_uses)
     AND NOT (OLD.activated_at IS NULL AND NEW.activated_at IS NOT NULL) THEN
    RETURN NEW;
  END IF;
  IF NEW.action IN ('secret.reveal', 'secret.use')
     AND NEW.action_values->>'auto-delete' = 'delete'
     AND NEW.expires_at IS NULL AND NEW.max_uses IS NULL THEN
    RAISE EXCEPTION 'an auto-delete grant needs an expiry or use budget'
      USING ERRCODE = '23514', CONSTRAINT = 'chk_secret_auto_delete_limit';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS secret_auto_delete_limit ON grants;
CREATE TRIGGER secret_auto_delete_limit BEFORE INSERT OR UPDATE ON grants
FOR EACH ROW EXECUTE FUNCTION hadron_guard_secret_auto_delete_limit();
