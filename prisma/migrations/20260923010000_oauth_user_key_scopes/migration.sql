-- Bind OAuth-issued user keys to the grant the user approved (#1261).
-- Empty remains the deliberate unrestricted shape for portal-minted keys.
ALTER TABLE "user_api_keys"
  ADD COLUMN "oauth_scopes" TEXT[];

ALTER TABLE "auth_codes"
  ADD COLUMN "oauth_scopes" TEXT[];

-- Before scope enforcement, every OAuth-issued key and outstanding code had
-- full account authority even though the protocol response said `mcp`.
-- Preserve that effective grant across rollout; narrowing existing credentials
-- without renewed consent would break callers. `issued_via` is server-authored,
-- and OAuth values always use this exact prefix.
UPDATE "user_api_keys"
SET "oauth_scopes" = CASE
  WHEN starts_with(COALESCE("issued_via", ''), 'oauth:')
    THEN ARRAY['account']::TEXT[]
  ELSE ARRAY[]::TEXT[]
END;

UPDATE "auth_codes"
SET "oauth_scopes" = ARRAY['account']::TEXT[];

-- Deliberately NO database default: every current writer supplies the exact
-- grant. A pre-migration server process that omits this column fails closed
-- instead of turning a newly approved `mcp` grant into `account`. Deployment
-- must drain old OAuth writers before this migration is applied.
ALTER TABLE "user_api_keys" ALTER COLUMN "oauth_scopes" SET NOT NULL;
ALTER TABLE "auth_codes" ALTER COLUMN "oauth_scopes" SET NOT NULL;
