-- Rename NodeVersion → NodeRevision (follow-up to #620/#622).
--
-- "Revision" is the industry term for an automatic per-edit history row
-- (MediaWiki/Drive/WordPress); "version" is reserved for a future deliberate
-- blessed-state concept (the approve flow approved_by foreshadows). Pure
-- metadata renames — instant regardless of row count; no data is touched.
-- Coordinated breaking rename of the GraphQL surface ships in the same PR
-- (nodeRevisions / nodeRevision / restoreNodeRevision / deleteNodeRevision /
-- updateNodeRevision, arg revisionId).

ALTER TABLE "node_versions" RENAME TO "node_revisions";

-- Keep index/constraint names in sync with what Prisma would generate for
-- the renamed model, so `migrate diff` stays clean.
ALTER INDEX "node_versions_pkey" RENAME TO "node_revisions_pkey";
ALTER INDEX "node_versions_node_id_created_at_idx" RENAME TO "node_revisions_node_id_created_at_idx";
ALTER TABLE "node_revisions" RENAME CONSTRAINT "node_versions_node_id_fkey" TO "node_revisions_node_id_fkey";
ALTER TABLE "node_revisions" RENAME CONSTRAINT "node_versions_approved_by_fkey" TO "node_revisions_approved_by_fkey";
