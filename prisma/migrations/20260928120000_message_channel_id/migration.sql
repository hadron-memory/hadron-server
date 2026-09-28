-- #1430 paged attention: Channel-local seq-first access path for chat-message
-- scans. The column stamps the owning Channel in the append transaction; the
-- partial btree (message_channel_id, seq, loc COLLATE "C") serves the paged
-- scan's keyset, eliminating the unbounded loc-ordered residual walk.
ALTER TABLE "nodes" ADD COLUMN "message_channel_id" text;

-- Backfill: stamp every live chat-message covered by a Channel's messages
-- prefix. Membership is the (memory_id, loc prefix) → Channel mapping.
UPDATE "nodes" n
SET "message_channel_id" = c.id
FROM "channels" c
WHERE n."memory_id" = c."memory_id"
  AND n."loc" LIKE (c."loc" || ':messages:%')
  AND n."node_type" = 'chat-message'
  AND n."deleted_at" IS NULL
  AND c."deleted_at" IS NULL;

-- Partial C-collation btree for the paged scan.
CREATE INDEX "nodes_msg_channel_seq_loc_c_idx"
  ON "nodes" ("message_channel_id", "seq", "loc" COLLATE "C")
  WHERE "node_type" = 'chat-message' AND "deleted_at" IS NULL AND "seq" IS NOT NULL;
