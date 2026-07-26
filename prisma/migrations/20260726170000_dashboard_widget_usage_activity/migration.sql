-- #797 — the usage-activity dashboard widget (#796's `usageActivity` query as a
-- config-aware widget: the first placement whose data depends on its config).
--
-- Single file is safe here: nothing references the new enum value in the same
-- transaction (no CHECK constraint over this enum), which is the two-file rule's
-- trigger. IF NOT EXISTS mirrors the AGENT_STATS migration.
ALTER TYPE "DashboardWidgetType" ADD VALUE IF NOT EXISTS 'USAGE_ACTIVITY';
