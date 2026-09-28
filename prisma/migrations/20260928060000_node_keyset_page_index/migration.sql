-- #1384 paged attention: keyset-order index for channel-message scans.
-- Under a memoryId equality this yields rows in (seq, id) order, so the
-- paged scan's row comparison runs as an index condition and LIMIT bounds
-- examined rows (review finding on #1428).
CREATE INDEX "nodes_memory_id_seq_id_idx" ON "nodes"("memory_id", "seq", "id");
