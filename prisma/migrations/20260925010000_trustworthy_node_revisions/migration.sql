-- #1323: make rev_seq name the LIVE state rather than the number of snapshots
-- already taken. Existing history is already numbered r1..rN, while a live
-- row with old rev_seq=N is the state AFTER rN; adding one preserves every
-- NodeRevision.rev_no and makes the live row revision N+1. Fresh rows start at
-- revision 1.
ALTER TABLE "nodes" ALTER COLUMN "rev_seq" SET DEFAULT 1;
UPDATE "nodes" SET "rev_seq" = "rev_seq" + 1;

-- Internal, host-independent safeguard for content changes made by a raw
-- writer that did not advance rev_seq. PostgreSQL md5(text) and Node's
-- createHash('md5').update(text, 'utf8') produce the same lowercase hex. NULL
-- and empty content intentionally share the empty-body fingerprint.
ALTER TABLE "nodes" ADD COLUMN "revision_content_hash" TEXT;
UPDATE "nodes"
SET "revision_content_hash" = md5(COALESCE("content", ''));

-- NULL is a compatibility marker for rows that predate this migration, never
-- the state of a newly inserted node. A DB trigger covers every insertion seam
-- (git sync, clone/extract createMany, chat/system roots, and future writers)
-- instead of relying on an ever-growing application-level inventory.
CREATE OR REPLACE FUNCTION hadron_initialize_node_revision_content_hash()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."revision_content_hash" IS NULL THEN
    NEW."revision_content_hash" := md5(COALESCE(NEW."content", ''));
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS nodes_initialize_revision_content_hash ON "nodes";
CREATE TRIGGER nodes_initialize_revision_content_hash
BEFORE INSERT ON "nodes"
FOR EACH ROW EXECUTE FUNCTION hadron_initialize_node_revision_content_hash();
