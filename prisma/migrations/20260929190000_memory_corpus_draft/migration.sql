-- #1447/#1448: a spec corpus can be created in DRAFT and minted once, one-way.
-- Every existing memory is minted, so the column defaults to false and needs
-- no backfill.
ALTER TABLE "memories" ADD COLUMN "corpus_draft" BOOLEAN NOT NULL DEFAULT false;
