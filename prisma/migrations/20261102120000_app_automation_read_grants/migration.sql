-- #2883 (cor:agt:010:01, ruling 0081 = A): an automation's read grant, keyed to its trigger row.
-- CreateTable
CREATE TABLE "app_automation_read_grants" (
    "id" TEXT NOT NULL,
    "app_id" TEXT NOT NULL,
    "trigger_kind" TEXT NOT NULL,
    "trigger_id" TEXT NOT NULL,
    "memory_id" TEXT NOT NULL,
    "prefix" TEXT,
    "granted_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),
    "revoked_by" TEXT,

    CONSTRAINT "app_automation_read_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_automation_read_grant_events" (
    "id" TEXT NOT NULL,
    "app_id" TEXT NOT NULL,
    "trigger_kind" TEXT NOT NULL,
    "trigger_id" TEXT NOT NULL,
    "memory_id" TEXT NOT NULL,
    "grant_id" TEXT NOT NULL,
    "prefix" TEXT,
    "action" TEXT NOT NULL,
    "actor_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_automation_read_grant_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "app_automation_read_grants_app_id_created_at_idx" ON "app_automation_read_grants"("app_id", "created_at");

-- CreateIndex
CREATE INDEX "app_automation_read_grants_memory_id_idx" ON "app_automation_read_grants"("memory_id");

-- CreateIndex
CREATE INDEX "app_automation_read_grants_app_id_trigger_kind_trigger_id_idx" ON "app_automation_read_grants"("app_id", "trigger_kind", "trigger_id");

-- CreateIndex
CREATE INDEX "app_automation_read_grant_events_app_id_created_at_idx" ON "app_automation_read_grant_events"("app_id", "created_at");

-- CreateIndex
CREATE INDEX "app_automation_read_grant_events_grant_id_idx" ON "app_automation_read_grant_events"("grant_id");

-- AddForeignKey
ALTER TABLE "app_automation_read_grants" ADD CONSTRAINT "app_automation_read_grants_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_automation_read_grants" ADD CONSTRAINT "app_automation_read_grants_memory_id_fkey" FOREIGN KEY ("memory_id") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_automation_read_grant_events" ADD CONSTRAINT "app_automation_read_grant_events_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- #2883 (cor:agt:010:01, ruling 0081 = A): an automation's read grant, keyed to its trigger row.
-- One source, shared verbatim with migration 20261102120000_app_automation_read_grants
-- (pinned by src/lib/automationReadGrantRow.test.ts) and applied by post-push.sql and the test
-- globalSetup.
--
-- A grant row is never edited: it ends once, by a terminal `revoked_at` stamped together with
-- `revoked_by`, and nothing else about it changes. A DELETE is refused unless the App or the
-- memory is already gone (the ON DELETE CASCADE of a hard delete). TRUNCATE fires no row trigger;
-- it is the TEST-ONLY cleanup path (src/test/helpers.ts cleanDb).
--
-- The prefix is OPTIONAL: NULL grants the whole memory; otherwise it is a loc (segments of
-- [A-Za-z0-9._-] that start and end alphanumeric, joined by single colons). An empty string is
-- not a prefix and not a whole-memory spelling: NULL is the one.
ALTER TABLE app_automation_read_grants DROP CONSTRAINT IF EXISTS chk_app_automation_read_grant_shape;
ALTER TABLE app_automation_read_grants ADD CONSTRAINT chk_app_automation_read_grant_shape CHECK (
  trigger_kind IN ('SCHEDULE', 'WEBHOOK') AND
  trigger_id <> '' AND
  (prefix IS NULL OR prefix ~ '^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?(:[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?)*$') AND
  granted_by <> '' AND
  (revoked_at IS NULL) = (revoked_by IS NULL) AND
  (revoked_by IS NULL OR revoked_by <> '')
);
-- At most one LIVE row per (App, trigger, memory, prefix); NULL (the whole memory) is one value. A revoked row
-- never blocks a fresh one.
CREATE UNIQUE INDEX IF NOT EXISTS app_automation_read_grants_live_uq
  ON app_automation_read_grants (app_id, trigger_kind, trigger_id, memory_id, COALESCE(prefix, '')) WHERE revoked_at IS NULL;
CREATE OR REPLACE FUNCTION hadron_guard_app_automation_read_grant() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM apps WHERE id = OLD.app_id)
       AND EXISTS (SELECT 1 FROM memories WHERE id = OLD.memory_id) THEN
      RAISE EXCEPTION 'App automation read grants are append-only' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
     AND NEW.id = OLD.id AND NEW.app_id = OLD.app_id AND NEW.trigger_kind = OLD.trigger_kind
     AND NEW.trigger_id = OLD.trigger_id AND NEW.memory_id = OLD.memory_id
     AND NEW.prefix IS NOT DISTINCT FROM OLD.prefix
     AND NEW.granted_by = OLD.granted_by AND NEW.created_at = OLD.created_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'App automation read grants are append-only' USING ERRCODE = '23514';
END $$;
DROP TRIGGER IF EXISTS app_automation_read_grant_guard ON app_automation_read_grants;
CREATE TRIGGER app_automation_read_grant_guard BEFORE UPDATE OR DELETE ON app_automation_read_grants
FOR EACH ROW EXECUTE FUNCTION hadron_guard_app_automation_read_grant();

ALTER TABLE app_automation_read_grant_events DROP CONSTRAINT IF EXISTS chk_app_automation_read_grant_event_shape;
ALTER TABLE app_automation_read_grant_events ADD CONSTRAINT chk_app_automation_read_grant_event_shape CHECK (
  action IN ('GRANT', 'REVOKE') AND trigger_kind IN ('SCHEDULE', 'WEBHOOK') AND trigger_id <> '' AND
  (prefix IS NULL OR prefix <> '') AND actor_user_id <> '' AND grant_id <> '' AND memory_id <> ''
);
CREATE OR REPLACE FUNCTION hadron_append_only_app_automation_read_grant_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM apps WHERE id = OLD.app_id) THEN
      RAISE EXCEPTION 'App automation read grant events are append-only' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'App automation read grant events are append-only' USING ERRCODE = '23514';
END $$;
DROP TRIGGER IF EXISTS app_automation_read_grant_event_append_only ON app_automation_read_grant_events;
CREATE TRIGGER app_automation_read_grant_event_append_only BEFORE UPDATE OR DELETE ON app_automation_read_grant_events
FOR EACH ROW EXECUTE FUNCTION hadron_append_only_app_automation_read_grant_event();
