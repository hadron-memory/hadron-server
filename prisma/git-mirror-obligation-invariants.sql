-- #430 (first slice): the Git-mirror obligation's shape. One source, shared verbatim with migration
-- 20261027120000_git_mirror_obligations (pinned by src/integrations/github/mirrorObligations430.test.ts) and applied by
-- post-push.sql and the test globalSetup.
--
-- `error_class` is a CLOSED set of fixed words, never exception text: a raw Git error can carry an installation-token URL
-- (findings:git-execfile-error-carries-auth-url), so nothing free-form is storable here. A NOT_CLONED row says so in both
-- columns. A REMOVE row names the old loc it must vacate; a WRITE row has none. `attempts` and `attempt_seq` only grow.
CREATE SEQUENCE IF NOT EXISTS git_mirror_attempt_seq AS bigint;
ALTER TABLE git_mirror_obligations DROP CONSTRAINT IF EXISTS chk_git_mirror_obligation_shape;
ALTER TABLE git_mirror_obligations ADD CONSTRAINT chk_git_mirror_obligation_shape CHECK (
  error_class IN ('TOKEN_UNAVAILABLE', 'BRANCH_SETUP', 'TREE_WRITE', 'PUSH_FAILED', 'LOCK_FAILED', 'NOT_CLONED') AND
  (state = 'NOT_CLONED') = (error_class = 'NOT_CLONED') AND
  ((kind = 'WRITE' AND remove_loc = '') OR (kind = 'REMOVE' AND remove_loc <> '')) AND
  attempts >= 1
);
