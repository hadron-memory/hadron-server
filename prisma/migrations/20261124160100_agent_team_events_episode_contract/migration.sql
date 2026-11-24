-- #4344 (ruling A, 2026-11-23): CONTRACT. The expand migration 20261123050000_agent_team_events_episode_app_key
-- (PR #4957, merged 2026-11-23T10:58Z; a merge to main deploys at once, ops:alpha:server-main-merge-deploys) added the
-- four-column key and the image writing `ON CONFLICT (app_id, task_id, type, episode_start)`; a repo-wide search finds no writer
-- of the three-column target left. So its arbiter index can go, and a foreign App's alarm row no longer blocks the real one.
-- CONCURRENTLY takes no ACCESS EXCLUSIVE lock on the append-heavy agent_team_events, and so must stay the ONLY statement in this
-- file (`prisma migrate deploy` runs a multi-statement file in one transaction; precedent: 20261023130100_alarm_schedule_open_due_idx).
-- Safe on data: dropping a unique index cannot refuse. Rollback: run the previous image and recreate
--   CREATE UNIQUE INDEX "agent_team_events_episode_uniq" ON "agent_team_events"("task_id", "type", "episode_start");
-- which refuses if two Apps by then hold an alarm for one task episode; resolve those rows first.
DROP INDEX CONCURRENTLY IF EXISTS "agent_team_events_episode_uniq";
