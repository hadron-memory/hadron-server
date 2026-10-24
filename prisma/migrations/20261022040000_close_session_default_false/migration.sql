-- #2249 / R182 (cor:agt:050:10): a task ends its assignee's session only when whoever assigns it asks, so the
-- column defaults to false. Default only: existing rows keep their stored value (an assigner who created a task
-- under the old default keeps what they got), and no data is rewritten. Every create path writes the resolved
-- value explicitly, so this default is reached only by a raw insert that omits the column.
-- SET DEFAULT is a catalog change, not a table rewrite, but it still takes a short ACCESS EXCLUSIVE lock on
-- "agent_tasks" while it applies.
ALTER TABLE "agent_tasks" ALTER COLUMN "close_session_when_done" SET DEFAULT false;
