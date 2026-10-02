-- #1591: per-node minting. A node is minted iff minted_at is set.
ALTER TABLE "nodes"
  ADD COLUMN "minted_at" TIMESTAMP(3),
  ADD COLUMN "minted_by" TEXT,
  ADD COLUMN "minted_by_info" TEXT,
  ADD COLUMN "minted_rev_no" INTEGER,
  ADD COLUMN "minted_hash" TEXT;

-- Backfill (Holger's #1447 round-3 rulings, #1591):
-- 1. A corpus minted through mintSpecCorpus: its nodes were minted then, or at
--    creation for a node added afterwards (which was permanent from birth).
UPDATE "nodes" n SET
  "minted_at" = GREATEST(m."corpus_minted_at", n."created_at"),
  "minted_by" = u."id",
  "minted_by_info" = CASE WHEN u."id" IS NULL THEN COALESCE(m."corpus_minted_by", 'backfill') END
FROM "memories" m
LEFT JOIN "users" u ON u."id" = m."corpus_minted_by"
WHERE n."memory_id" = m."id" AND m."corpus_minted_at" IS NOT NULL;

-- 2. Every memory that was never a draft: its nodes became permanent at creation.
UPDATE "nodes" n SET "minted_at" = n."created_at", "minted_by_info" = 'backfill'
FROM "memories" m
WHERE n."memory_id" = m."id" AND m."corpus_minted_at" IS NULL AND m."corpus_draft" = false;

-- 3. Nodes of an unminted draft corpus stay unminted.

-- #1591: a mint record is complete or absent. Synced with prisma/post-push.sql
-- and src/test/globalSetup.ts.
ALTER TABLE "nodes" ADD CONSTRAINT "chk_node_mint_complete" CHECK (CASE
  WHEN "minted_at" IS NULL THEN
    "minted_by" IS NULL AND "minted_by_info" IS NULL AND "minted_rev_no" IS NULL AND "minted_hash" IS NULL
  ELSE
    ("minted_by" IS NOT NULL OR "minted_by_info" IS NOT NULL)
      AND ("minted_rev_no" IS NULL) = ("minted_hash" IS NULL)
      AND ("minted_rev_no" IS NULL OR "minted_rev_no" > 0)
  END);
