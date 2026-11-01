-- #2648 (cor:agt:050:14): an agent task's optional finish-by deadline. Nullable, no default, no backfill:
-- an existing task has none, so its stall behavior is unchanged.
ALTER TABLE "agent_tasks" ADD COLUMN "finish_by" TIMESTAMP(3);
