-- #896 — malware scanner support fields on Asset.
--
-- scan_signature: engine signature name recorded when a scan verdict is
--   BLOCKED (the row is kept as an audit tombstone; the object bytes are
--   deleted).
-- scan_attempts / scanned_at: retry bookkeeping (inline attempt at
--   complete-upload counts too). scanned_at is informational.
-- scan_due_at: the sweep's queue stamp (#882 embedding-queue pattern —
--   a future-dated stamp IS the queue). PENDING: next scan retry due.
--   BLOCKED: next purge retry for bytes that survived a failed delete.
--   NULL: nothing pending.

ALTER TABLE "assets" ADD COLUMN "scan_signature" TEXT;
ALTER TABLE "assets" ADD COLUMN "scan_attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "assets" ADD COLUMN "scanned_at" TIMESTAMP(3);
ALTER TABLE "assets" ADD COLUMN "scan_due_at" TIMESTAMP(3);

-- The sweep's selector: due rows, oldest due first.
CREATE INDEX "assets_scan_due_at_idx" ON "assets" ("scan_due_at");
