-- #2040: kind-aware governed-edge triggers. Verbatim copy of the changed parts of
-- prisma/comment-invariants.sql (the one source); the enum value committed in
-- 20261018230000_include_edge_kind.

-- #1606 / #1607 — comment-node invariants (`cor:dmo:110`). The ONE source of
-- this SQL: included verbatim by prisma/post-push.sql (dev DB, test template,
-- CI) and copied into the newest comment migration (prod, which does not run
-- post-push.sql): 20261005200000_comment_nodes, then #1721's
-- 20261010100000_comment_rulings, then the anchor CHECK in #1857
-- 20261013170000_encrypted_comment_anchor_nullable, then #1869's insert check in
-- 20261013180000_encrypted_anchor_hash_scrub, then #1935's commentable system
-- memories in 20261015100000_system_memories_commentable, then #2040's kind-aware
-- governed-edge triggers (INCLUDE) in 20261018230100_include_edges_lifecycle. Change it only together with a new
-- migration that carries the new text. Idempotent.
--
-- The application path refuses every case first with a typed error; these are
-- the backstop that makes a path bug fail loudly instead of corrupting.

-- A comment is never approved or minted (cor:dmo:110:06).
ALTER TABLE "nodes" DROP CONSTRAINT IF EXISTS "chk_nodes_comment_unapproved";
ALTER TABLE "nodes" ADD CONSTRAINT "chk_nodes_comment_unapproved" CHECK (
  "node_type" <> 'comment'
  OR ("approved_rev_no" IS NULL AND "approval_hash" IS NULL AND "minted_at" IS NULL AND "minted_hash" IS NULL));

-- An anchor carries its revision and an optional hash; other edges carry neither (cor:dmo:110:01).
ALTER TABLE "edges" DROP CONSTRAINT IF EXISTS "chk_edges_governed_anchor";
ALTER TABLE "edges" ADD CONSTRAINT "chk_edges_governed_anchor" CHECK (
  ("governed_kind" IS NOT DISTINCT FROM 'COMMENT_ANCHOR')
    = ("anchor_rev_no" IS NOT NULL)
  AND ("governed_kind" IS NOT DISTINCT FROM 'COMMENT_ANCHOR' OR "anchor_approval_hash" IS NULL)
  AND ("anchor_rev_no" IS NULL OR "anchor_rev_no" > 0)
  AND ("anchor_approval_hash" IS NULL OR "anchor_approval_hash" ~ '^[0-9a-f]{64}$'));

-- A thread state belongs to a top-level comment, and only to one.
ALTER TABLE "comment_meta" DROP CONSTRAINT IF EXISTS "chk_comment_meta_state_top_level";
ALTER TABLE "comment_meta" ADD CONSTRAINT "chk_comment_meta_state_top_level" CHECK (
  ("thread_root_id" IS NULL) = ("thread_state" IS NOT NULL)
  AND "author_key" ~ '^(w:[^:]+|ua:[^:]+:[^:]+|u:[^:]+|app:[^:]+)$'
  AND ("thread_deleted_at" IS NULL) = ("thread_deleted_cause" IS NULL)
  AND ("thread_deleted_cause" IS NULL OR "thread_deleted_cause" IN ('ADMIN', 'AUTHOR', 'MANAGER', 'TARGET')));

-- One open, live top-level thread per (target, author) (cor:dmo:110:05).
CREATE UNIQUE INDEX IF NOT EXISTS "comment_meta_one_open_thread"
  ON "comment_meta" ("target_node_id", "author_key")
  WHERE "thread_root_id" IS NULL AND "thread_state" = 'OPEN'
    AND "retracted_at" IS NULL AND "thread_deleted_at" IS NULL;

