-- #425: node deletes propagate to the Git mirror.
--
-- A new PENDING state for git_mirror_obligations (captured, never attempted), and the two nodes triggers
-- that capture a REMOVE debt on delete and cancel it on restore. The ALTER TYPE below is this migration's
-- own; everything after it is prisma/git-mirror-obligation-invariants.sql appended VERBATIM — the one
-- source, applied by post-push.sql and the test globalSetup, and pinned byte-identical here by
-- src/integrations/github/mirrorObligations430.test.ts (k).
--
-- ALTER TYPE ... ADD VALUE cannot use the new label inside this transaction, so nothing here compares
-- the enum to a 'PENDING' literal: the CHECK casts state to text (the 20261101020000 pattern), and the
-- trigger bodies parse their enum labels only at first call, after commit.
ALTER TYPE git_mirror_obligation_state ADD VALUE IF NOT EXISTS 'PENDING';

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
LANGUAGE plpgsql AS $capture$
DECLARE
  v_branch text;
BEGIN
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
LANGUAGE plpgsql AS $cancel$
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
