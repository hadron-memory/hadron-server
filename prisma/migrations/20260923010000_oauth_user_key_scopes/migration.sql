-- Bind OAuth-issued user keys to the grant the user approved (#1261).
-- Empty remains the deliberate unrestricted shape for portal-minted keys.
ALTER TABLE "user_api_keys"
  ADD COLUMN "oauth_scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "auth_codes"
  ADD COLUMN "oauth_scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Before scope enforcement, every OAuth-issued key and outstanding code had
-- full account authority even though the protocol response said `mcp`.
-- Preserve that effective grant across rollout; narrowing existing credentials
-- without renewed consent would break callers. `issued_via` is server-authored,
-- and OAuth values always use this exact prefix.
UPDATE "user_api_keys"
SET "oauth_scopes" = ARRAY['account']::TEXT[]
WHERE starts_with("issued_via", 'oauth:');

UPDATE "auth_codes"
SET "oauth_scopes" = ARRAY['account']::TEXT[];
