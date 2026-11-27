-- #5325 (cor:agt:090:01, :02, Decided with Holger's ruling of 2026-11-27): a fourth stop-signal scope, `app`, covering every
-- live worker of the App and naming no target. The shape CHECK admits it (scope in the closed list, and neither a worker nor a
-- host registration); nothing else about stop signals changes. Only the CHECK is carried here, not the whole shared file: the
-- file's trigger functions are unchanged and a CREATE OR REPLACE of them would drop the search_path a later migration gave them
-- (the migration replay would then differ from push + post-push). The block below is the shared file's own, verbatim
-- (src/lib/stopSignals/invariants.test.ts pins that, and pins that the rest of the file is still the original migration's).
--
-- Locking: DROP CONSTRAINT and ADD CONSTRAINT ... CHECK take ACCESS EXCLUSIVE on team_stop_signals and ADD CONSTRAINT scans the
-- table once; it holds a handful of rows per App, so the wait is negligible. No row can fail the new CHECK (every existing row is
-- worker, team or host), so there is no preflight and nothing here refuses on data.
--
-- Compatibility and rollback: the PREVIOUS image never writes an `app` row, so it runs against this CHECK unchanged until the first
-- APP signal is set. After that, rolling the image back is NOT silent-safe: the old code's coverage ignores `app` rows (a live APP
-- signal stops enforcing) and its GraphQL enum cannot serialize the value (listing signals can error). Lift every APP signal before
-- rolling the image back; the CHECK itself can stay (a wider CHECK does not hurt the old code).

ALTER TABLE team_stop_signals DROP CONSTRAINT IF EXISTS chk_team_stop_signals_shape;
ALTER TABLE team_stop_signals ADD CONSTRAINT chk_team_stop_signals_shape CHECK (
  level IN ('pause-dispatch', 'pause', 'halt')
  AND scope IN ('worker', 'team', 'app', 'host')
  AND (CASE WHEN scope = 'host'
            THEN target_host_registration_id IS NOT NULL AND target_worker_id IS NULL
            WHEN scope = 'app'
            THEN target_host_registration_id IS NULL AND target_worker_id IS NULL
            ELSE target_worker_id IS NOT NULL AND target_host_registration_id IS NULL END)
  AND num_nonnulls(set_by_user_id, set_by_app_key_id) = 1
  AND (until IS NULL OR until > set_at)
  AND (CASE WHEN ended_at IS NULL
            THEN end_kind IS NULL AND num_nonnulls(ended_by_user_id, ended_by_app_key_id) = 0
            WHEN end_kind = 'lifted'
            THEN num_nonnulls(ended_by_user_id, ended_by_app_key_id) = 1 AND ended_at >= set_at
            WHEN end_kind = 'expired'
            THEN num_nonnulls(ended_by_user_id, ended_by_app_key_id) = 0 AND until IS NOT NULL AND ended_at = until
            ELSE false END)
);
