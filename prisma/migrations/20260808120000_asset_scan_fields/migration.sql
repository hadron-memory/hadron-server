-- #896 — malware scanner support fields on Asset.
--
-- scan_signature: engine signature name recorded when a scan verdict is
--   BLOCKED (the row is kept as an audit tombstone; the object bytes are
--   deleted).
-- scan_attempts / scanned_at: retry bookkeeping for the scan sweep's
--   exponential backoff (inline attempt at complete-upload counts too).

ALTER TABLE "assets" ADD COLUMN "scan_signature" TEXT;
ALTER TABLE "assets" ADD COLUMN "scan_attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "assets" ADD COLUMN "scanned_at" TIMESTAMP(3);

-- The retry sweep's selector: PENDING rows ordered by last attempt.
CREATE INDEX "assets_scan_status_scanned_at_idx"
  ON "assets" ("scan_status", "scanned_at");
