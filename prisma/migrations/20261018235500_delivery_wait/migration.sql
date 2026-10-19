-- AlterTable
ALTER TABLE "agent_team_alarm_schedule" ADD COLUMN     "delivery_wait_baseline_ms" BIGINT;

-- CreateTable
CREATE TABLE "worker_delivery_wait_states" (
    "worker_id" TEXT NOT NULL,
    "tracked_from" TIMESTAMP(3) NOT NULL,
    "observed_through" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "worker_delivery_wait_states_pkey" PRIMARY KEY ("worker_id")
);

-- CreateTable
CREATE TABLE "worker_delivery_wait_exceptions" (
    "id" TEXT NOT NULL,
    "worker_id" TEXT NOT NULL,
    "cause" TEXT NOT NULL,
    "coverage_key" TEXT NOT NULL,
    "channel_id" TEXT,
    "channel_incarnation" INTEGER,
    "from_seq" INTEGER,
    "through_seq" INTEGER,
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),

    CONSTRAINT "worker_delivery_wait_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_delivery_alarm_episodes" (
    "worker_id" TEXT NOT NULL,
    "episode_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "channel_incarnation" INTEGER NOT NULL,
    "anchor_seq" INTEGER NOT NULL,
    "due_since" TIMESTAMP(3) NOT NULL,
    "alarm_event_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "worker_delivery_alarm_episodes_pkey" PRIMARY KEY ("worker_id")
);

-- CreateIndex
CREATE INDEX "worker_delivery_wait_exceptions_worker_id_started_at_ended__idx" ON "worker_delivery_wait_exceptions"("worker_id", "started_at", "ended_at");

-- CreateIndex
CREATE INDEX "worker_delivery_wait_exceptions_worker_id_channel_id_channe_idx" ON "worker_delivery_wait_exceptions"("worker_id", "channel_id", "channel_incarnation", "from_seq", "through_seq");

-- CreateIndex
CREATE UNIQUE INDEX "worker_delivery_wait_exceptions_worker_id_cause_coverage_ke_key" ON "worker_delivery_wait_exceptions"("worker_id", "cause", "coverage_key", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "worker_delivery_alarm_episodes_episode_id_key" ON "worker_delivery_alarm_episodes"("episode_id");

-- CreateIndex
CREATE UNIQUE INDEX "worker_delivery_alarm_episodes_alarm_event_id_key" ON "worker_delivery_alarm_episodes"("alarm_event_id");

-- AddForeignKey
ALTER TABLE "worker_delivery_wait_states" ADD CONSTRAINT "worker_delivery_wait_states_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "workers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_delivery_wait_exceptions" ADD CONSTRAINT "worker_delivery_wait_exceptions_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "workers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_delivery_alarm_episodes" ADD CONSTRAINT "worker_delivery_alarm_episodes_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "workers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

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
    jsonb_typeof(payload->'channelIncarnation') = 'number' AND
    CASE WHEN type = 'delivery.resumed' THEN
      severity IS NULL AND episode_start IS NULL AND
      payload - ARRAY['episodeId','channelId','channelIncarnation','throughSeq','resumedAt','principal'] = '{}'::jsonb AND
      jsonb_typeof(payload->'principal') = 'object' AND
      CASE payload->'principal'->>'kind'
        WHEN 'worker' THEN (payload->'principal') - ARRAY['kind','workerId'] = '{}'::jsonb AND (payload->'principal'->>'workerId') ~ '^[A-Za-z0-9_-]{1,128}$'
        WHEN 'user' THEN (payload->'principal') - ARRAY['kind','userId'] = '{}'::jsonb AND (payload->'principal'->>'userId') ~ '^[A-Za-z0-9_-]{1,128}$'
        WHEN 'host-key' THEN (payload->'principal') - ARRAY['kind','appKeyId','hostId'] = '{}'::jsonb AND (payload->'principal'->>'appKeyId') ~ '^[A-Za-z0-9_-]{1,128}$' AND (payload->'principal'->>'hostId') ~ '^[A-Za-z0-9_-]{1,128}$'
        ELSE false
      END
    ELSE
      payload - ARRAY['episodeId','workerId','channelId','channelIncarnation','firstPendingSeq','oldestDueAt','windowSeconds','reason','terminalId'] = '{}'::jsonb AND
      (payload->>'reason' IS NULL OR payload->>'reason' IN ('draft','isolated','question','screen-unknown','not-submitted','two-agents','binding-mismatch')) AND
      (payload->>'terminalId' IS NULL OR payload->>'terminalId' ~ '^term_[A-Za-z0-9_-]{1,128}$') AND
      (type <> 'delivery.stuck' OR (severity = 'alarm' AND episode_start IS NOT NULL))
    END
  ) IS TRUE
);
