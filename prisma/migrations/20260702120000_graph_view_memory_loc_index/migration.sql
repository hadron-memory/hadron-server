-- Graph-view scale path (#466): composite (memory_id, loc) index on nodes +
-- edges so the memoryNodes / memoryEdges hot query
--   WHERE memory_id = ? [AND deleted_at IS NULL] ORDER BY loc LIMIT ? OFFSET ?
-- can seek to a single memory's rows AND return them loc-ordered without a
-- separate sort or a full scan of the loc-leading unique across other memories.
-- Names match Prisma's default composite-index naming so `db push` sees no drift.
CREATE INDEX IF NOT EXISTS "nodes_memory_id_loc_idx" ON "nodes" ("memory_id", "loc");
CREATE INDEX IF NOT EXISTS "edges_memory_id_loc_idx" ON "edges" ("memory_id", "loc");
