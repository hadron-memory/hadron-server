-- Phase 2 of moving Pong out of the portal database.
--
-- Pong settings (auto-send, threshold, tone, signature, exclusion rules, pause)
-- now live as a single node in the station's hadron memory at loc "pong/settings".
--
-- The only thing kept in the portal database is the bootstrap pointer:
-- exchange_connections.pong_station_id, which tells us which station's memory
-- to read settings from.
--
-- DATA LOSS WARNING: this migration preserves the station link by copying
-- pong_settings.station_id → exchange_connections.pong_station_id, but the
-- other settings (auto_send_enabled, confidence_threshold, reply_tone,
-- signature_text, paused_until, exclusion_rules) are dropped. Users will need
-- to reconfigure those once. For a production rollout, write a backfill that
-- creates a "pong/settings" node per connection before running this migration.

ALTER TABLE "exchange_connections" ADD COLUMN "pong_station_id" TEXT;

UPDATE "exchange_connections" ec
SET "pong_station_id" = ps."station_id"
FROM "pong_settings" ps
WHERE ps."exchange_connection_id" = ec."id"
  AND ps."station_id" IS NOT NULL;

ALTER TABLE "exchange_connections"
  ADD CONSTRAINT "exchange_connections_pong_station_id_fkey"
  FOREIGN KEY ("pong_station_id") REFERENCES "stations"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

DROP TABLE IF EXISTS "pong_settings";
