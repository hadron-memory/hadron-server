-- #2014 — post-limit episodes: one per "first refusal in an hour", at most ONE open per worker.
CREATE TABLE IF NOT EXISTS post_limit_episodes (
  id         TEXT PRIMARY KEY,
  app_id     TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE ON UPDATE CASCADE,
  worker_id  TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE ON UPDATE CASCADE,
  event_id   TEXT NOT NULL UNIQUE REFERENCES agent_team_events(id) ON DELETE CASCADE ON UPDATE CASCADE,
  opened_at  TIMESTAMP(3) NOT NULL,
  ended_at   TIMESTAMP(3)
);
CREATE INDEX IF NOT EXISTS post_limit_episodes_app_id_ended_at_idx ON post_limit_episodes (app_id, ended_at);
ALTER TABLE post_limit_episodes DROP CONSTRAINT IF EXISTS chk_post_limit_episodes_shape;
ALTER TABLE post_limit_episodes ADD CONSTRAINT chk_post_limit_episodes_shape CHECK (ended_at IS NULL OR ended_at >= opened_at);
CREATE UNIQUE INDEX IF NOT EXISTS post_limit_episodes_one_open_uniq ON post_limit_episodes (worker_id) WHERE ended_at IS NULL;

-- #2014 — the window count: one worker's chat messages by age, across Channels (a partial index; Prisma cannot model it).
CREATE INDEX IF NOT EXISTS nodes_chat_worker_created_idx ON nodes (created_by_worker_id, created_at) WHERE node_type = 'chat-message';

-- #1162: the episode's worker column is a typed Worker reference, under the same writer fence as every other one.
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "post_limit_episodes";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "post_limit_episodes"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.worker_id');
