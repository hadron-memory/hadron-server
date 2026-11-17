-- #4273: the latest start of a worker's sessions (the bound in workerActivitySql's kept ended sessions) from the end of one
-- index range instead of a read of every session the worker ever had. See 20261115290000_sessions_worker_ended_idx.
--
-- expand-safe: the previous image runs against this schema (an index only; no column, constraint or data change).
--
-- Built CONCURRENTLY (no write block on a large table); one statement per file, for the reason in 20261115290000.
-- A failed build leaves an INVALID index of this name that IF NOT EXISTS would skip: drop it and re-run by hand.
CREATE INDEX CONCURRENTLY IF NOT EXISTS sessions_worker_started_idx
  ON sessions (worker_id, started_at DESC) WHERE deleted_at IS NULL;
