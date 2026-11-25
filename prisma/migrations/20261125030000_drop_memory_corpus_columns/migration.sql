-- #5063 PR 2 (refs #1613): physically remove the three legacy whole-corpus columns of `memories`.
-- Corpus state is derived per node (hrn:node:hadronmemory.com:specs:cor:dmo:120:00, :08, :09): a
-- node's own minted_at is the mint record. PR 1 (#5085, merge 9cf95ca2, deploy-verified in 8e01d932)
-- stopped every writer and re-keyed every reader; the GraphQL field Memory.corpusMintedAt is computed
-- from the nodes and stays.
--
-- contract: depends on PR 1 having shipped (deploy-verified on alpha in merge 8e01d932, team chat
-- #146998). The previous image 8e01d932 (server-info 0.39.0) no longer uses these columns in code, but
-- its Prisma client still SELECTs them (schema.prisma kept them), so every Memory read on that image
-- FAILS with P2022 from the moment this drop applies until the new image serves. Safe only because the
-- alpha deploy stops the old container before the new image migrates (coordinator ruling, team chat
-- #147185, confirmed #147191). A rollback to any pre-drop image needs the reverse DDL below FIRST.
--
-- Plain DROP COLUMN, no HDPRF refusal (gate ruling R5 (a)): the spec promises no memory-level mint
-- record, so the columns hold nothing the corpus guarantees.
--
-- ROLLBACK: after this migration NO pre-drop image can serve, PR 1 included: its Prisma client
-- selects every scalar column, so a Memory read fails with P2022. Recovery is the reverse DDL (run as
-- the owner, under a grant) BEFORE rolling the image back; the columns come back empty, which is safe
-- because PR 1 reads none of them:
--   ALTER TABLE memories ADD COLUMN corpus_draft BOOLEAN NOT NULL DEFAULT false,
--     ADD COLUMN corpus_minted_at TIMESTAMP(3), ADD COLUMN corpus_minted_by TEXT;

ALTER TABLE "memories"
  DROP COLUMN "corpus_draft",
  DROP COLUMN "corpus_minted_at",
  DROP COLUMN "corpus_minted_by";
