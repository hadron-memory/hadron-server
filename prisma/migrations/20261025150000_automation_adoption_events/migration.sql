-- CreateTable
CREATE TABLE "automation_adoption_events" (
    "id" TEXT NOT NULL,
    "app_id" TEXT NOT NULL,
    "organization_id" TEXT,
    "trigger_kind" TEXT NOT NULL,
    "trigger_ref" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actor_user_id" TEXT NOT NULL,
    "pin_hash" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_adoption_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "automation_adoption_events_app_id_created_at_idx" ON "automation_adoption_events"("app_id", "created_at");

-- CreateIndex
CREATE INDEX "automation_adoption_events_trigger_kind_trigger_ref_created_idx" ON "automation_adoption_events"("trigger_kind", "trigger_ref", "created_at");

-- AddForeignKey
ALTER TABLE "automation_adoption_events" ADD CONSTRAINT "automation_adoption_events_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

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
