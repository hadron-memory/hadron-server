-- #2138 §3 — channel checks: lastCheckedAt, the check settings, a team pause flag, Agent.usesTasks.
ALTER TABLE "channel_read_states" ADD COLUMN IF NOT EXISTS "last_checked_at" TIMESTAMP(3);
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "delivery_check_period_seconds" INTEGER NOT NULL DEFAULT 600;
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "delivery_failed_checks_to_overdue" INTEGER NOT NULL DEFAULT 2;
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "team_paused_at" TIMESTAMP(3);
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "team_resumed_at" TIMESTAMP(3);
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "uses_tasks" BOOLEAN NOT NULL DEFAULT true;

-- #2138 §3.2 — the channel-check settings: a period of at least a minute, and OVERDUE after at least one missed period.
ALTER TABLE apps DROP CONSTRAINT IF EXISTS chk_apps_delivery_check_settings;
ALTER TABLE apps ADD CONSTRAINT chk_apps_delivery_check_settings CHECK (
  delivery_check_period_seconds BETWEEN 60 AND 86400
  AND delivery_failed_checks_to_overdue BETWEEN 1 AND 100
);
