-- #2204: bind the Google/Apple ID token to the login attempt. Additive and nullable: no backfill. A row pending at
-- deploy keeps a NULL hash and is claimable for at most one LOGIN_STATE_TTL_MS (15 min).
-- Deploy-order note: the CHECK below refuses google/apple inserts from pre-#2204 code, so old and new app
-- containers must not overlap after this runs (see the PR body).
ALTER TABLE "pending_login_states" ADD COLUMN "provider_nonce_hash" TEXT;

-- #2204: the OIDC nonce hash on a pending login. One source, shared verbatim with migration
-- 20261023120000_pending_login_provider_nonce (pinned by src/auth/providerNonce.test.ts).
-- NOT VALID on purpose: it refuses every NEW google/apple row without a hash but never scans or fails the rows
-- minted before this shipped (at most one login TTL old; the callback skips the nonce check for those only).
ALTER TABLE "pending_login_states" DROP CONSTRAINT IF EXISTS "chk_pending_login_provider_nonce";
ALTER TABLE "pending_login_states" ADD CONSTRAINT "chk_pending_login_provider_nonce" CHECK (
  ("provider_nonce_hash" IS NULL OR "provider_nonce_hash" ~ '^[0-9a-f]{64}$')
  AND ("provider" = 'github' OR "provider_nonce_hash" IS NOT NULL)
) NOT VALID;
