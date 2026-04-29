-- Phase 3a (US3) of the Station -> App migration (003-station-to-app).
-- Additive only: adds nullable app_id columns to two cross-cutting tables
-- so App-keyed callers can be attributed alongside the legacy Station path.
-- Phase 4 drops the station_id columns; until then, callers populate
-- exactly one of app_id / station_id depending on the resolved
-- AuthContext.

-- AlterTable: add app_id to usage_events.
ALTER TABLE "usage_events" ADD COLUMN IF NOT EXISTS "app_id" TEXT;

-- AlterTable: add app_id to pending_setups, and relax station_id to nullable
-- (a setup record now carries either station_id or app_id, never both).
ALTER TABLE "pending_setups" ADD COLUMN IF NOT EXISTS "app_id" TEXT;
ALTER TABLE "pending_setups" ALTER COLUMN "station_id" DROP NOT NULL;

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
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
