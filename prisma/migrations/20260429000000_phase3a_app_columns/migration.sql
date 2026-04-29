-- Phase 3a (US3) of the Station -> App migration (003-station-to-app),
-- first half (3a-1).
--
-- Two cross-cutting tables get caller-identity columns reshaped:
--
--   * usage_events: ADD app_id (nullable). Existing station_id stays
--     because the Phase-2 auth fallback can still resolve Station-keyed
--     bearer tokens, and those legacy in-flight calls need to attribute
--     somewhere. Both columns coexist until Phase 4 removes the auth
--     fallback and drops station_id.
--
--   * pending_setups: ADD app_id (NOT NULL) and DROP station_id. Setup
--     rows are ephemeral (consumed on first /setup/info read) and the
--     only writer (provisionPersonalWorkspace) is App-only after this
--     migration. No legacy code path creates Station-keyed setup rows
--     anymore, so keeping the column would just be dead state. Any
--     existing rows with non-null station_id are dropped along with the
--     column — they were ephemeral and would have been consumed within
--     hours of creation.

-- AlterTable: add app_id to usage_events.
ALTER TABLE "usage_events" ADD COLUMN IF NOT EXISTS "app_id" TEXT;

-- AlterTable: pending_setups gets a required app_id and loses station_id.
-- Add as nullable first so the migration is repeatable, then promote.
ALTER TABLE "pending_setups" ADD COLUMN IF NOT EXISTS "app_id" TEXT;

-- Drop any existing Station-keyed rows (ephemeral; consumed-or-stale by now).
DELETE FROM "pending_setups" WHERE "app_id" IS NULL;

-- Promote app_id to NOT NULL. Safe now: every remaining row has it set.
ALTER TABLE "pending_setups" ALTER COLUMN "app_id" SET NOT NULL;

-- Drop the legacy FK + column.
ALTER TABLE "pending_setups" DROP CONSTRAINT IF EXISTS "pending_setups_station_id_fkey";
ALTER TABLE "pending_setups" DROP COLUMN IF EXISTS "station_id";

-- CreateIndex
CREATE INDEX IF NOT EXISTS "usage_events_app_id_idx" ON "usage_events"("app_id");

-- AddForeignKey (DO/EXCEPTION because Postgres lacks IF NOT EXISTS for
-- ADD CONSTRAINT — same idiom as 20260428000000_phase1_app_absorbs_station).
DO $$ BEGIN
    ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_app_id_fkey"
        FOREIGN KEY ("app_id") REFERENCES "apps"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "pending_setups" ADD CONSTRAINT "pending_setups_app_id_fkey"
        FOREIGN KEY ("app_id") REFERENCES "apps"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
