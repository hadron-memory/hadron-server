-- CreateTable
CREATE TABLE "agent_tasks" (
    "id" TEXT NOT NULL,
    "app_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "source" TEXT,
    "parent_task_id" TEXT,
    "owner_worker_id" TEXT,
    "owner_user_id" TEXT,
    "assignee_worker_id" TEXT,
    "assignee_user_id" TEXT,
    "requirements" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "start_by" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "result_outcome" TEXT,
    "result_summary" TEXT,
    "result_evidence" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "close_session_when_done" BOOLEAN NOT NULL DEFAULT true,
    "assigned_at" TIMESTAMP(3),
    "assigned_by" TEXT,
    "assigned_by_worker_id" TEXT,
    "assigned_by_agent_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "created_by_worker_id" TEXT,
    "created_by_agent_id" TEXT,
    "updated_at" TIMESTAMP(3),
    "updated_by" TEXT,
    "updated_by_worker_id" TEXT,
    "updated_by_agent_id" TEXT,

    CONSTRAINT "agent_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_team_events" (
    "id" TEXT NOT NULL,
    "app_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "task_id" TEXT,
    "actor_user_id" TEXT,
    "actor_worker_id" TEXT,
    "actor_agent_id" TEXT,
    "subject_worker_id" TEXT,
    "severity" TEXT,
    "chain" JSONB,
    "acknowledged_by_user_id" TEXT,
    "acknowledged_by_worker_id" TEXT,
    "acknowledged_at" TIMESTAMP(3),
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_team_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_tasks_app_id_status_idx" ON "agent_tasks"("app_id", "status");

-- CreateIndex
CREATE INDEX "agent_tasks_parent_task_id_idx" ON "agent_tasks"("parent_task_id");

-- CreateIndex
CREATE INDEX "agent_tasks_owner_worker_id_idx" ON "agent_tasks"("owner_worker_id");

-- CreateIndex
CREATE INDEX "agent_tasks_owner_user_id_idx" ON "agent_tasks"("owner_user_id");

-- CreateIndex
CREATE INDEX "agent_tasks_assignee_worker_id_idx" ON "agent_tasks"("assignee_worker_id");

-- CreateIndex
CREATE INDEX "agent_tasks_assignee_user_id_idx" ON "agent_tasks"("assignee_user_id");

-- CreateIndex
CREATE INDEX "agent_team_events_app_id_created_at_idx" ON "agent_team_events"("app_id", "created_at");

-- CreateIndex
CREATE INDEX "agent_team_events_task_id_idx" ON "agent_team_events"("task_id");

-- AddForeignKey
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_parent_task_id_fkey" FOREIGN KEY ("parent_task_id") REFERENCES "agent_tasks"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_owner_worker_id_fkey" FOREIGN KEY ("owner_worker_id") REFERENCES "workers"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_assignee_worker_id_fkey" FOREIGN KEY ("assignee_worker_id") REFERENCES "workers"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_assignee_user_id_fkey" FOREIGN KEY ("assignee_user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_team_events" ADD CONSTRAINT "agent_team_events_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_team_events" ADD CONSTRAINT "agent_team_events_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "agent_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- #1705 (Task Management T1): agent task shape and the append-only team event stream.
-- Source of truth for these objects; the migration carries a byte-identical copy
-- (pinned by src/lib/agentTasks/invariants.test.ts) and post-push.sql includes this file.

-- cor:agt:050:01 / :02 — one owner, at most one assignee, the four statuses,
-- per-status timestamps, and a result only on a finished task.
ALTER TABLE agent_tasks DROP CONSTRAINT IF EXISTS chk_agent_tasks_shape;
ALTER TABLE agent_tasks ADD CONSTRAINT chk_agent_tasks_shape CHECK (
  num_nonnulls(owner_worker_id, owner_user_id) = 1 AND
  num_nonnulls(assignee_worker_id, assignee_user_id) <= 1 AND
  (num_nonnulls(assignee_worker_id, assignee_user_id) = 0 OR assigned_at IS NOT NULL) AND
  (parent_task_id IS NULL OR parent_task_id <> id) AND
  length(title) BETWEEN 1 AND 500 AND
  CASE status
    WHEN 'pending' THEN
      started_at IS NULL AND finished_at IS NULL AND cancelled_at IS NULL
    WHEN 'started' THEN
      started_at IS NOT NULL AND finished_at IS NULL AND cancelled_at IS NULL AND
      num_nonnulls(assignee_worker_id, assignee_user_id) = 1
    WHEN 'finished' THEN
      started_at IS NOT NULL AND finished_at IS NOT NULL AND cancelled_at IS NULL AND
      num_nonnulls(assignee_worker_id, assignee_user_id) = 1
    WHEN 'cancelled' THEN
      finished_at IS NULL AND cancelled_at IS NOT NULL
    ELSE false
  END AND
  (CASE WHEN status = 'finished' THEN result_outcome IS NOT NULL AND result_outcome <> ''
        ELSE num_nonnulls(result_outcome, result_summary, result_evidence) = 0 END)
);

-- cor:agt:050:11 — only an alarm carries a chain and an acknowledgement, and an
-- acknowledgement names who gave it.
ALTER TABLE agent_team_events DROP CONSTRAINT IF EXISTS chk_agent_team_events_shape;
ALTER TABLE agent_team_events ADD CONSTRAINT chk_agent_team_events_shape CHECK (
  type ~ '^[a-z]+(\.[a-z]+(-[a-z]+)*)+$' AND
  (severity IS NULL OR severity = 'alarm') AND
  -- IS NOT NULL, not = 'alarm': a NULL severity would make that comparison
  -- NULL, and a CHECK that evaluates to NULL passes.
  (severity IS NOT NULL OR num_nonnulls(chain, acknowledged_by_user_id, acknowledged_by_worker_id, acknowledged_at) = 0) AND
  (CASE WHEN acknowledged_at IS NULL
        THEN num_nonnulls(acknowledged_by_user_id, acknowledged_by_worker_id) = 0
        ELSE num_nonnulls(acknowledged_by_user_id, acknowledged_by_worker_id) >= 1 END) AND
  jsonb_typeof(payload) = 'object'
);

-- Append-only (cor:agt:050:11): an event is never changed or removed. The one
-- write after insert is an alarm's acknowledgement, set once (cor:agt:050:20).
-- An INSERT may not arrive already acknowledged, and a DELETE is refused unless
-- the App row is already gone, which is the only way one happens: the
-- ON DELETE CASCADE of an App hard delete (URN reclaim, account deletion).
--
-- Limits, recorded on purpose (#1713 review, Rook P3-2):
--   - TRUNCATE fires no row trigger. It is the TEST-ONLY cleanup path
--     (src/test/helpers.ts cleanDb); no application code truncates this table.
--   - The table owner can disable the trigger; this guards the application,
--     not a DB superuser.
--   - It cannot check WHO acknowledges or WHEN. The acknowledging mutation
--     (T2, #1706) must check chain membership against the LOCKED alarm row and
--     stamp acknowledged_at with the server's now(), never a client value.
CREATE OR REPLACE FUNCTION hadron_append_only_agent_team_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF num_nonnulls(NEW.acknowledged_by_user_id, NEW.acknowledged_by_worker_id, NEW.acknowledged_at) <> 0 THEN
      RAISE EXCEPTION 'An agent team event cannot be inserted already acknowledged' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM apps WHERE id = OLD.app_id) THEN
      RAISE EXCEPTION 'Agent team events are append-only' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['acknowledged_by_user_id','acknowledged_by_worker_id','acknowledged_at'])
       IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['acknowledged_by_user_id','acknowledged_by_worker_id','acknowledged_at']) THEN
    RAISE EXCEPTION 'Agent team events are append-only' USING ERRCODE = '23514';
  END IF;
  IF OLD.acknowledged_at IS NOT NULL AND
     ROW(NEW.acknowledged_by_user_id, NEW.acknowledged_by_worker_id, NEW.acknowledged_at) IS DISTINCT FROM
     ROW(OLD.acknowledged_by_user_id, OLD.acknowledged_by_worker_id, OLD.acknowledged_at) THEN
    RAISE EXCEPTION 'An alarm acknowledgement is set once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS agent_team_event_append_only ON agent_team_events;
CREATE TRIGGER agent_team_event_append_only BEFORE INSERT OR UPDATE OR DELETE ON agent_team_events
FOR EACH ROW EXECUTE FUNCTION hadron_append_only_agent_team_event();
