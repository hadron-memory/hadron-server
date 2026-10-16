-- #1892 (cor:dmo:050:15, cor:dmo:050:16): an Agent's tasks-index and
-- processes-index pointers, typed fields next to the base Agent.
ALTER TABLE "agents" ADD COLUMN "tasks_index_ref" TEXT;
ALTER TABLE "agents" ADD COLUMN "processes_index_ref" TEXT;

ALTER TABLE "agents" ADD CONSTRAINT "agents_tasks_index_ref_fkey" FOREIGN KEY ("tasks_index_ref") REFERENCES "nodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "agents" ADD CONSTRAINT "agents_processes_index_ref_fkey" FOREIGN KEY ("processes_index_ref") REFERENCES "nodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
