-- #2755 — the dark-worker alarm's per-App window: 5 minutes to a day.
ALTER TABLE apps DROP CONSTRAINT IF EXISTS chk_apps_delivery_dark_alarm_window;
ALTER TABLE apps ADD CONSTRAINT chk_apps_delivery_dark_alarm_window CHECK (
  delivery_dark_alarm_window_seconds BETWEEN 300 AND 86400
);