-- The whole-shape check of one comment node, run at COMMIT (deferred), so the
-- comment path may insert the node, its meta and its edge in any order.
CREATE OR REPLACE FUNCTION hadron_check_comment_node(p_node_id TEXT) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  n RECORD; m RECORD; t RECORD; r RECORD; mem_class TEXT; edge_count INT; want_kind "EdgeGovernedKind"; want_target TEXT;
BEGIN
  SELECT id, node_type, memory_id, deleted_at INTO n FROM nodes WHERE id = p_node_id;
  SELECT * INTO m FROM comment_meta WHERE node_id = p_node_id;
  IF n.id IS NULL THEN
    RETURN; -- deleted (its meta cascades with it)
  END IF;
  IF n.node_type <> 'comment' THEN
    IF m.node_id IS NOT NULL THEN
      RAISE EXCEPTION 'COMMENT_INVARIANT: node % has comment_meta but is not a comment', p_node_id USING ERRCODE = 'check_violation';
    END IF;
    RETURN;
  END IF;
  IF m.node_id IS NULL THEN
    RAISE EXCEPTION 'COMMENT_INVARIANT: comment node % has no comment_meta (only the comment path creates a comment)', p_node_id USING ERRCODE = 'check_violation';
  END IF;
  SELECT id, node_type, memory_id INTO t FROM nodes WHERE id = m.target_node_id;
  IF t.node_type = 'comment' THEN
    RAISE EXCEPTION 'COMMENT_INVARIANT: comment % targets another comment', p_node_id USING ERRCODE = 'check_violation';
  END IF;
  IF t.memory_id IS DISTINCT FROM n.memory_id THEN
    RAISE EXCEPTION 'COMMENT_INVARIANT: comment % is not in its target''s memory', p_node_id USING ERRCODE = 'check_violation';
  END IF;
  -- Only a LIVE comment needs a commentable memory: a deleted thread is gone
  -- from every check (cor:dmo:110:05) but keeps its history, so it may follow
  -- its target into a private memory (cor:dmo:110:02; system memories are
  -- commentable since #1935).
  SELECT class INTO mem_class FROM memories WHERE id = n.memory_id;
  IF n.deleted_at IS NULL AND (mem_class IS NULL OR mem_class NOT IN ('app', 'knowledge', 'personal', 'group', 'system')) THEN
    RAISE EXCEPTION 'COMMENT_INVARIANT: comment % is in a % memory, which is not commentable', p_node_id, mem_class USING ERRCODE = 'check_violation';
  END IF;
  IF m.thread_root_id IS NOT NULL THEN
    SELECT cm.thread_root_id, cm.target_node_id, rn.memory_id INTO r
      FROM comment_meta cm JOIN nodes rn ON rn.id = cm.node_id WHERE cm.node_id = m.thread_root_id;
    IF r.target_node_id IS NULL OR r.thread_root_id IS NOT NULL
       OR r.target_node_id <> m.target_node_id OR r.memory_id <> n.memory_id THEN
      RAISE EXCEPTION 'COMMENT_INVARIANT: reply % does not belong to a top-level comment on its target', p_node_id USING ERRCODE = 'check_violation';
    END IF;
    want_kind := 'COMMENT_REPLY'; want_target := m.thread_root_id;
  ELSE
    want_kind := 'COMMENT_ANCHOR'; want_target := m.target_node_id;
  END IF;
  SELECT count(*) INTO edge_count FROM edges WHERE source_id = p_node_id AND governed_kind IN ('COMMENT_ANCHOR', 'COMMENT_REPLY');
  IF edge_count <> 1 OR NOT EXISTS (
    SELECT 1 FROM edges WHERE source_id = p_node_id AND governed_kind = want_kind AND target_id = want_target
  ) THEN
    RAISE EXCEPTION 'COMMENT_INVARIANT: comment % must have exactly one % edge to %', p_node_id, want_kind, want_target USING ERRCODE = 'check_violation';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION hadron_comment_node_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE c RECORD; target_encrypted BOOLEAN;
BEGIN
  IF TG_TABLE_NAME = 'nodes' THEN
    PERFORM hadron_check_comment_node(NEW.id);
    -- A commented target that changes memory must take its threads along.
    IF TG_OP = 'UPDATE' AND OLD.memory_id IS DISTINCT FROM NEW.memory_id THEN
      FOR c IN SELECT node_id FROM comment_meta WHERE target_node_id = NEW.id LOOP
        PERFORM hadron_check_comment_node(c.node_id);
      END LOOP;
    END IF;
  ELSIF TG_TABLE_NAME = 'comment_meta' THEN
    PERFORM hadron_check_comment_node(CASE WHEN TG_OP = 'DELETE' THEN OLD.node_id ELSE NEW.node_id END);
  ELSIF TG_TABLE_NAME = 'edges' THEN
    -- An anchor is born with a hash exactly when its target is plaintext
    -- (cor:dmo:110:01; #1869, Rook's #1866 P3-3). Checked at insert only: a
    -- thread that later moves, or whose memory is later encrypted, keeps its row.
    IF NEW.governed_kind = 'COMMENT_ANCHOR' THEN
      SELECT m.is_encrypted INTO target_encrypted
        FROM nodes t JOIN memories m ON m.id = t.memory_id WHERE t.id = NEW.target_id;
      IF target_encrypted AND NEW.anchor_approval_hash IS NOT NULL THEN
        RAISE EXCEPTION 'COMMENT_INVARIANT: anchor % of comment % carries a hash, but its target is in an encrypted memory', NEW.id, NEW.source_id USING ERRCODE = 'check_violation';
      ELSIF NOT target_encrypted AND NEW.anchor_approval_hash IS NULL THEN
        RAISE EXCEPTION 'COMMENT_INVARIANT: anchor % of comment % has no hash, but its target is in a plaintext memory', NEW.id, NEW.source_id USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    PERFORM hadron_check_comment_node(NEW.source_id);
  ELSIF TG_TABLE_NAME = 'memories' THEN
    FOR c IN SELECT cm.node_id FROM comment_meta cm JOIN nodes n ON n.id = cm.node_id WHERE n.memory_id = NEW.id LOOP
      PERFORM hadron_check_comment_node(c.node_id);
    END LOOP;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS nodes_comment_insert ON "nodes";
CREATE CONSTRAINT TRIGGER nodes_comment_insert AFTER INSERT ON "nodes"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW.node_type = 'comment')
  EXECUTE FUNCTION hadron_comment_node_changed();
DROP TRIGGER IF EXISTS nodes_comment_update ON "nodes";
CREATE CONSTRAINT TRIGGER nodes_comment_update AFTER UPDATE OF node_type, memory_id, deleted_at ON "nodes"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW.node_type = 'comment' OR OLD.node_type = 'comment' OR OLD.memory_id IS DISTINCT FROM NEW.memory_id)
  EXECUTE FUNCTION hadron_comment_node_changed();
