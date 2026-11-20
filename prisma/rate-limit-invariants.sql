-- #4332 (part of #434 Slice C) — the rate-limit CHECKs that migration 20261031220000_shared_rate_limiter declares inline.
-- `db push` cannot model a CHECK, so dev and test carry them here, under the names Postgres gave the migration's inline
-- constraints and with the migration's expressions. The migration is the authority (ops:alpha:prisma-deploy-flow); keep
-- these in step with it. Pinned by src/lib/rateLimit/rateLimitChecks4332.test.ts and the migration replay check.
ALTER TABLE rate_limit_policies DROP CONSTRAINT IF EXISTS rate_limit_policies_principal_limit_check;
ALTER TABLE rate_limit_policies ADD CONSTRAINT rate_limit_policies_principal_limit_check CHECK (principal_limit > 0);
ALTER TABLE rate_limit_policies DROP CONSTRAINT IF EXISTS rate_limit_policies_key_limit_check;
ALTER TABLE rate_limit_policies ADD CONSTRAINT rate_limit_policies_key_limit_check CHECK (key_limit > 0);
ALTER TABLE rate_limit_policies DROP CONSTRAINT IF EXISTS rate_limit_policies_ip_limit_check;
ALTER TABLE rate_limit_policies ADD CONSTRAINT rate_limit_policies_ip_limit_check CHECK (ip_limit > 0);
ALTER TABLE rate_limit_policies DROP CONSTRAINT IF EXISTS rate_limit_policies_window_seconds_check;
ALTER TABLE rate_limit_policies ADD CONSTRAINT rate_limit_policies_window_seconds_check CHECK (window_seconds IN (60,900,3600));
ALTER TABLE rate_limit_policies DROP CONSTRAINT IF EXISTS rate_limit_policies_retention_seconds_check;
ALTER TABLE rate_limit_policies ADD CONSTRAINT rate_limit_policies_retention_seconds_check CHECK (retention_seconds = 86400);
ALTER TABLE rate_limit_policies DROP CONSTRAINT IF EXISTS rate_limit_policies_enforcement_mode_check;
ALTER TABLE rate_limit_policies ADD CONSTRAINT rate_limit_policies_enforcement_mode_check CHECK (enforcement_mode IN ('LOG_ONLY','ENFORCING'));
ALTER TABLE rate_limit_buckets DROP CONSTRAINT IF EXISTS rate_limit_buckets_used_check;
ALTER TABLE rate_limit_buckets ADD CONSTRAINT rate_limit_buckets_used_check CHECK (used >= 0);
