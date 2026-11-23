-- #4344 (Holger's ruling A, 2026-11-23): the one-alarm-per-episode key carries the App (cor:agt:050:11, :13).
-- EXPAND ONLY. The four-column unique index is added; agent_team_events_episode_uniq (task_id, type, episode_start) is
-- KEPT. The image that writes `ON CONFLICT (app_id, task_id, type, episode_start)` and the image before it (which writes
-- the three-column target) both find an arbiter index while both exist; an old image's three-column ON CONFLICT raises
-- 42P10 the moment that index is gone, so it is dropped by a LATER contract migration that cites the deploy.
-- Widening a unique key cannot create a duplicate: every row is already unique on the three columns, so no data can
-- refuse this migration. app_id is NOT NULL; task_id and episode_start keep their NULL semantics (NULLs never collide).
-- Rollback: DROP INDEX "agent_team_events_episode_app_uniq" and run the previous image (nothing else depends on it).
CREATE UNIQUE INDEX "agent_team_events_episode_app_uniq" ON "agent_team_events"("app_id", "task_id", "type", "episode_start");
