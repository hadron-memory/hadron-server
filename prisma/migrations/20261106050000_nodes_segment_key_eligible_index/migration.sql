-- #2836 (cor:api:090:05 rev 5): loc segments share findNodes' default exclusions, so chat-message
-- nodes are left out alongside system and comment. A chat root holds tens of thousands of messages;
-- as a row filter on nodes_memory_segment_key_idx the skip-scan would step over every one of them
-- (cost by descendants, breaking ruling 0229's sibling bound), and the planner, expecting that,
-- leaves the LIMIT-1 probe or JIT-compiles the read. This partial index holds only eligible rows,
-- so each probe lands on an eligible row and the cost stays one probe per sibling.
-- Additive: nodes_memory_segment_key_idx stays. Plain CREATE INDEX (a Prisma migration runs in a
-- transaction, so not CONCURRENTLY), as that index was. prisma/post-push.sql carries the same
-- statement. The WHERE clause is segmentEligibleSql() in src/lib/memoryLocSegments.ts, byte for
-- byte (pinned): a later change to the default list needs a new index migration.
CREATE INDEX IF NOT EXISTS nodes_memory_segment_key_eligible_idx
  ON nodes (memory_id, ((replace(loc, ':', chr(1))) COLLATE "C"))
  WHERE deleted_at IS NULL AND node_type <> ALL(ARRAY['system','chat-message','comment']) AND loc <> '';
