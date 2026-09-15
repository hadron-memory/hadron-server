-- Organization.skillPrefix — the literal prefix a task node in this org's
-- memories is exported to disk with as a Claude skill (`hadron-`, `mm-`).
-- Holger's ruling on hadron-cli's skill-command plan D7 (2026-09-15): stored
-- per owning org on the server, never derived (`hadronmemory.com` → `hadron`
-- is not mechanical) and never a client-side table. A task in a user-owned
-- memory has no org and takes the platform's `hadron-`.
--
-- Nullable: an org that has not chosen a prefix cannot be exported from, and
-- the CLI says so rather than guessing. Unique across orgs so two orgs cannot
-- both export `mm-review-changes` onto one engineer's disk (Postgres treats
-- NULLs as distinct, so unset orgs do not collide).

ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "skill_prefix" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "organizations_skill_prefix_key" ON "organizations" ("skill_prefix");

-- The platform's own org exports as `hadron-` from the first run, no flag.
UPDATE "organizations" SET "skill_prefix" = 'hadron-' WHERE "urn" = 'hadronmemory.com' AND "skill_prefix" IS NULL;
