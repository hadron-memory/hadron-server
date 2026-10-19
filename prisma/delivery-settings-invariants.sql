-- #2025 / cor:agt:080:05 — Proposed bounds/relation, approved to build in the scoped gate.
-- One cadence/window column; the existing ticker CHECK still owns its >=60/self-cadence rules.
ALTER TABLE apps DROP CONSTRAINT IF EXISTS chk_apps_delivery_settings;
ALTER TABLE apps ADD CONSTRAINT chk_apps_delivery_settings CHECK (
  delivery_busy_delay_seconds BETWEEN 1 AND 86400
  AND delivery_stuck_window_seconds BETWEEN 1 AND 604800
  AND delivery_stuck_window_seconds > delivery_busy_delay_seconds + ticker_min_cadence_seconds
);
