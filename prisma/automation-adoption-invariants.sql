-- #2441: the automation adoption event stream is append-only (cor:agt:010:01).
-- A row is never updated. A DELETE is refused unless the App row is already
-- gone, which is the only way one happens: the ON DELETE CASCADE of an App
-- hard delete (URN reclaim, account deletion). TRUNCATE fires no row trigger;
-- it is the TEST-ONLY cleanup path (src/test/helpers.ts cleanDb).
ALTER TABLE automation_adoption_events DROP CONSTRAINT IF EXISTS chk_automation_adoption_event_shape;
ALTER TABLE automation_adoption_events ADD CONSTRAINT chk_automation_adoption_event_shape CHECK (
  trigger_kind IN ('SCHEDULE', 'WEBHOOK', 'MANUAL') AND
  action IN ('APPROVE', 'DECLINE', 'REVOKE') AND
  trigger_ref <> '' AND actor_user_id <> '' AND
  (pin_hash IS NULL OR pin_hash ~ '^[0-9a-f]{64}$') AND
  (action <> 'APPROVE' OR pin_hash IS NOT NULL) AND
  (action <> 'REVOKE' OR pin_hash IS NOT NULL)
);
CREATE OR REPLACE FUNCTION hadron_append_only_automation_adoption_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM apps WHERE id = OLD.app_id) THEN
      RAISE EXCEPTION 'Automation adoption events are append-only' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Automation adoption events are append-only' USING ERRCODE = '23514';
END $$;
DROP TRIGGER IF EXISTS automation_adoption_event_append_only ON automation_adoption_events;
CREATE TRIGGER automation_adoption_event_append_only BEFORE UPDATE OR DELETE ON automation_adoption_events
FOR EACH ROW EXECUTE FUNCTION hadron_append_only_automation_adoption_event();
