-- #1756 (cor:agt:050:06): a headless run may create root agent tasks and is recorded as their creator. Additive only.
ALTER TABLE "agent_tasks" ADD COLUMN "created_by_run_id" TEXT;
ALTER TABLE "agent_team_events" ADD COLUMN "actor_run_id" TEXT;
