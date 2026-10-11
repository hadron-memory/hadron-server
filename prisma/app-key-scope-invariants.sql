-- #1749 (Tickers S3): the database facts Prisma's schema language cannot model for App key scopes.
-- Source of truth for these objects; the migration carries a byte-identical copy
-- (pinned by src/lib/appKeyScopes/invariants.test.ts) and post-push.sql includes this file.

-- cor:aut:010:03 — a key holds a scope at most once. A revoked row stays as the record of who gave it and who took it
-- back; only a live one counts.
CREATE UNIQUE INDEX IF NOT EXISTS app_key_scopes_live_uniq
  ON app_key_scopes (app_key_id, scope) WHERE revoked_at IS NULL;

-- A closed list (T6 adds host:operate); a revocation names who and when, or neither.
ALTER TABLE app_key_scopes DROP CONSTRAINT IF EXISTS chk_app_key_scopes_shape;
ALTER TABLE app_key_scopes ADD CONSTRAINT chk_app_key_scopes_shape CHECK (
  scope IN ('attention:deliver')
  AND ((revoked_at IS NULL) = (revoked_by_user_id IS NULL))
);
