-- Bind OAuth-issued user keys to the grant the user approved (#1261).
-- Empty remains the deliberate unrestricted shape for portal-minted keys.
ALTER TABLE "user_api_keys"
  ADD COLUMN "oauth_scopes" TEXT[] NOT NULL DEFAULT ARRAY['account']::TEXT[];

ALTER TABLE "auth_codes"
  ADD COLUMN "oauth_scopes" TEXT[] NOT NULL DEFAULT ARRAY['account']::TEXT[];

-- Before scope enforcement, every OAuth-issued key and outstanding code had
-- full account authority even though the protocol response said `mcp`.
-- Preserve that effective grant across rollout; narrowing existing credentials
-- without renewed consent would break callers. `issued_via` is server-authored,
-- and OAuth values always use this exact prefix.
-- The broad DB default is a rolling-deploy compatibility rail: an old server
-- that omits the new column still creates redeemable, historically full-access
-- OAuth credentials. New code always writes the approved scope explicitly.
-- Existing portal keys retain their deliberate empty/unrestricted shape.
UPDATE "user_api_keys"
SET "oauth_scopes" = ARRAY[]::TEXT[]
WHERE NOT starts_with(COALESCE("issued_via", ''), 'oauth:');

UPDATE "auth_codes"
SET "oauth_scopes" = ARRAY['account']::TEXT[];
