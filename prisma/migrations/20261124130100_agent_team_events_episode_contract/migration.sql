-- #4344 (Holger's ruling A, 2026-11-23): CONTRACT. The expand migration 20261123050000_agent_team_events_episode_app_key
-- (PR #4957, merged 2026-11-23T10:58Z; a merge to main deploys at once, ops:alpha:server-main-merge-deploys) added the
-- four-column key and the image writing `ON CONFLICT (app_id, task_id, type, episode_start)`. No image still writing the
-- three-column target is running, so its arbiter index can go: a foreign App's alarm row no longer blocks the real one.
-- Safe on data: dropping a unique index cannot refuse. Rollback: run the previous image and recreate
--   CREATE UNIQUE INDEX "agent_team_events_episode_uniq" ON "agent_team_events"("task_id", "type", "episode_start");
-- which refuses if two Apps by then hold an alarm for one task episode; resolve those rows first.
DROP INDEX "agent_team_events_episode_uniq";
-- agent_team_events_task_id_type_idx (previous migration) now serves every task_id lookup, so the single-column index is redundant.
DROP INDEX "agent_team_events_task_id_idx";
