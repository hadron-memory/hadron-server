-- #1140 slice B: the bytes-missing row sweep's persisted cursor. Additive and idempotent, no backfill:
-- NULL means "never examined", which the sweep reads as "first in line".
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "bytes_checked_at" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "assets_bytes_checked_at_idx" ON "assets"("bytes_checked_at");
