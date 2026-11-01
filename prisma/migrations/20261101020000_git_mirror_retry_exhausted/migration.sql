-- #430 retry sweep: terminal only for the sweep; ordinary writers can recover.
ALTER TYPE git_mirror_obligation_state ADD VALUE IF NOT EXISTS 'EXHAUSTED';

-- #430: the Git-mirror obligation's shape. One source, shared verbatim with migration
-- 20261101020000_git_mirror_retry_exhausted (pinned by src/integrations/github/mirrorObligations430.test.ts) and applied by
-- post-push.sql and the test globalSetup.
--
-- `error_class` is a CLOSED set of fixed words, never exception text: a raw Git error can carry an installation-token URL
-- (findings:git-execfile-error-carries-auth-url), so nothing free-form is storable here. A NOT_CLONED row says so in both
-- columns. A REMOVE row names the old loc it must vacate; a WRITE row has none. `attempts` and `attempt_seq` only grow.
CREATE SEQUENCE IF NOT EXISTS git_mirror_attempt_seq AS bigint;
ALTER TABLE git_mirror_obligations DROP CONSTRAINT IF EXISTS chk_git_mirror_obligation_shape;
ALTER TABLE git_mirror_obligations ADD CONSTRAINT chk_git_mirror_obligation_shape CHECK (
  error_class IN ('TOKEN_UNAVAILABLE', 'BRANCH_SETUP', 'TREE_WRITE', 'PUSH_FAILED', 'LOCK_FAILED', 'NOT_CLONED') AND
  ((state::text = 'NOT_CLONED' AND error_class = 'NOT_CLONED') OR
   (state::text = 'FAILED' AND error_class <> 'NOT_CLONED') OR state::text = 'EXHAUSTED') AND
  ((kind = 'WRITE' AND remove_loc = '') OR (kind = 'REMOVE' AND remove_loc <> '')) AND
  attempts >= 1
);