DROP TRIGGER IF EXISTS comment_meta_changed ON "comment_meta";
CREATE CONSTRAINT TRIGGER comment_meta_changed AFTER INSERT OR UPDATE OR DELETE ON "comment_meta"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION hadron_comment_node_changed();
DROP TRIGGER IF EXISTS edges_governed_insert ON "edges";
CREATE CONSTRAINT TRIGGER edges_governed_insert AFTER INSERT ON "edges"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW.governed_kind IN ('COMMENT_ANCHOR', 'COMMENT_REPLY'))
  EXECUTE FUNCTION hadron_comment_node_changed();
DROP TRIGGER IF EXISTS memories_comment_class ON "memories";
CREATE CONSTRAINT TRIGGER memories_comment_class AFTER UPDATE OF class ON "memories"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD.class IS DISTINCT FROM NEW.class)
  EXECUTE FUNCTION hadron_comment_node_changed();

-- Governed edges are immutable (cor:dmo:110:01/04). The memory column may
-- follow a cross-memory move of the thread; nothing else changes. A delete is
-- allowed only as part of deleting the comment node (or its whole memory).
CREATE OR REPLACE FUNCTION hadron_edges_governed_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- A kind never changes once set (INCLUDE rows included), and a comment edge
    -- keeps its identity. INCLUDE rows (#2040) are replaced by delete + insert
    -- by the derived-edge sync, never rewritten in place.
    IF OLD.governed_kind = 'INCLUDE' AND NEW.governed_kind IS NOT DISTINCT FROM 'INCLUDE' THEN
      IF OLD.source_id <> NEW.source_id OR OLD.target_id <> NEW.target_id OR OLD.loc <> NEW.loc
         OR OLD.name IS DISTINCT FROM NEW.name OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at THEN
        RAISE EXCEPTION 'COMMENT_INVARIANT: derived include edge % is immutable (replace it by delete and insert)', OLD.id USING ERRCODE = 'check_violation';
      END IF;
    ELSIF OLD.governed_kind IS DISTINCT FROM NEW.governed_kind
       OR (OLD.governed_kind IN ('COMMENT_ANCHOR', 'COMMENT_REPLY') AND (
         OLD.source_id <> NEW.source_id OR OLD.target_id <> NEW.target_id OR OLD.loc <> NEW.loc
         OR OLD.anchor_rev_no IS DISTINCT FROM NEW.anchor_rev_no
         OR OLD.anchor_approval_hash IS DISTINCT FROM NEW.anchor_approval_hash
         OR OLD.name IS DISTINCT FROM NEW.name
         OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)) THEN
      RAISE EXCEPTION 'COMMENT_INVARIANT: governed comment edge % is immutable', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.governed_kind IN ('COMMENT_ANCHOR', 'COMMENT_REPLY')
     AND EXISTS (SELECT 1 FROM nodes WHERE id = OLD.source_id)
     AND EXISTS (SELECT 1 FROM memories WHERE id = OLD.memory_id) THEN
    RAISE EXCEPTION 'COMMENT_INVARIANT: governed comment edge % is removed only with its comment', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS edges_governed_immutable ON "edges";
CREATE TRIGGER edges_governed_immutable BEFORE UPDATE OR DELETE ON "edges"
  FOR EACH ROW EXECUTE FUNCTION hadron_edges_governed_immutable();

-- A comment's target, thread and author never change (cor:dmo:110:01/05).
CREATE OR REPLACE FUNCTION hadron_comment_meta_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.node_id <> NEW.node_id OR OLD.target_node_id <> NEW.target_node_id
     OR OLD.thread_root_id IS DISTINCT FROM NEW.thread_root_id OR OLD.author_key <> NEW.author_key THEN
    RAISE EXCEPTION 'COMMENT_INVARIANT: a comment''s target, thread and author are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS comment_meta_immutable ON "comment_meta";
CREATE TRIGGER comment_meta_immutable BEFORE UPDATE ON "comment_meta"
  FOR EACH ROW EXECUTE FUNCTION hadron_comment_meta_immutable();
