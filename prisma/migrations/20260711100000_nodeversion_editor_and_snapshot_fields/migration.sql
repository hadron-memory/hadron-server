-- #620 — NodeVersion editor split + full curated-subset snapshot fields.
--
-- 1. Snapshot columns that were missing from the curated subset (node_type,
--    is_link, properties, data, seq, is_runnable, llm_model, ai_agent). All
--    nullable: a NULL node_type marks a LEGACY snapshot captured before these
--    columns existed (node_type is non-null on nodes, so every new snapshot
--    sets it) — restoreNodeVersion keys on that sentinel and leaves the live
--    node's values untouched rather than wiping them to NULL.
-- 2. Editor split: edited_by historically held `reason ?? clientId ?? userId`
--    (an edit rationale, an OAuth identity string like "github:<login>", or a
--    User id). Going forward edited_by holds ONLY a User id; identity strings
--    live in edited_by_info and edit rationales in rev_label (the
--    user-settable version label, which also absorbs the #88 `reason` on new
--    snapshots); changes records which fields the edit that took the snapshot
--    modified; approved_by is reserved for the future approve flow (FK to
--    users).

-- AlterTable (all additive + nullable — applies cleanly to a populated table).
ALTER TABLE "node_versions"
  ADD COLUMN "node_type" TEXT,
  ADD COLUMN "is_link" BOOLEAN,
  ADD COLUMN "properties" JSONB,
  ADD COLUMN "data" JSONB,
  ADD COLUMN "seq" INTEGER,
  ADD COLUMN "is_runnable" BOOLEAN,
  ADD COLUMN "llm_model" TEXT,
  ADD COLUMN "ai_agent" TEXT,
  ADD COLUMN "edited_by_info" TEXT,
  ADD COLUMN "rev_label" TEXT,
  ADD COLUMN "changes" TEXT[],
  ADD COLUMN "approved_by" TEXT;

-- AddForeignKey — approved_by references users; survives user hard-deletes as
-- NULL (approval provenance is best-effort, not load-bearing).
ALTER TABLE "node_versions"
  ADD CONSTRAINT "node_versions_approved_by_fkey"
  FOREIGN KEY ("approved_by") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Data migration, step 1a: move IDENTITY-STRING edited_by values (the
-- AuthContext.clientId forms) into edited_by_info. These are mechanically
-- distinguishable by prefix; anything else non-PK is an edit rationale.
UPDATE "node_versions" v
SET "edited_by_info" = v."edited_by",
    "edited_by" = NULL
WHERE v."edited_by" IS NOT NULL
  AND (v."edited_by" LIKE 'github:%'
    OR v."edited_by" LIKE 'email:%'
    OR v."edited_by" LIKE 'user:%'
    OR v."edited_by" LIKE 'app:%')
  AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u."id" = v."edited_by");

-- Data migration, step 1b: every remaining non-User-id edited_by value is a
-- legacy #88 edit reason or a git commit message → rev_label, the column that
-- carries the edit rationale going forward (preserved verbatim).
UPDATE "node_versions" v
SET "rev_label" = v."edited_by",
    "edited_by" = NULL
WHERE v."edited_by" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u."id" = v."edited_by");

-- Data migration, step 2: backfill edited_by from created_by where that holds
-- a User id. Snapshot sites captured created_by as `userId ?? clientId` (user
-- preferred) vs edited_by's `reason ?? clientId ?? userId` (user LAST), so for
-- most portal/API edits created_by already carries the editing user (#619).
UPDATE "node_versions" v
SET "edited_by" = v."created_by"
WHERE v."edited_by" IS NULL
  AND v."created_by" IS NOT NULL
  AND EXISTS (SELECT 1 FROM "users" u WHERE u."id" = v."created_by");
