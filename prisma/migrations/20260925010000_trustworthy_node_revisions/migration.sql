-- #1323: make rev_seq name the LIVE state rather than the number of snapshots
-- already taken. Existing history is already numbered r1..rN, while a live
-- row with old rev_seq=N is the state AFTER rN; adding one preserves every
-- NodeRevision.rev_no and makes the live row revision N+1. Fresh rows start at
-- revision 1.
ALTER TABLE "nodes" ALTER COLUMN "rev_seq" SET DEFAULT 1;
UPDATE "nodes" SET "rev_seq" = "rev_seq" + 1;

-- Internal, host-independent safeguard for any revisioned-field change made by
-- a raw writer that did not advance rev_seq. Keep the canonical encoding in
-- PostgreSQL: JSONB/array stringification is not portable across runtimes.
ALTER TABLE "nodes" ADD COLUMN "revision_content_hash" TEXT;

CREATE OR REPLACE FUNCTION hadron_node_revision_state_hash(node_row "nodes")
RETURNS TEXT
LANGUAGE sql
IMMUTABLE AS $$
  SELECT md5(jsonb_build_array(
    node_row."memory_id", node_row."loc", node_row."name", node_row."alias",
    node_row."description", node_row."abstract", node_row."abstract_origin_hash",
    node_row."content", to_jsonb(node_row."tags"), node_row."node_type",
    node_row."object_type", node_row."is_link", node_row."properties",
    node_row."data", node_row."seq", node_row."is_runnable", node_row."role",
    node_row."llm_model", node_row."ai_agent"
  )::text)
$$;

UPDATE "nodes"
SET "revision_content_hash" = hadron_node_revision_state_hash("nodes");

-- NULL is a compatibility marker for rows that predate this migration, never
-- the state of a newly inserted node. A DB trigger covers every insertion seam
-- (git sync, clone/extract createMany, chat/system roots, and future writers)
-- instead of relying on an ever-growing application-level inventory.
CREATE OR REPLACE FUNCTION hadron_initialize_node_revision_content_hash()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW."revision_content_hash" = 'refresh' THEN
    NEW."revision_content_hash" := hadron_node_revision_state_hash(NEW);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS nodes_initialize_revision_content_hash ON "nodes";
CREATE TRIGGER nodes_initialize_revision_content_hash
BEFORE INSERT OR UPDATE ON "nodes"
FOR EACH ROW EXECUTE FUNCTION hadron_initialize_node_revision_content_hash();
