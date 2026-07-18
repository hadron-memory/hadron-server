-- Migration: node_object_type
-- Spec: #725 — structured storage. Adds the collection discriminator column
-- Node.objectType (the MongoDB-collection equivalent): which domain object a
-- node is an instance of (e.g. "competitor" / "insight"), orthogonal to
-- nodeType (the platform-kind axis). Nullable — NULL for ordinary nodes.
--
-- Plain Prisma-modeled column + composite index (both expressible in
-- schema.prisma), so `db push` creates them on dev/test and there is nothing to
-- mirror in post-push.sql. The index backs the "list all nodes of collection X
-- in this memory" facet.

BEGIN;

ALTER TABLE "nodes" ADD COLUMN "object_type" TEXT;
CREATE INDEX "nodes_memory_id_object_type_idx" ON "nodes"("memory_id", "object_type");

-- Version objectType in the NodeRevision curated subset (parity with nodeType),
-- so restoring a pre-edit revision recovers the collection classification.
ALTER TABLE "node_revisions" ADD COLUMN "object_type" TEXT;

COMMIT;
