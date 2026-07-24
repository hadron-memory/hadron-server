-- #636 (portal): second dashboard widget. Add the AGENT_STATS widget type so a
-- user can place an "agents" widget (count + Create new). Standalone ADD VALUE —
-- no CHECK/column references the new value, so there's no same-transaction hazard.

-- AlterEnum
ALTER TYPE "DashboardWidgetType" ADD VALUE 'AGENT_STATS';
