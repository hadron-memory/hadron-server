-- Rollback for 005-agent-subscription. Best-effort per
-- `specs/005-agent-subscription/contracts/migration-sql.md` §"Rollback":
-- pre-existing User.external_id and AppAgent.subscription_type data is
-- unrecoverable; PERSONAL stays in MemoryVisibility (Postgres can't
-- remove an enum value cleanly).

BEGIN;

-- Reverse the column drop (re-add with NULL default)
ALTER TABLE "app_agents" ADD COLUMN "subscription_type" "SubscriptionType" DEFAULT 'READ_ONLY';

-- Drop the CHECK constraint
ALTER TABLE "memories" DROP CONSTRAINT IF EXISTS "chk_personal_visibility_user";

-- Drop the new memories columns
ALTER TABLE "memories" DROP COLUMN IF EXISTS "class";
ALTER TABLE "memories" DROP COLUMN IF EXISTS "user_id";

-- Drop the new table
DROP TABLE IF EXISTS "agent_subscriptions";

-- Drop the new enum
DROP TYPE IF EXISTS "MemoryClass";

-- Note: PERSONAL remains in MemoryVisibility — Postgres limitation.

COMMIT;
