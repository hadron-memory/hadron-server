-- #2832: the direct-children read (`NodeFilter.childrenOf`, cor:api:090:02) matches a node's PARENT loc,
-- which is derived from `loc` and stored nowhere. This expression index makes "the children of P in a
-- memory" a bounded index lookup instead of a prefix scan (the whole memory, near the root). Postgres
-- maintains it from `loc`, so move, rename, allocateSpecNode and a rebased subtree need no writer upkeep.
-- Prisma cannot model an expression index, so prisma/post-push.sql carries the same statement. The
-- expression is the text of PARENT_LOC_SQL in src/lib/childLoc.ts; a query must match it unchanged.
CREATE INDEX IF NOT EXISTS nodes_memory_parent_loc_idx
  ON nodes (memory_id, (regexp_replace(loc, '(^|:)[^:]*$', '')));
