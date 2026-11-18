-- #3456: the loc-segment read (`memoryLocSegments`, cor:api:090:05) lists the distinct next segments under
-- a parent loc. Done by a prefix scan it reads every descendant (the whole memory at the root). With the
-- ':' separator replaced by chr(1) and compared bytewise (COLLATE "C"), every loc under one segment is
-- contiguous in this index (a plain C order interleaves 'a-b' between 'a' and 'a:c'), so the read can hop
-- from one sibling to the next with an index probe: cost follows the number of siblings, not descendants.
-- Prisma cannot model an expression index, so prisma/post-push.sql carries the same statement. The
-- expression is SEGMENT_KEY_SQL in src/lib/memoryLocSegments.ts; a query must match it unchanged.
CREATE INDEX IF NOT EXISTS nodes_memory_segment_key_idx
  ON nodes (memory_id, ((replace(loc, ':', chr(1))) COLLATE "C"));
