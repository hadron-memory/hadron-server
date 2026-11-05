-- #3473: the PR protocol's same-App freezer lookup (resolvers.prProtocol.ts freezersAtHeadSql:
-- app_id = $1 AND type = 'pr.frozen' AND payload->>'head' = $2) had no index on the head and read every pr.frozen
-- event (or every event of the App). A partial expression index covers exactly that predicate and holds only pr.frozen
-- rows. Prisma's schema language cannot model it, so prisma/post-push.sql builds the same statement (plain form, dev/test).
--
-- CONCURRENTLY cannot run inside a transaction block, and `prisma migrate deploy` sends a file as one simple query:
-- one statement runs outside a transaction, several run as one implicit transaction (SQLSTATE 25001). Keep this file a
-- single statement, so writes to agent_team_events are not blocked while it builds.
--
-- A failed CONCURRENTLY build leaves an INVALID index under this name, which IF NOT EXISTS would then skip. If it is
-- ever INVALID, drop it and re-run this statement by hand.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "agent_team_events_pr_frozen_head_idx"
  ON "agent_team_events" ("app_id", (("payload" ->> 'head')))
  WHERE "type" = 'pr.frozen';
