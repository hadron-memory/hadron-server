-- #3473: the PR protocol's same-App freezer lookup (resolvers.prProtocol.ts freezersAtHeadSql:
-- app_id = $1 AND type = 'pr.frozen' AND payload->>'head' = $2) had no index on the head and read every pr.frozen
-- event (or every event of the App). A partial expression index covers exactly that predicate and holds only pr.frozen
-- rows. Prisma's schema language cannot model it, so prisma/post-push.sql builds the same statement.
CREATE INDEX IF NOT EXISTS "agent_team_events_pr_frozen_head_idx"
  ON "agent_team_events" ("app_id", (("payload" ->> 'head')))
  WHERE "type" = 'pr.frozen';
