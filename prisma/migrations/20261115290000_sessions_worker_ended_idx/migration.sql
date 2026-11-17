-- #4273: the worker-liveness read (workerActivitySql) keeps a worker's open sessions and walks its ended ones from the newest
-- end backwards, stopping at the worker's latest start. This partial index serves both: `ended_at IS NULL`, and the walk's
-- `ORDER BY ended_at DESC, id DESC LIMIT 1` probes.
--
-- expand-safe: the previous image runs against this schema (an index only; no column, constraint or data change).
--
-- Built CONCURRENTLY, so writes to sessions are not blocked while it builds on a large table. CONCURRENTLY cannot run inside
-- a transaction block, and `prisma migrate deploy` sends a migration file as ONE simple query, which Postgres runs as an
-- implicit transaction only when it holds several statements (SQLSTATE 25001). So this file must stay a single statement:
-- add nothing else here (the 20261014040000 pattern).
--
-- A failed CONCURRENTLY build leaves an INVALID index under this name, which IF NOT EXISTS would then skip. If
-- `\d sessions` ever shows it INVALID, drop it and re-run this statement by hand.
CREATE INDEX CONCURRENTLY IF NOT EXISTS sessions_worker_ended_idx
  ON sessions (worker_id, ended_at DESC, id DESC) WHERE deleted_at IS NULL;
