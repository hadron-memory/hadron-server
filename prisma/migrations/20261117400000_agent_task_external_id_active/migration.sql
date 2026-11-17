-- #4217 (cor:agt:120:02, Holger 2026-11-14): the external-id unique index covers only ACTIVE tasks (backlog, pending, started).
-- The statements below are prisma/agent-task-external-id-invariants.sql verbatim (pinned by src/lib/agentTasks/invariants.test.ts).
-- #3125 S2 (V46; cor:agt:120:02): a task's external id is 1 to 512 characters. The character rules (no whitespace,
-- control or format characters, no userinfo) are judged by the server before any write; the length is held here.
ALTER TABLE agent_tasks DROP CONSTRAINT IF EXISTS chk_agent_tasks_external_id;
ALTER TABLE agent_tasks ADD CONSTRAINT chk_agent_tasks_external_id CHECK (
  external_id IS NULL OR char_length(external_id) BETWEEN 1 AND 512
);
-- #3125 S2 (V29, V45), amended by #4217 (cor:agt:120:02, Holger 2026-11-14): an external id is held by at most ONE ACTIVE task
-- (backlog, pending or started) within an App. A finished or cancelled task keeps its id but no longer blocks a new claim,
-- so an item can have a history of tasks. Per App, so another App's task never conflicts and is never disclosed.
-- createAgentTask turns a violation of exactly this index into TASK_EXTERNAL_ID_TAKEN. Dropped and rebuilt, because
-- IF NOT EXISTS would keep an older, all-status index: the predicate only narrows, so no existing row can fail it.
DROP INDEX IF EXISTS agent_tasks_app_external_id_uniq;
CREATE UNIQUE INDEX agent_tasks_app_external_id_uniq ON agent_tasks (app_id, external_id)
  WHERE external_id IS NOT NULL AND status IN ('backlog', 'pending', 'started');
