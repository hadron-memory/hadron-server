-- #1706 (Task Management T2): stall alarm episodes, alarm wakes, availability for
-- work (worker and model family), and per-App stall windows. Additive only.

-- AlterTable
ALTER TABLE "agent_team_events" ADD COLUMN     "episode_start" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "alarm_wakes" (
    "event_id" TEXT NOT NULL,
    "chain_index" INTEGER NOT NULL,
    "due_at" TIMESTAMP(3) NOT NULL,
    "woken_at" TIMESTAMP(3),

    CONSTRAINT "alarm_wakes_pkey" PRIMARY KEY ("event_id","chain_index")
);

-- CreateTable
CREATE TABLE "worker_availability" (
    "worker_id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "reason" TEXT,
    "until" TIMESTAMP(3),
    "set_at" TIMESTAMP(3) NOT NULL,
    "set_by" TEXT NOT NULL,
    "set_by_user_id" TEXT,
    "set_by_worker_id" TEXT,
    "set_by_agent_id" TEXT,

    CONSTRAINT "worker_availability_pkey" PRIMARY KEY ("worker_id")
);

-- CreateTable
CREATE TABLE "family_availability" (
    "app_id" TEXT NOT NULL,
    "family" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "reason" TEXT,
    "until" TIMESTAMP(3),
    "set_at" TIMESTAMP(3) NOT NULL,
    "set_by_user_id" TEXT,
    "set_by_worker_id" TEXT,
    "set_by_agent_id" TEXT,

    CONSTRAINT "family_availability_pkey" PRIMARY KEY ("app_id","family")
);

-- CreateTable
CREATE TABLE "app_task_stall_windows" (
    "app_id" TEXT NOT NULL,
    "not_started_minutes" INTEGER,
    "no_progress_minutes" INTEGER,
    "owner_reaction_minutes" INTEGER,
    "assignment_minutes" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" TEXT,

    CONSTRAINT "app_task_stall_windows_pkey" PRIMARY KEY ("app_id")
);

-- CreateIndex
CREATE INDEX "alarm_wakes_woken_at_due_at_idx" ON "alarm_wakes"("woken_at", "due_at");

-- CreateIndex
CREATE UNIQUE INDEX "agent_team_events_episode_uniq" ON "agent_team_events"("task_id", "type", "episode_start");

-- AddForeignKey
ALTER TABLE "alarm_wakes" ADD CONSTRAINT "alarm_wakes_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "agent_team_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_availability" ADD CONSTRAINT "worker_availability_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "workers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "family_availability" ADD CONSTRAINT "family_availability_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_task_stall_windows" ADD CONSTRAINT "app_task_stall_windows_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- #1706 (Task Management T2): stall alarms, their wakes, availability for work,
-- and per-App stall windows.
-- Source of truth for these objects; the migration carries a byte-identical copy
-- (pinned by src/lib/agentTasks/invariants.test.ts) and post-push.sql includes this file.

-- cor:agt:050:13 — an episode key belongs to a stall alarm on a task. The
-- unique index agent_team_events_episode_uniq (task_id, type, episode_start)
-- is what makes one alarm per episode hold; this keeps the key off every
-- other event. IS NOT NULL, not = 'alarm': the T1 shape CHECK already pins
-- severity to NULL or 'alarm', and a NULL comparison would pass a CHECK.
ALTER TABLE agent_team_events DROP CONSTRAINT IF EXISTS chk_agent_team_events_episode;
ALTER TABLE agent_team_events ADD CONSTRAINT chk_agent_team_events_episode CHECK (
  episode_start IS NULL OR (severity IS NOT NULL AND task_id IS NOT NULL AND chain IS NOT NULL)
);

-- cor:agt:050:19 — a wake is one owner of the alarm's chain; it is woken no
-- earlier than it falls due.
ALTER TABLE alarm_wakes DROP CONSTRAINT IF EXISTS chk_alarm_wakes_shape;
ALTER TABLE alarm_wakes ADD CONSTRAINT chk_alarm_wakes_shape CHECK (
  chain_index >= 0 AND (woken_at IS NULL OR woken_at >= due_at)
);

-- cor:agt:060:02 — available or unavailable; a reason only when unavailable
-- (Proposed), from the closed set (`held` was dropped, team chat #7449); an
-- `until` only on an unavailable record; one of cor:agt:060:08's setters.
ALTER TABLE worker_availability DROP CONSTRAINT IF EXISTS chk_worker_availability_shape;
ALTER TABLE worker_availability ADD CONSTRAINT chk_worker_availability_shape CHECK (
  CASE state
    WHEN 'available' THEN reason IS NULL AND until IS NULL
    WHEN 'unavailable' THEN reason IS NOT NULL AND reason IN ('stalled', 'out-of-tokens', 'host-down', 'other')
    ELSE false
  END AND
  set_by IN ('worker', 'holder', 'app-manager', 'stall-rule', 'host')
);

-- cor:agt:060:03 — the same state / reason shape per App and model family; a
-- family is a lowercase token (cor:agt:060:04).
ALTER TABLE family_availability DROP CONSTRAINT IF EXISTS chk_family_availability_shape;
ALTER TABLE family_availability ADD CONSTRAINT chk_family_availability_shape CHECK (
  family ~ '^[a-z0-9][a-z0-9._-]{0,63}$' AND
  CASE state
    WHEN 'available' THEN reason IS NULL AND until IS NULL
    WHEN 'unavailable' THEN reason IS NOT NULL AND reason IN ('stalled', 'out-of-tokens', 'host-down', 'other')
    ELSE false
  END
);

-- cor:agt:050:14–:17 "What Can Change" — a window is a positive number of
-- minutes, at most a week; NULL means the platform default.
ALTER TABLE app_task_stall_windows DROP CONSTRAINT IF EXISTS chk_app_task_stall_windows_range;
ALTER TABLE app_task_stall_windows ADD CONSTRAINT chk_app_task_stall_windows_range CHECK (
  (not_started_minutes IS NULL OR not_started_minutes BETWEEN 1 AND 10080) AND
  (no_progress_minutes IS NULL OR no_progress_minutes BETWEEN 1 AND 10080) AND
  (owner_reaction_minutes IS NULL OR owner_reaction_minutes BETWEEN 1 AND 10080) AND
  (assignment_minutes IS NULL OR assignment_minutes BETWEEN 1 AND 10080)
);
