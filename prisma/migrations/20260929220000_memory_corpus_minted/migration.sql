-- #1448: record when (and by whom) a draft spec corpus was minted. Null for
-- every existing memory, which was never a draft.
ALTER TABLE "memories" ADD COLUMN "corpus_minted_at" TIMESTAMP(3);
ALTER TABLE "memories" ADD COLUMN "corpus_minted_by" TEXT;
