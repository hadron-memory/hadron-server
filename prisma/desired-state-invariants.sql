-- #4224 (S3 of #4229): the leave-alone marker's fields travel together. A marked worker says when it was marked;
-- an unmarked one carries no reason, setter or time. Same rule as the migration (20261115160000_desired_state).
ALTER TABLE workers DROP CONSTRAINT IF EXISTS chk_workers_leave_alone_shape;
ALTER TABLE workers ADD CONSTRAINT chk_workers_leave_alone_shape CHECK (
  (leave_alone AND leave_alone_at IS NOT NULL)
  OR (NOT leave_alone AND leave_alone_reason IS NULL AND leave_alone_by IS NULL AND leave_alone_at IS NULL)
);
