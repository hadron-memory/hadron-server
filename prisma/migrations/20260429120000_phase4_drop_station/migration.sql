-- Phase 4 of 003-station-to-app: drop the legacy Station-shaped tables and types.
--
-- Sequencing rules (per spec research §R-4):
--   1. DELETE rows in reverse-FK order so FK constraints are satisfied at each step.
--   2. DROP TABLE in reverse-FK order. IF EXISTS guards make this idempotent across
--      repeat runs and partial failures.
--   3. Drop the Session.station_id and UsageEvent.station_id columns + their indexes.
--   4. DROP the orphaned StationType enum (Role stays — it's still used by User,
--      OrgMember, MemorySubscription, etc.).
--
-- This migration is destructive. It is intended to run during a maintenance
-- window per FR-032/033/034. The pre-cutover dry-run (T070) verifies it
-- against a snapshot of pilot data before T071 applies it to the live DB.

BEGIN;

-- 1. Delete rows. station_log first (no inbound FKs), then the join /
--    subscription / key tables, then stations themselves last.
DELETE FROM "station_log";
DELETE FROM "station_agent_subscriptions";
DELETE FROM "station_keys";
DELETE FROM "stations";

-- 2. Drop the foreign-key constraint + column on Session and UsageEvent
--    that pointed at stations. The relation was already dropped at the
--    Prisma-schema level — these statements clean up the database side.
ALTER TABLE "sessions"      DROP CONSTRAINT IF EXISTS "sessions_station_id_fkey";
ALTER TABLE "usage_events"  DROP CONSTRAINT IF EXISTS "usage_events_station_id_fkey";
DROP INDEX  IF EXISTS "sessions_station_id_idx";
DROP INDEX  IF EXISTS "usage_events_station_id_idx";
ALTER TABLE "sessions"      DROP COLUMN IF EXISTS "station_id";
ALTER TABLE "usage_events"  DROP COLUMN IF EXISTS "station_id";

-- 3. Drop the four Station-shaped tables in reverse-FK order.
DROP TABLE IF EXISTS "station_log";
DROP TABLE IF EXISTS "station_agent_subscriptions";
DROP TABLE IF EXISTS "station_keys";
DROP TABLE IF EXISTS "stations";

-- 4. Drop the StationType enum. Wrapped in DO block to remain a no-op
--    on databases where the enum was already removed (e.g. by a partial
--    earlier run that aborted after the type drop).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'StationType') THEN
    DROP TYPE "StationType";
  END IF;
END$$;

COMMIT;
