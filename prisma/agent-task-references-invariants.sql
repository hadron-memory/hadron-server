-- #2649 (cor:agt:050:01 References): a task's references are one JSON array of at most 20 items. The shape of each
-- item (kind, target form, caps) is checked by the server before any write; the array and its count are held here.
ALTER TABLE agent_tasks DROP CONSTRAINT IF EXISTS chk_agent_tasks_references;
ALTER TABLE agent_tasks ADD CONSTRAINT chk_agent_tasks_references CHECK (
  jsonb_typeof(task_references) = 'array' AND jsonb_array_length(task_references) <= 20
);
