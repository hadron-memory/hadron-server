-- #4084 (Glen's blind P2 on hadron-server#4089): the changed-since read's commit-safe order, (tx_id, created_at, id)
-- within an App (agentTaskExternalIdChanges). Built CONCURRENTLY so writes to agent_team_events are not blocked
-- (convention: hrn:node:hadronmemory.com:hadron-server:findings:create-index-concurrently-in-prisma-migrations).
--
-- CONCURRENTLY cannot run inside a transaction block, and `prisma migrate deploy` sends a file as one simple query:
-- keep this file a single statement. A failed build leaves an INVALID index under this name, which IF NOT EXISTS would
-- then skip; if it is ever INVALID, drop it and re-run this statement by hand.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "agent_team_events_app_id_tx_id_created_at_id_idx" ON "agent_team_events"("app_id", "tx_id", "created_at", "id");
