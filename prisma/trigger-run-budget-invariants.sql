-- #2479: NULL inherits the current platform default; only positive stored limits.
ALTER TABLE agent_schedules DROP CONSTRAINT IF EXISTS chk_schedule_run_budgets_positive;
ALTER TABLE agent_schedules ADD CONSTRAINT chk_schedule_run_budgets_positive CHECK (
  (budget_tokens IS NULL OR budget_tokens > 0) AND (budget_actions IS NULL OR budget_actions > 0)
);
ALTER TABLE agent_webhooks DROP CONSTRAINT IF EXISTS chk_webhook_run_budgets_positive;
ALTER TABLE agent_webhooks ADD CONSTRAINT chk_webhook_run_budgets_positive CHECK (
  (budget_tokens IS NULL OR budget_tokens > 0) AND (budget_actions IS NULL OR budget_actions > 0)
);
