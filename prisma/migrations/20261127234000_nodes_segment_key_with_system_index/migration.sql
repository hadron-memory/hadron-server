-- #5452 (cor:api:090:05): the loc-segments read gains includeSystemNodes, which makes `system` nodes eligible.
-- nodes_memory_segment_key_eligible_idx (#2836) holds no system row, so the planner cannot use it for that read;
-- on the full nodes_memory_segment_key_idx the skip-scan would step over every chat-message under a chat root
-- (cost by descendants, breaking ruling 0229's sibling bound). This partial index is that index's twin for the
-- flagged read: the same key, system rows in, chat-message and comment rows still out.
-- Additive: both older indexes stay. The WHERE clause is segmentEligibleSql(undefined, { includeSystemNodes: true })
-- in src/lib/memoryLocSegments.ts, byte for byte (pinned), and prisma/post-push.sql carries the same definition.
--
-- Built CONCURRENTLY so writes to nodes are not blocked (convention:
-- hrn:node:hadronmemory.com:hadron-server:findings:create-index-concurrently-in-prisma-migrations).
-- CONCURRENTLY cannot run inside a transaction block, and `prisma migrate deploy` sends a file as one simple query: one
-- statement runs outside a transaction, several run as one implicit transaction (SQLSTATE 25001). Keep this file a single
-- statement. A failed concurrent build leaves an INVALID index that IF NOT EXISTS then skips: drop it and re-run by hand.
CREATE INDEX CONCURRENTLY IF NOT EXISTS nodes_memory_segment_key_with_system_idx
  ON nodes (memory_id, ((replace(loc, ':', chr(1))) COLLATE "C"))
  WHERE deleted_at IS NULL AND node_type <> ALL(ARRAY['chat-message','comment']) AND loc <> '';
