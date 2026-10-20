-- #2014/#2015: worker-wide accepted-post index and durable refusal episodes.
CREATE INDEX "nodes_worker_post_admission_idx" ON "nodes"("created_by_worker_id", "created_at" DESC);
CREATE TABLE "worker_post_limit_episodes" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "worker_id" TEXT NOT NULL REFERENCES "workers"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "episode_start" TIMESTAMP(3) NOT NULL,
  "event_id" TEXT NOT NULL
);
CREATE UNIQUE INDEX "worker_post_limit_episodes_event_id_key" ON "worker_post_limit_episodes"("event_id");
CREATE UNIQUE INDEX "worker_post_limit_episodes_worker_id_episode_start_key" ON "worker_post_limit_episodes"("worker_id", "episode_start");
CREATE INDEX "worker_post_limit_episodes_worker_id_episode_start_idx" ON "worker_post_limit_episodes"("worker_id", "episode_start" DESC);
-- #2014: replay AFTER S5 delivery-stall invariants. Only the two agreed task-less alarm types get episodes.
ALTER TABLE agent_team_events DROP CONSTRAINT IF EXISTS chk_agent_team_events_shape;
ALTER TABLE agent_team_events ADD CONSTRAINT chk_agent_team_events_shape CHECK (
  (type ~ '^[a-z]+(\.[a-z]+(-[a-z]+)*)+$' OR type = 'post-limit.exceeded') AND
  (severity IS NULL OR severity = 'alarm') AND
  -- IS NOT NULL, not = 'alarm': a NULL severity would make that comparison
  -- NULL, and a CHECK that evaluates to NULL passes.
  (severity IS NOT NULL OR num_nonnulls(chain, acknowledged_by_user_id, acknowledged_by_worker_id, acknowledged_at) = 0) AND
  (CASE WHEN acknowledged_at IS NULL
        THEN num_nonnulls(acknowledged_by_user_id, acknowledged_by_worker_id) = 0
        ELSE num_nonnulls(acknowledged_by_user_id, acknowledged_by_worker_id) >= 1 END) AND
  jsonb_typeof(payload) = 'object'
);

ALTER TABLE agent_team_events DROP CONSTRAINT IF EXISTS chk_agent_team_events_episode;
ALTER TABLE agent_team_events ADD CONSTRAINT chk_agent_team_events_episode CHECK (
  episode_start IS NULL OR (severity IS NOT NULL AND chain IS NOT NULL AND
    (task_id IS NOT NULL OR
      (type IN ('delivery.stuck', 'post-limit.exceeded') AND subject_worker_id IS NOT NULL)))
);

-- #1162: the episode is a typed Worker reference; original deployed migration cannot name this future table.
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "worker_post_limit_episodes";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "worker_post_limit_episodes"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.worker_id');
