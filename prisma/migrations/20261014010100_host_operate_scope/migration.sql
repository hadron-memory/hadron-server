-- #1709 (T6): the host:operate scope, bound to one host (cor:agt:070:04). Then the scope invariants file, verbatim.
ALTER TABLE "app_key_scopes" ADD COLUMN "host_id" TEXT;

-- #1749 (Tickers S3): the database facts Prisma's schema language cannot model for App key scopes.
-- Source of truth for these objects; the migration carries a byte-identical copy
-- (pinned by src/lib/appKeyScopes/appKeyScopes.test.ts) and post-push.sql includes this file.

-- cor:aut:010:03 — a key holds a scope at most once. A revoked row stays as the record of who gave it and who took it
-- back; only a live one counts.
CREATE UNIQUE INDEX IF NOT EXISTS app_key_scopes_live_uniq
  ON app_key_scopes (app_key_id, scope) WHERE revoked_at IS NULL;

-- A closed list; a revocation names who and when, or neither. #1709 (T6) adds host:operate, which is bound to exactly
-- one host (cor:agt:070:04): its host id is required, a token of the host-registration shape, and no other scope has one.
ALTER TABLE app_key_scopes DROP CONSTRAINT IF EXISTS chk_app_key_scopes_shape;
ALTER TABLE app_key_scopes ADD CONSTRAINT chk_app_key_scopes_shape CHECK (
  scope IN ('attention:deliver', 'host:operate')
  AND ((revoked_at IS NULL) = (revoked_by_user_id IS NULL))
  AND ((scope = 'host:operate') = (host_id IS NOT NULL))
  AND (host_id IS NULL OR host_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
);
