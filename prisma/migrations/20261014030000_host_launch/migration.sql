-- #1709 (T6 slice 2): single-use launch grants and the launch record on a session (cor:agt:070:08).
-- Then the host-launch invariants file, verbatim.
ALTER TABLE "sessions" ADD COLUMN "launch_host_id" TEXT,
ADD COLUMN "launch_issued_by" TEXT,
ADD COLUMN "launch_operation_id" TEXT,
ADD COLUMN "launch_task_id" TEXT;

ALTER TABLE "host_operations" ADD COLUMN "hold_at" TIMESTAMP(3),
ADD COLUMN "hold_user_id" TEXT;

CREATE TABLE "launch_grants" (
    "id" TEXT NOT NULL,
    "app_id" TEXT NOT NULL,
    "operation_id" TEXT NOT NULL,
    "worker_id" TEXT NOT NULL,
    "host_id" TEXT NOT NULL,
    "task_id" TEXT,
    "holder_user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "session_id" TEXT,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "launch_grants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sessions_launch_operation_id_key" ON "sessions"("launch_operation_id");

CREATE UNIQUE INDEX "launch_grants_token_hash_key" ON "launch_grants"("token_hash");

CREATE INDEX "launch_grants_operation_id_idx" ON "launch_grants"("operation_id");

ALTER TABLE "launch_grants" ADD CONSTRAINT "launch_grants_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

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

-- #1883 review (Diego P2-1): a worker.start records the hold that authorized it, and
-- only a worker.start does; it never changes after issue.
ALTER TABLE host_operations DROP CONSTRAINT IF EXISTS chk_host_operations_hold;
ALTER TABLE host_operations ADD CONSTRAINT chk_host_operations_hold CHECK (
  (type = 'worker.start') = (hold_user_id IS NOT NULL) AND
  (hold_at IS NULL OR hold_user_id IS NOT NULL)
);

CREATE OR REPLACE FUNCTION host_operation_hold_fixed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.hold_user_id, NEW.hold_at) IS DISTINCT FROM (OLD.hold_user_id, OLD.hold_at) THEN
    RAISE EXCEPTION 'A start''s authorizing hold never changes' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_host_operations_hold_fixed ON host_operations;
CREATE TRIGGER trg_host_operations_hold_fixed
  BEFORE UPDATE ON host_operations
  FOR EACH ROW EXECUTE FUNCTION host_operation_hold_fixed();
