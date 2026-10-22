-- #2249 / R182: a task ends its assignee's session only when whoever assigns it
-- asks, so an omitted close_session_when_done is false. Changes the column
-- default only: SET DEFAULT is a catalog change (no table rewrite), and every
-- existing row keeps the value it was stored with.
ALTER TABLE "agent_tasks" ALTER COLUMN "close_session_when_done" SET DEFAULT false;
