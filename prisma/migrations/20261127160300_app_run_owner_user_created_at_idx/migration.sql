-- #5077: a person's runs, newest first. Built CONCURRENTLY so run launches and hops are not blocked (convention:
-- hrn:node:hadronmemory.com:hadron-server:findings:create-index-concurrently-in-prisma-migrations).
--
-- CONCURRENTLY cannot run inside a transaction block, and `prisma migrate deploy` sends a file as one simple query: one
-- statement runs outside a transaction, several run as one implicit transaction (SQLSTATE 25001). Keep this file a single
-- statement.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "app_runs_owner_user_id_created_at_idx" ON "app_runs"("owner_user_id", "created_at");
