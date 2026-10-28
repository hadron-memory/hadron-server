-- #1838 (cor:dmo:120:04): entering an encrypted memory ends a node's approval by
-- clearing its hash and keeping who/when/revision. The completeness check must
-- therefore allow a NULL approval_hash on an otherwise complete approval.
-- Relaxing only: every row valid before stays valid, nothing is rewritten.
ALTER TABLE "nodes" DROP CONSTRAINT IF EXISTS "chk_node_approval_complete";
ALTER TABLE "nodes" ADD CONSTRAINT "chk_node_approval_complete" CHECK (CASE
  WHEN "approved_rev_no" IS NULL THEN
    "approved_at" IS NULL AND "approval_hash" IS NULL AND "approved_by" IS NULL AND "approved_by_info" IS NULL
  ELSE
    "approved_rev_no" > 0 AND "approved_at" IS NOT NULL
      AND ("approved_by" IS NOT NULL OR "approved_by_info" IS NOT NULL)
  END);
