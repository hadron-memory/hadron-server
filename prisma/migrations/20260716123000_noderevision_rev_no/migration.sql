-- #696: per-node MONOTONIC revision numbers for the `hrn:noderev:…:<rev>` URN.
--
-- `nodes.rev_seq` is the per-node counter (atomically incremented in the same
-- tx that inserts a NodeRevision — the QuotaCounter pattern, race-safe).
-- `node_revisions.rev_no` is the number stamped on each snapshot; it is the
-- stable end-anchored terminal of the noderev URN (rendered `r<N>`).
--
-- Backfill: number existing revisions per node by capture order (created_at,
-- then id as a deterministic tiebreak), then seed each node's counter to its
-- highest revision number so the next mint continues the sequence.

ALTER TABLE "nodes" ADD COLUMN "rev_seq" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "node_revisions" ADD COLUMN "rev_no" INTEGER;

WITH numbered AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY node_id ORDER BY created_at ASC, id ASC) AS rn
  FROM "node_revisions"
)
UPDATE "node_revisions" nr
  SET "rev_no" = numbered.rn
  FROM numbered
  WHERE nr.id = numbered.id;

UPDATE "nodes" n
  SET "rev_seq" = m.max_rev
  FROM (SELECT node_id, MAX("rev_no") AS max_rev FROM "node_revisions" GROUP BY node_id) m
  WHERE n.id = m.node_id;

-- Resolve a noderev URN by (node, revision number). rev_no is nullable only for
-- rows inserted before the backfill runs; Postgres treats NULLs as distinct so
-- the unique never blocks them, and every post-migration row carries a value.
CREATE UNIQUE INDEX "node_revisions_node_rev_no_uniq" ON "node_revisions" ("node_id", "rev_no");
