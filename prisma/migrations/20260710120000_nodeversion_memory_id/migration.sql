-- NodeVersion.memoryId (#602 / Codex P1): record the memory each snapshot's
-- content belonged to at capture time. A node can be MOVED across memories
-- (moveNode keeps the stable id + snapshots the pre-move state), so gating
-- version history by the node's CURRENT memory alone leaks snapshots captured
-- while the node lived in a memory the caller can't read. See NodeVersion in
-- prisma/schema.prisma and the nodeVersions resolver's per-row gate.

-- AlterTable (nullable — no NOT NULL so the additive column applies cleanly to
-- an already-populated table).
ALTER TABLE "node_versions" ADD COLUMN "memory_id" TEXT;

-- Backfill legacy rows to the node's CURRENT memory. Best effort: for a node
-- that has already been moved, its pre-move snapshots get the current memory
-- (the true historical memory isn't recoverable) — an accepted legacy gap.
-- Going forward every snapshot site stamps the correct memory.
UPDATE "node_versions" v
SET "memory_id" = n."memory_id"
FROM "nodes" n
WHERE v."node_id" = n."id" AND v."memory_id" IS NULL;
