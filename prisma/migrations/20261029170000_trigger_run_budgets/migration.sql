-- #2479: additive nullable limits leave existing triggers and AppRun snapshots unchanged.
ALTER TABLE agent_schedules ADD COLUMN budget_tokens INTEGER, ADD COLUMN budget_actions INTEGER;
ALTER TABLE agent_webhooks ADD COLUMN budget_tokens INTEGER, ADD COLUMN budget_actions INTEGER;
ALTER TABLE agent_schedules ADD CONSTRAINT chk_schedule_run_budgets_positive CHECK ((budget_tokens IS NULL OR budget_tokens > 0) AND (budget_actions IS NULL OR budget_actions > 0));
ALTER TABLE agent_webhooks ADD CONSTRAINT chk_webhook_run_budgets_positive CHECK ((budget_tokens IS NULL OR budget_tokens > 0) AND (budget_actions IS NULL OR budget_actions > 0));
