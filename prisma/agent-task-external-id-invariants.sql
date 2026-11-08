-- #3125 S2 (V46; cor:agt:120:02): a task's external id is 1 to 512 characters. The character rules (no whitespace,
-- control or format characters, no userinfo) are judged by the server before any write; the length is held here.
ALTER TABLE agent_tasks DROP CONSTRAINT IF EXISTS chk_agent_tasks_external_id;
ALTER TABLE agent_tasks ADD CONSTRAINT chk_agent_tasks_external_id CHECK (
  external_id IS NULL OR char_length(external_id) BETWEEN 1 AND 512
);
-- #3125 S2 (V29, V45): one task per external id within an App, whatever its state (a finished or cancelled task still
-- counts as picked up). Per App, so another App's task never conflicts and is never disclosed. createAgentTask turns a
-- violation of exactly this index into TASK_EXTERNAL_ID_TAKEN.
CREATE UNIQUE INDEX IF NOT EXISTS agent_tasks_app_external_id_uniq ON agent_tasks (app_id, external_id)
  WHERE external_id IS NOT NULL;
