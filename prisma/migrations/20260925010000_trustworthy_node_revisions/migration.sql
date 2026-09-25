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
