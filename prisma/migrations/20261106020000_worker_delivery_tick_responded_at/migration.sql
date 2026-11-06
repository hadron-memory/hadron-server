-- #3509 (cor:agt:100:03 r7, cor:agt:080:04): the worker's response to its latest delivered wake, per ticker.
-- Null = not responded since the delivery (also every existing row: their wakes are old, and the status reads only
-- a delivery after the clock start). Same column type as acked_at so the two compare directly.
ALTER TABLE "worker_delivery_ticks" ADD COLUMN "responded_at" TIMESTAMP(3);

-- Backfill from the checks already recorded, so a worker that answered its last wake does not read as unanswered
-- the moment this deploys: the latest check of a channel the ticker covers (none named = any team channel the worker
-- has a read state on; only team channels are ever stamped), when it is at or after the recorded delivery.
UPDATE "worker_delivery_ticks" d
SET "responded_at" = c.checked
FROM (
  SELECT d2."worker_id", d2."ticker_id", max(r."last_checked_at") AS checked
  FROM "worker_delivery_ticks" d2
  JOIN "tickers" t ON t."id" = d2."ticker_id"
  JOIN "workers" w ON w."id" = d2."worker_id"
  JOIN "channel_read_states" r ON r."worker_id" = d2."worker_id" AND r."last_checked_at" IS NOT NULL
  JOIN "channels" ch ON ch."id" = r."channel_id" AND ch."deleted_at" IS NULL AND ch."loc" = 'chats:team'
  JOIN "memories" m ON m."id" = ch."memory_id" AND m."app_id" = w."app_id"
    AND (cardinality(t."channel_ids") = 0 OR r."channel_id" = ANY (t."channel_ids"))
  GROUP BY d2."worker_id", d2."ticker_id"
) c
WHERE d."worker_id" = c."worker_id" AND d."ticker_id" = c."ticker_id" AND c.checked >= d."acked_at";
