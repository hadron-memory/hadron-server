-- #2646 (cor:agt:050:02, What a clone does): the link from a clone to the task it was made from. Nullable, no backfill:
-- no existing task was made by a clone. A removed source leaves its clones standing with no link (ON DELETE SET NULL).
ALTER TABLE "agent_tasks" ADD COLUMN "cloned_from_id" TEXT;
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_cloned_from_id_fkey"
  FOREIGN KEY ("cloned_from_id") REFERENCES "agent_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "agent_tasks_cloned_from_id_idx" ON "agent_tasks"("cloned_from_id");
