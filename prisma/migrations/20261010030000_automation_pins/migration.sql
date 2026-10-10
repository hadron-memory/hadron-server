-- No backfill: legacy triggers must be explicitly re-adopted by the run-as user.
ALTER TABLE app_runs ADD COLUMN automation_pin JSONB;
ALTER TABLE agent_schedules ADD COLUMN automation_pin JSONB;
ALTER TABLE agent_webhooks ADD COLUMN automation_pin JSONB;
CREATE TABLE manual_automation_pins (
  run_id TEXT PRIMARY KEY REFERENCES app_runs(id) ON DELETE CASCADE,
  pin JSONB NOT NULL,
  adopted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  adopted_by TEXT
);
