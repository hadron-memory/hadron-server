-- Drop soft-delete columns from log-entry tables. Log entries are append-only,
-- so deletedAt/deletedBy were never written by application code. The new
-- AppLogEntry model (added in PR #58, phase 1 of 003-station-to-app) already
-- omits these columns; this migration brings server_log and memory_log in line.
--
-- StationLogEntry/station_log was dropped wholesale in
-- 20260429120000_phase4_drop_station, so it is not addressed here.

ALTER TABLE "server_log" DROP COLUMN IF EXISTS "deleted_at";
ALTER TABLE "server_log" DROP COLUMN IF EXISTS "deleted_by";

ALTER TABLE "memory_log" DROP COLUMN IF EXISTS "deleted_at";
ALTER TABLE "memory_log" DROP COLUMN IF EXISTS "deleted_by";
