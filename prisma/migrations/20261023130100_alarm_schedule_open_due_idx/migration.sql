-- #2200: serves wakeDueOwners over the rows still open (neither woken nor ended), so rows it
-- closes cost nothing afterwards. CONCURRENTLY cannot run inside a transaction block, and
-- `prisma migrate deploy` sends a file as ONE simple query, which Postgres runs as one implicit
-- transaction when it holds several statements (SQLSTATE 25001) but not when it holds one. So this
-- file must stay a single statement: add nothing else here (precedent:
-- 20261014040000_usage_events_session_activity_idx).
--
-- A failed CONCURRENTLY build leaves an INVALID index under this name, which IF NOT EXISTS would
-- then skip. If `\d agent_team_alarm_schedule` ever shows it INVALID, drop it and re-run this
-- statement by hand.
CREATE INDEX CONCURRENTLY IF NOT EXISTS agent_team_alarm_schedule_open_due_idx
  ON agent_team_alarm_schedule (due_at) WHERE woken_at IS NULL AND ended_at IS NULL;
