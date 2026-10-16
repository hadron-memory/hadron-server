-- #1611, cor:dmo:120:04 / 120:05: an approval stays valid until the hashed
-- content (title, abstract, content under approval-hash v1) changes. The
-- revision at which that content last changed is tracked here; the approval
-- of record keeps naming the revision it was recorded at.
--
-- Legacy rows: the default 1 is correct for a node still at its first
-- revision. A node that has an approval and has moved past its approved
-- revision is backfilled to its CURRENT revision: its content history is not
-- known, so it stays SUPERSEDED exactly as it reads today (never a false
-- APPROVED); re-approving it restores the new semantics. A node whose
-- current revision is approved keeps the default, so it stays APPROVED, and
-- verifyNode still recomputes its hash (a tampered one stays TAMPERED).
ALTER TABLE "nodes" ADD COLUMN IF NOT EXISTS "content_rev_seq" INTEGER NOT NULL DEFAULT 1;

UPDATE "nodes" SET "content_rev_seq" = "rev_seq"
WHERE "approved_rev_no" IS NOT NULL AND "approved_rev_no" < "rev_seq";

CREATE OR REPLACE FUNCTION hadron_initialize_node_revision_content_hash()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW."revision_content_hash" = 'refresh' THEN
    NEW."revision_content_hash" := hadron_node_revision_state_hash(NEW);
    -- #1611 (cor:dmo:120:04): the content-change boundary moves only through a
    -- SANCTIONED writer (the same 'refresh' marker as the fingerprint above) and
    -- only when the three approval-hashed fields change under approval-hash v1
    -- normalization (CRLF and lone CR become LF; nothing else). A write outside
    -- the revision system never moves it, so its content change stays
    -- detectable as TAMPERED instead of passing for a supported edit.
    IF TG_OP = 'INSERT' THEN
      NEW."content_rev_seq" := NEW."rev_seq";
    ELSIF NEW."name" IS DISTINCT FROM OLD."name"
      OR replace(replace(NEW."abstract", E'\r\n', E'\n'), E'\r', E'\n')
         IS DISTINCT FROM replace(replace(OLD."abstract", E'\r\n', E'\n'), E'\r', E'\n')
      OR replace(replace(NEW."content", E'\r\n', E'\n'), E'\r', E'\n')
         IS DISTINCT FROM replace(replace(OLD."content", E'\r\n', E'\n'), E'\r', E'\n') THEN
      NEW."content_rev_seq" := NEW."rev_seq";
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- The trigger itself (nodes_initialize_revision_content_hash) is unchanged and
-- keeps pointing at this function.
