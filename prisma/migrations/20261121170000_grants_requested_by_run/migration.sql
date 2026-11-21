-- #3753 (Grants S2c, cor:acl:140:05 S5): a grant a headless run asked for records that run. One nullable, FK-free sealed id, like
-- the other requested_by_* columns. Nothing else changes: the append-only guard (grant-invariants.sql) lists the movable columns and
-- this one is not among them, so it cannot change after the insert; a run id is not a worker or session id, so no #1162 fence.
ALTER TABLE "grants" ADD COLUMN IF NOT EXISTS "requested_by_run_id" TEXT;
