-- #4271: the person-activity read of the stall rules (cor:agt:050:12, loadStallInputs' userCalls: a person's latest
-- task call in an App) filters agent_team_events by actor_user_id and app_id, with actor_worker_id null and a task.
-- No index served it, so every roster and stall pass read the whole events table. This partial index answers it from
-- the person's own rows.
--
-- expand-safe: the previous image runs against this schema (an index only; no column, constraint or data change).
--
-- Built CONCURRENTLY, so writes to agent_team_events are not blocked while it builds on a large table. CONCURRENTLY
-- cannot run inside a transaction block, and `prisma migrate deploy` sends a migration file as ONE simple query, which
-- Postgres runs as an implicit transaction only when it holds several statements (SQLSTATE 25001). So this file must
-- stay a single statement: add nothing else here (the 20261014040000 pattern).
--
-- A failed CONCURRENTLY build leaves an INVALID index under this name, which IF NOT EXISTS would then skip. If
-- `\d agent_team_events` ever shows it INVALID, drop it and re-run this statement by hand.
CREATE INDEX CONCURRENTLY IF NOT EXISTS agent_team_events_person_activity_idx
  ON agent_team_events (actor_user_id, app_id, created_at) WHERE actor_worker_id IS NULL AND task_id IS NOT NULL;
