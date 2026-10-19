-- #2025 — synced verbatim into the migration; push-synced DBs need the same
-- high-floor backfill BEFORE the new columns/defaults and CHECK are applied.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'apps'
      AND column_name = 'ticker_min_cadence_seconds'
  ) OR EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'apps'
      AND column_name = 'delivery_stuck_window_seconds'
  ) THEN
    RETURN;
  END IF;
  ALTER TABLE apps ADD COLUMN delivery_busy_delay_seconds INTEGER NOT NULL DEFAULT 600;
  ALTER TABLE apps ADD COLUMN delivery_stuck_window_seconds INTEGER NOT NULL DEFAULT 900;
  ALTER TABLE apps ADD COLUMN delivery_standby_enabled BOOLEAN NOT NULL DEFAULT false;
  -- Preserve the manager's cadence; ordinary Apps retain the new-App default.
  UPDATE apps SET delivery_stuck_window_seconds = GREATEST(900, 600 + ticker_min_cadence_seconds + 1);
END $$;

-- #2025 / cor:agt:080:05 — Proposed bounds/relation, approved to build in the scoped gate.
-- One cadence/window column; the existing ticker CHECK still owns its >=60/self-cadence rules.
ALTER TABLE apps DROP CONSTRAINT IF EXISTS chk_apps_delivery_settings;
ALTER TABLE apps ADD CONSTRAINT chk_apps_delivery_settings CHECK (
  delivery_busy_delay_seconds BETWEEN 1 AND 86400
  AND delivery_stuck_window_seconds BETWEEN 1 AND 604800
  AND delivery_stuck_window_seconds > delivery_busy_delay_seconds + ticker_min_cadence_seconds
);
