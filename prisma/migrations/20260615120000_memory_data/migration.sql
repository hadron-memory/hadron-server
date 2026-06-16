-- Add a free-form JSON metadata column to memories (Memory.data).
--
-- Why this migration exists:
--   Clients need a per-memory structured-metadata bag that the platform
--   does not interpret. Exposed read/write over the GraphQL API
--   (createMemory / updateMemory + the Memory.data field) and read-only
--   over MCP (h-list-memories renders a `data:` line). MCP has no
--   memory-mutation tool, so writes stay on the GraphQL path.
--
-- Plain nullable JSONB column: no default, no CHECK constraint, no index.
-- Nothing to sync into prisma/post-push.sql or src/test/globalSetup.ts
-- (those carry only the CHECK constraints / partial unique indexes that a
-- `prisma db push` would otherwise drop). The db-push-managed dev/test DBs
-- pick this column up automatically via `prisma db push`; production
-- applies it via `prisma migrate deploy`.

ALTER TABLE "memories" ADD COLUMN "data" JSONB;
