-- #1450: a reserved spec citation (placeholder) in a draft corpus. Server-set;
-- every existing node is a real node, so the default needs no backfill.
ALTER TABLE "nodes" ADD COLUMN "is_placeholder" BOOLEAN NOT NULL DEFAULT false;
