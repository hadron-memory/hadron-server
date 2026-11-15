-- #4223 (S2 of #4229): a task may ask more than one worker to end its session over its life: the worker it is
-- reassigned away from (a short-lived worker losing its last open task), and later the one it ends under. The
-- one-request-per-task unique index becomes a plain index. No row changes.
-- DropIndex
DROP INDEX "task_session_end_requests_task_id_key";

-- CreateIndex
CREATE INDEX "task_session_end_requests_task_id_idx" ON "task_session_end_requests"("task_id");
