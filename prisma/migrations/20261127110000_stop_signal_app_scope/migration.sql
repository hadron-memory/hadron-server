-- #5325 (cor:agt:090:01, :02, Decided with Holger's ruling of 2026-11-27): a fourth stop-signal scope, `app`, covering every
-- live worker of the App and naming no target. The shape CHECK admits it (scope in the closed list, and neither a worker nor a
-- host registration); nothing else about stop signals changes. Only the CHECK is carried here, not the whole shared file: the
-- file's trigger functions are unchanged and a CREATE OR REPLACE of them would drop the search_path setting a later migration
-- gave them (the migration replay would then differ from push + post-push). The block below is the shared file's own, verbatim
-- (src/lib/stopSignals/invariants.test.ts pins that). Re-adding the CHECK scans team_stop_signals once under SHARE ROW
-- EXCLUSIVE, a table that holds a handful of rows per App. No row can fail it (every existing row is worker, team or host), so
-- there is no preflight and no HDPRF refusal. The previous image never writes an `app` row, so it runs unchanged against it.

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
