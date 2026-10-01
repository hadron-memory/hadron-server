-- #1591: node approvals. The live node holds its latest approval; a
-- NodeRevision row keeps the approval of the revision it snapshots.
ALTER TABLE "nodes"
  ADD COLUMN "approved_rev_no" INTEGER,
  ADD COLUMN "approved_by" TEXT,
  ADD COLUMN "approved_by_info" TEXT,
  ADD COLUMN "approved_at" TIMESTAMP(3),
  ADD COLUMN "approval_hash" TEXT;

-- #1591: an approval is a positive revision, a time, a hash and a principal,
-- or nothing. Synced with prisma/post-push.sql and src/test/globalSetup.ts.
ALTER TABLE "nodes" ADD CONSTRAINT "chk_node_approval_complete" CHECK (CASE
  WHEN "approved_rev_no" IS NULL THEN
    "approved_at" IS NULL AND "approval_hash" IS NULL AND "approved_by" IS NULL AND "approved_by_info" IS NULL
  ELSE
    "approved_rev_no" > 0 AND "approved_at" IS NOT NULL AND "approval_hash" IS NOT NULL
      AND ("approved_by" IS NOT NULL OR "approved_by_info" IS NOT NULL)
  END);

ALTER TABLE "node_revisions"
  ADD COLUMN "approved_by_info" TEXT,
  ADD COLUMN "approved_at" TIMESTAMP(3),
  ADD COLUMN "approval_hash" TEXT;
