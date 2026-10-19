-- S5 exception ledger: typed coverage/timestamps; no message content columns.
ALTER TABLE worker_delivery_wait_states DROP CONSTRAINT IF EXISTS chk_delivery_wait_state;
ALTER TABLE worker_delivery_wait_states ADD CONSTRAINT chk_delivery_wait_state
  CHECK (observed_through >= tracked_from);
ALTER TABLE worker_delivery_wait_exceptions DROP CONSTRAINT IF EXISTS chk_delivery_wait_exception;
ALTER TABLE worker_delivery_wait_exceptions ADD CONSTRAINT chk_delivery_wait_exception CHECK (
  cause IN ('no-live-session','isolated','team-paused','team-halted','wake-paused','standby','wake-budget')
  AND (ended_at IS NULL OR ended_at >= started_at)
  AND ((num_nonnulls(channel_id,channel_incarnation,from_seq,through_seq) = 0 AND coverage_key = 'worker')
       OR (num_nonnulls(channel_id,channel_incarnation,from_seq,through_seq) = 4
           AND channel_incarnation >= 0 AND from_seq > 0 AND through_seq >= from_seq))
  AND (cause NOT IN ('standby','wake-budget') OR channel_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS delivery_wait_open_coverage_uniq
  ON worker_delivery_wait_exceptions(worker_id,cause,coverage_key) WHERE ended_at IS NULL;
ALTER TABLE worker_delivery_alarm_episodes DROP CONSTRAINT IF EXISTS chk_delivery_alarm_anchor;
ALTER TABLE worker_delivery_alarm_episodes ADD CONSTRAINT chk_delivery_alarm_anchor
  CHECK (anchor_seq > 0 AND channel_incarnation >= 0);
ALTER TABLE agent_team_alarm_schedule DROP CONSTRAINT IF EXISTS chk_delivery_wait_baseline;
ALTER TABLE agent_team_alarm_schedule ADD CONSTRAINT chk_delivery_wait_baseline
  CHECK (delivery_wait_baseline_ms IS NULL OR delivery_wait_baseline_ms >= 0);
-- task_id is NULL for delivery alarms: the task-episode index does not dedupe them.
CREATE UNIQUE INDEX IF NOT EXISTS delivery_stuck_episode_uniq
  ON agent_team_events ((payload->>'episodeId')) WHERE type = 'delivery.stuck';
CREATE UNIQUE INDEX IF NOT EXISTS delivery_resumed_episode_uniq
  ON agent_team_events ((payload->>'episodeId')) WHERE type = 'delivery.resumed';
-- Keep task episodes unchanged; allow only the new taskless stuck-alarm shape.
ALTER TABLE agent_team_events DROP CONSTRAINT IF EXISTS chk_agent_team_events_episode;
ALTER TABLE agent_team_events ADD CONSTRAINT chk_agent_team_events_episode CHECK (
  episode_start IS NULL OR
  (severity IS NOT NULL AND chain IS NOT NULL AND
    (task_id IS NOT NULL OR (type = 'delivery.stuck' AND subject_worker_id IS NOT NULL)))
);
ALTER TABLE agent_team_events DROP CONSTRAINT IF EXISTS chk_delivery_event_payload;
ALTER TABLE agent_team_events ADD CONSTRAINT chk_delivery_event_payload CHECK (
  type NOT IN ('delivery.held','delivery.stuck','delivery.resumed') OR (
    task_id IS NULL AND subject_worker_id IS NOT NULL AND
    jsonb_typeof(payload->'episodeId') = 'string' AND payload->>'episodeId' ~ '^[A-Za-z0-9_-]{1,128}$' AND
    jsonb_typeof(payload->'channelId') = 'string' AND payload->>'channelId' ~ '^[A-Za-z0-9_-]{1,128}$' AND
    jsonb_typeof(payload->'channelIncarnation') = 'number' AND payload->>'channelIncarnation' ~ '^[0-9]+$' AND
    CASE WHEN type = 'delivery.resumed' THEN
      severity IS NULL AND episode_start IS NULL AND
      jsonb_typeof(payload->'resumedAt') = 'string' AND payload->>'resumedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' AND
      (
        -- R62: channel lifecycle is not evidence of any delivery/read mark.
        ((payload->>'reason') = 'channel-deleted' AND
          payload - ARRAY['episodeId','channelId','channelIncarnation','resumedAt','principal','reason'] = '{}'::jsonb AND
          payload->'principal' = '{"kind":"platform"}'::jsonb)
        OR
        (NOT (payload ? 'reason') AND
          jsonb_typeof(payload->'throughSeq') = 'number' AND payload->>'throughSeq' ~ '^[0-9]+$' AND
          payload - ARRAY['episodeId','channelId','channelIncarnation','throughSeq','resumedAt','principal'] = '{}'::jsonb AND
          jsonb_typeof(payload->'principal') = 'object' AND
          CASE payload->'principal'->>'kind'
            WHEN 'worker' THEN (payload->'principal') - ARRAY['kind','workerId'] = '{}'::jsonb AND (payload->'principal'->>'workerId') ~ '^[A-Za-z0-9_-]{1,128}$'
            WHEN 'user' THEN (payload->'principal') - ARRAY['kind','userId'] = '{}'::jsonb AND (payload->'principal'->>'userId') ~ '^[A-Za-z0-9_-]{1,128}$'
            WHEN 'host-key' THEN (payload->'principal') - ARRAY['kind','appKeyId','hostId'] = '{}'::jsonb AND (payload->'principal'->>'appKeyId') ~ '^[A-Za-z0-9_-]{1,128}$' AND (payload->'principal'->>'hostId') ~ '^[A-Za-z0-9_-]{1,128}$'
            ELSE false
          END)
      )
    ELSE
      payload ?& ARRAY['episodeId','workerId','channelId','channelIncarnation','firstPendingSeq','oldestDueAt','windowSeconds','reason','terminalId'] AND
      jsonb_typeof(payload->'workerId') = 'string' AND payload->>'workerId' = subject_worker_id AND
      jsonb_typeof(payload->'firstPendingSeq') = 'number' AND payload->>'firstPendingSeq' ~ '^[1-9][0-9]*$' AND
      jsonb_typeof(payload->'windowSeconds') = 'number' AND payload->>'windowSeconds' ~ '^[1-9][0-9]*$' AND
      jsonb_typeof(payload->'oldestDueAt') = 'string' AND payload->>'oldestDueAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' AND
      payload - ARRAY['episodeId','workerId','channelId','channelIncarnation','firstPendingSeq','oldestDueAt','windowSeconds','reason','terminalId'] = '{}'::jsonb AND
      (payload->>'reason' IS NULL OR payload->>'reason' IN ('draft','isolated','question','screen-unknown','not-submitted','two-agents','binding-mismatch')) AND
      (payload->>'terminalId' IS NULL OR payload->>'terminalId' ~ '^term_[A-Za-z0-9_-]{1,128}$') AND
      (type <> 'delivery.stuck' OR (severity = 'alarm' AND episode_start IS NOT NULL))
    END
  ) IS TRUE
);

-- #1162: typed Worker references introduced by S5 use the same MVCC fence.
-- Kept in this additive migration: the original #1162 migration runs before
-- these tables exist on a fresh database. No deployed migration is rewritten.
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "worker_delivery_wait_states";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "worker_delivery_wait_states"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.worker_id');
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "worker_delivery_wait_exceptions";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "worker_delivery_wait_exceptions"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.worker_id');
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "worker_delivery_alarm_episodes";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "worker_delivery_alarm_episodes"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.worker_id');
