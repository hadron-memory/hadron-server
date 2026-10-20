-- #2138 §3.2 — the channel-check settings: a period of at least a minute, and OVERDUE after at least one missed period.
ALTER TABLE apps DROP CONSTRAINT IF EXISTS chk_apps_delivery_check_settings;
ALTER TABLE apps ADD CONSTRAINT chk_apps_delivery_check_settings CHECK (
  delivery_check_period_seconds BETWEEN 60 AND 86400
  AND delivery_failed_checks_to_overdue BETWEEN 1 AND 100
);
