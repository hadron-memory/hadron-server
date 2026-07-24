-- #636 (portal): second dashboard widget. Add the AGENT_STATS widget type so a
-- user can place an "agents" widget (count + Create new). Standalone ADD VALUE —
-- no CHECK/column references the new value, so there's no same-transaction hazard.

-- AlterEnum
-- IF NOT EXISTS so `migrate deploy` is idempotent on any env where the value
-- was already added out-of-band (manual hotfix / prior schema sync) — matching
-- this repo's other enum-add migrations (Copilot review on #776).
ALTER TYPE "DashboardWidgetType" ADD VALUE IF NOT EXISTS 'AGENT_STATS';
