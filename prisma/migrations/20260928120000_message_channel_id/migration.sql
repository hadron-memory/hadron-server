-- #1430 paged attention: Channel-local seq-first access path for chat-message
-- scans. The column stamps the owning Channel in the append transaction; the
-- partial btree (message_channel_id, seq, loc COLLATE "C") serves the paged
-- scan's keyset, eliminating the unbounded loc-ordered residual walk.
ALTER TABLE "nodes" ADD COLUMN "message_channel_id" text;

-- Backfill: stamp every live chat-message covered by a Channel's messages
-- prefix. Membership is the (memory_id, loc prefix) → Channel mapping.
-- starts_with is LITERAL (Andi #3279): a LIKE here would treat `_`/`%` in a
-- Channel loc as wildcards, so e.g. `chats_team` could claim foreign
-- `chatsXteam:messages:*` rows and make the mapping nondeterministic.
UPDATE "nodes" n
SET "message_channel_id" = c.id
FROM "channels" c
WHERE n."memory_id" = c."memory_id"
  AND starts_with(n."loc", c."loc" || ':messages:')
  AND n."node_type" = 'chat-message'
  AND n."deleted_at" IS NULL
  AND c."deleted_at" IS NULL;

-- Partial C-collation btree for the paged scan. The scan's inner SELECT
-- carries the same predicate (node_type/deleted_at), so the planner can use
-- the index as the access path rather than filter-scan the wider table
-- (Andi #3277 / Chip #3282 EXPLAIN: without predicate proof the LIMIT query
-- seq-scanned 20k rows).
CREATE INDEX "nodes_msg_channel_seq_loc_c_idx"
  ON "nodes" ("message_channel_id", "seq", "loc" COLLATE "C")
  WHERE "node_type" = 'chat-message' AND "deleted_at" IS NULL AND "seq" IS NOT NULL;
