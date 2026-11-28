-- #430: the Git-mirror obligation's shape. One source, shared verbatim with migration
-- 20261117800000_git_mirror_push_rejected (#3234 added PUSH_REJECTED), migration
-- 20261122140000_git_mirror_remove_pending (#425 added PENDING and the nodes triggers), and applied by
-- post-push.sql and the test globalSetup (pinned by src/integrations/github/mirrorObligations430.test.ts
-- and src/integrations/github/nodeDeleteMirror425.test.ts).
--
-- `error_class` is a CLOSED set of fixed words, never exception text: a raw Git error can carry an installation-token URL
-- (findings:git-execfile-error-carries-auth-url), so nothing free-form is storable here. A NOT_CLONED row says so in both
-- columns; a PENDING row (a #425 captured delete debt, born from the trigger below before any attempt) says so in both
-- columns too, and NO other state wears that word (a debt that was never attempted cannot have failed, let alone
-- exhausted its retries); a FAILED row can wear neither word. A REMOVE row names the old loc it must vacate; a WRITE row
-- has none. `attempts` and `attempt_seq` only grow.
CREATE SEQUENCE IF NOT EXISTS git_mirror_attempt_seq AS bigint;
ALTER TABLE git_mirror_obligations DROP CONSTRAINT IF EXISTS chk_git_mirror_obligation_shape;
ALTER TABLE git_mirror_obligations ADD CONSTRAINT chk_git_mirror_obligation_shape CHECK (
  error_class IN ('TOKEN_UNAVAILABLE', 'BRANCH_SETUP', 'TREE_WRITE', 'PUSH_FAILED', 'PUSH_REJECTED', 'LOCK_FAILED', 'NOT_CLONED', 'PENDING') AND
  ((state::text = 'NOT_CLONED' AND error_class = 'NOT_CLONED') OR
   (state::text = 'FAILED' AND error_class NOT IN ('NOT_CLONED', 'PENDING')) OR
   (state::text = 'PENDING' AND error_class = 'PENDING') OR
   (state::text = 'EXHAUSTED' AND error_class <> 'PENDING')) AND
  ((kind = 'WRITE' AND remove_loc = '') OR (kind = 'REMOVE' AND remove_loc <> '')) AND
  attempts >= 1
);

-- #425: node deletes propagate to the Git mirror. Deleting a node in a Git-synced, unencrypted, live
-- memory owes the repository the removal of the node's file; a DB trigger captures that debt the moment
-- the row goes (soft or hard) as a PENDING REMOVE obligation the existing retry sweep applies
-- (src/jobs/sweepGitMirrorObligations.ts). No import is skipped: the capture is one PK lookup on
-- memories per deleted row — a memory without a source, an encrypted memory (R206: it never syncs, so
-- there is nothing to remove), a user-owned memory with no org, and a memory deleted ahead of the node
-- (the FK cascade reaches child nodes after the parent row is already gone) all owe nothing. That last
-- miss is what keeps a memory delete succeeding: inserting against a gone parent would violate the
-- obligations foreign key and abort the delete (cor:api:190:02 — an unreachable or dying repository
-- never fails the database write). A root (loc '') owes nothing: its file is the memory's README, which
-- a node delete must not remove (the #425 ruling; same shape as mirrorNodeMove's vacated-loc filter).
-- The insert is ON CONFLICT DO NOTHING: a colliding row already owes this removal, and it never
-- disturbs a settled row's attempts or fence. `branch` records the write branch the memory had at
-- capture (COALESCE(write_branch, 'hadron-updates')), the branch the file was mirrored to. A `{client}`
-- template branch owes nothing: the capture has no client identity to substitute, and the eligibility
-- predicates accept the raw template as fitting itself (findings:raw-template-branch-fits-itself), so
-- a row keyed on it would be routed to a literal client/{client} branch. #3042's posture holds — retries
-- never substitute an unknown client — so a delete in a templated memory does not propagate, as on main today.
CREATE OR REPLACE FUNCTION hadron_git_mirror_capture_node_removal() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $capture$
DECLARE
  v_branch text;
BEGIN
  -- #5469: a node that goes owes no file write. Drop its WRITE debt (every branch) first, so the sweep can never apply a
  -- WRITE after this REMOVE; the REMOVE below is the only debt that survives. Not gated on eligibility: a row for a
  -- memory that stopped being mirrored is just as dead, and a cascade from a deleted memory removes it anyway.
  DELETE FROM git_mirror_obligations WHERE memory_id = OLD.memory_id AND node_id = OLD.id AND kind = 'WRITE';
  SELECT COALESCE(write_branch, 'hadron-updates') INTO v_branch
  FROM memories
  WHERE id = OLD.memory_id AND source IS NOT NULL AND NOT is_encrypted
    AND organization_id IS NOT NULL AND deleted_at IS NULL
    AND position('{client}' in COALESCE(write_branch, 'hadron-updates')) = 0;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  INSERT INTO git_mirror_obligations
    (memory_id, node_id, kind, remove_loc, branch, state, error_class, attempts, attempt_seq, last_attempt_at)
  VALUES
    (OLD.memory_id, OLD.id, 'REMOVE', OLD.loc, v_branch, 'PENDING', 'PENDING', 1,
     nextval('git_mirror_attempt_seq'), (now() AT TIME ZONE 'UTC'))
  ON CONFLICT (memory_id, node_id, kind, remove_loc, branch) DO NOTHING;
  RETURN NULL;
END
$capture$;

DROP TRIGGER IF EXISTS git_mirror_node_remove_capture ON nodes;
CREATE TRIGGER git_mirror_node_remove_capture AFTER DELETE ON nodes
  FOR EACH ROW WHEN (OLD.loc <> '')
  EXECUTE FUNCTION hadron_git_mirror_capture_node_removal();

DROP TRIGGER IF EXISTS git_mirror_node_remove_soft_delete ON nodes;
CREATE TRIGGER git_mirror_node_remove_soft_delete AFTER UPDATE OF deleted_at ON nodes
  FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL AND OLD.loc <> '')
  EXECUTE FUNCTION hadron_git_mirror_capture_node_removal();

-- #425: a restore (deleted_at cleared — including the upsert resurrection in deleteNode) cancels the
-- node's unapplied capture: the ordinary mirror write re-writes the file, and an applied debt is
-- already gone. PENDING rows go, and so does any row naming the node's own current loc (remove_loc =
-- NEW.loc): an EXHAUSTED own-loc capture would otherwise be reported as a mirror failure forever after
-- the restore, because the sweep no longer selects it (a FAILED one self-heals — the sweep retries it,
-- sees a live node owning the loc, and clears it without Git). A row naming some OTHER loc stays: that
-- is a move's vacated-loc debt, which the move still owes.
CREATE OR REPLACE FUNCTION hadron_git_mirror_cancel_node_removal() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $cancel$
BEGIN
  DELETE FROM git_mirror_obligations
  WHERE memory_id = NEW.memory_id AND node_id = NEW.id
    AND kind = 'REMOVE' AND (state = 'PENDING' OR remove_loc = NEW.loc);
  RETURN NULL;
END
$cancel$;

DROP TRIGGER IF EXISTS git_mirror_node_remove_restore ON nodes;
CREATE TRIGGER git_mirror_node_remove_restore AFTER UPDATE OF deleted_at ON nodes
  FOR EACH ROW WHEN (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL)
  EXECUTE FUNCTION hadron_git_mirror_cancel_node_removal();

-- #5469 (the rest of #430; Holger 2026-11-16, option a): a node WRITE owes the repository its file. The ordinary mirror is a
-- fire-and-forget call after the write commits, so a process that dies between the commit and the attempt left no row for
-- the sweep to retry. This trigger records the debt in the writer's own transaction, as a PENDING WRITE obligation the
-- existing sweep applies (it reads the node fresh), and a successful ordinary mirror settles it (settleMirrorObligations
-- deletes rows whose attempt_seq is below the attempt's).
--
-- Fires on INSERT, and on UPDATE of exactly the columns the mirrored file carries (FrontmatterNodeFields plus the body, as
-- writeNodeToGit serializes them); a WHEN requires one of them to differ, so an update of only embedding, token, revision,
-- approval, mint or updated_* columns captures nothing (the hot path: the function body never runs for them). A live
-- node only (a deleted one owes the REMOVE capture above), and never a root (loc ''): its file is the memory's README.
-- Edges are in the frontmatter but live in `edges`, so an edges-only change is NOT captured here (a stated limit).
--
-- Eligibility is the REMOVE capture's, in one primary-key lookup on memories: Git-sourced, unencrypted, org-owned, live
-- memory with no {client} template branch. A memory deleted ahead of its nodes owes nothing, which keeps a memory delete
-- and a write inside the same transaction from aborting on the obligations foreign key (cor:api:190:02: a dying
-- repository never fails the database write). The capture never raises for a condition it can see; it only inserts.
--
-- The row's key is (memory_id, node_id, 'WRITE', '', branch), so repeated writes of one node collapse to one row. On a
-- conflict the row is re-fenced rather than left alone: attempt_seq takes a new nextval, so an attempt that numbered itself
-- before this write (and so may have read the node before it) cannot delete the row, and an EXHAUSTED row (which the sweep
-- no longer selects) is re-armed to PENDING with one attempt, because the new write would otherwise be lost. A FAILED or
-- NOT_CLONED row keeps its state, attempts and backoff clock. The number comes from the sequence, never a clock
-- (findings:mirror-retry-throw-must-retain-attempt-fence). A known limit (cor:int:010:01): a sync that runs before the
-- sweep can still replace the write, as with an owed removal.
CREATE OR REPLACE FUNCTION hadron_git_mirror_capture_node_write() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $capture_write$
DECLARE
  v_branch text;
BEGIN
  SELECT COALESCE(write_branch, 'hadron-updates') INTO v_branch
  FROM memories
  WHERE id = NEW.memory_id AND source IS NOT NULL AND NOT is_encrypted
    AND organization_id IS NOT NULL AND deleted_at IS NULL
    AND position('{client}' in COALESCE(write_branch, 'hadron-updates')) = 0;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  INSERT INTO git_mirror_obligations
    (memory_id, node_id, kind, remove_loc, branch, state, error_class, attempts, attempt_seq, last_attempt_at)
  VALUES
    (NEW.memory_id, NEW.id, 'WRITE', '', v_branch, 'PENDING', 'PENDING', 1,
     nextval('git_mirror_attempt_seq'), (now() AT TIME ZONE 'UTC'))
  ON CONFLICT (memory_id, node_id, kind, remove_loc, branch) DO UPDATE SET
    attempt_seq = EXCLUDED.attempt_seq,
    state = CASE WHEN git_mirror_obligations.state::text = 'EXHAUSTED' THEN 'PENDING'::git_mirror_obligation_state
                 ELSE git_mirror_obligations.state END,
    error_class = CASE WHEN git_mirror_obligations.state::text = 'EXHAUSTED' THEN 'PENDING' ELSE git_mirror_obligations.error_class END,
    attempts = CASE WHEN git_mirror_obligations.state::text = 'EXHAUSTED' THEN 1 ELSE git_mirror_obligations.attempts END,
    last_attempt_at = CASE WHEN git_mirror_obligations.state::text = 'EXHAUSTED' THEN EXCLUDED.last_attempt_at
                           ELSE git_mirror_obligations.last_attempt_at END;
  RETURN NULL;
END
$capture_write$;

DROP TRIGGER IF EXISTS git_mirror_node_write_insert ON nodes;
CREATE TRIGGER git_mirror_node_write_insert AFTER INSERT ON nodes
  FOR EACH ROW WHEN (NEW.deleted_at IS NULL AND NEW.loc <> '')
  EXECUTE FUNCTION hadron_git_mirror_capture_node_write();

DROP TRIGGER IF EXISTS git_mirror_node_write_update ON nodes;
CREATE TRIGGER git_mirror_node_write_update AFTER UPDATE OF
  name, alias, loc, node_type, object_type, description, abstract, abstract_origin_hash, content, content_hash, tags, seq,
  data, properties, role, is_runnable, is_placeholder, authorship_kind, authored_by_task, authored_by_revision ON nodes
  FOR EACH ROW WHEN (NEW.deleted_at IS NULL AND NEW.loc <> '' AND (
    OLD.name IS DISTINCT FROM NEW.name OR OLD.alias IS DISTINCT FROM NEW.alias OR OLD.loc IS DISTINCT FROM NEW.loc OR
    OLD.node_type IS DISTINCT FROM NEW.node_type OR OLD.object_type IS DISTINCT FROM NEW.object_type OR
    OLD.description IS DISTINCT FROM NEW.description OR OLD.abstract IS DISTINCT FROM NEW.abstract OR
    OLD.abstract_origin_hash IS DISTINCT FROM NEW.abstract_origin_hash OR OLD.content IS DISTINCT FROM NEW.content OR
    OLD.content_hash IS DISTINCT FROM NEW.content_hash OR OLD.tags IS DISTINCT FROM NEW.tags OR OLD.seq IS DISTINCT FROM NEW.seq OR
    OLD.data IS DISTINCT FROM NEW.data OR OLD.properties IS DISTINCT FROM NEW.properties OR OLD.role IS DISTINCT FROM NEW.role OR
    OLD.is_runnable IS DISTINCT FROM NEW.is_runnable OR OLD.is_placeholder IS DISTINCT FROM NEW.is_placeholder OR
    OLD.authorship_kind IS DISTINCT FROM NEW.authorship_kind OR OLD.authored_by_task IS DISTINCT FROM NEW.authored_by_task OR
    OLD.authored_by_revision IS DISTINCT FROM NEW.authored_by_revision))
  EXECUTE FUNCTION hadron_git_mirror_capture_node_write();
