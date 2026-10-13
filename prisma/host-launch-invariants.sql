-- #1709 (Task Management T6, slice 2): launch grants and host-launched sessions.
-- Source of truth for these objects; the migration carries a byte-identical copy
-- (pinned by src/lib/hostOperations/launch.test.ts) and post-push.sql includes this file.

-- A grant lives a short while after it is minted, and ends exactly one way: consumed
-- by the bind it made (naming that session), or revoked by a re-collection. At most
-- one grant per operation is live at a time.
ALTER TABLE launch_grants DROP CONSTRAINT IF EXISTS chk_launch_grants_shape;
ALTER TABLE launch_grants ADD CONSTRAINT chk_launch_grants_shape CHECK (
  expires_at > issued_at AND
  ((consumed_at IS NULL) = (session_id IS NULL)) AND
  num_nonnulls(consumed_at, revoked_at) <= 1
);
CREATE UNIQUE INDEX IF NOT EXISTS launch_grants_live_per_operation
  ON launch_grants (operation_id) WHERE consumed_at IS NULL AND revoked_at IS NULL;

-- cor:agt:070:08 (Holger via Vera #10773): a host-launched session records its host,
-- its worker.start operation and who issued it (the platform, or a manager), all or
-- none; a task only beside them; and only a worker's session is launched.
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS chk_sessions_launch;
ALTER TABLE sessions ADD CONSTRAINT chk_sessions_launch CHECK (
  (num_nonnulls(launch_host_id, launch_operation_id, launch_issued_by) IN (0, 3)) AND
  (launch_task_id IS NULL OR launch_operation_id IS NOT NULL) AND
  (launch_issued_by IS NULL OR launch_issued_by IN ('platform', 'manager')) AND
  (launch_operation_id IS NULL OR worker_id IS NOT NULL)
);
