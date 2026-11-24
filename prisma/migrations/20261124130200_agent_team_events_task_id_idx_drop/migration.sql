-- #4344: agent_team_events_task_id_type_idx (20261124130000) serves every task_id lookup, so the single-column index is redundant.
-- Runs after that index was built; if `\d agent_team_events` shows it INVALID (a failed CONCURRENTLY build), rebuild it BEFORE this
-- drop takes effect in any environment you control. Single statement, CONCURRENTLY, for the same reasons as the previous migration.
DROP INDEX CONCURRENTLY IF EXISTS "agent_team_events_task_id_idx";
