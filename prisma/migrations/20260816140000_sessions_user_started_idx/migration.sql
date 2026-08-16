-- #1016 (PR #1019 review) — supporting index for the "what am I driving?" read.
--
-- `hadron_whoami` answers a caller's OWN open sessions:
--
--   WHERE user_id = $1 AND ended_at IS NULL AND deleted_at IS NULL
--   ORDER BY started_at DESC LIMIT n
--
-- and the sessions table had no index leading with `user_id`. `[app_id,
-- user_id]` does not serve it — Postgres will not seek on a composite index's
-- SECOND column — so the planner fell back to `sessions_started_at_idx` and
-- scanned the session history backwards, filtering. The cost is worst for the
-- caller with NO open session, since nothing lets the scan stop early: it walks
-- the whole table. That is precisely the compaction-recovery case the tool
-- exists for, and the one an agent retries.
--
-- Deliberately NOT a partial index on `ended_at IS NULL AND deleted_at IS NULL`,
-- which would be smaller and serve the default path perfectly: the tool's
-- `includeEnded` option drops both predicates, and a partial index cannot answer
-- that query at all. One plain composite serves both shapes, and the
-- (user, recent-first) prefix is the access pattern any future "my sessions"
-- read will want too.
--
-- `started_at` is left ASCending: a btree scans backwards for DESC at no cost,
-- and Prisma's schema-level index is spelled the same way, so `db push`-managed
-- dev/test databases (which have no migration history — see CLAUDE.md "Local
-- Postgres setup") converge on an identical object.

CREATE INDEX IF NOT EXISTS "sessions_user_id_started_at_idx"
    ON "sessions" ("user_id", "started_at");
