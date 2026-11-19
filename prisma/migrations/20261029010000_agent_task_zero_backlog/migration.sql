-- #2666: AT0 is backlog on every write, including INSERT (cor:agt:050:01).
-- Refuse legacy violations with a count; never silently change their status.
DO $$
DECLARE invalid_count bigint;
BEGIN
  LOCK TABLE agent_tasks IN SHARE ROW EXCLUSIVE MODE;
  SELECT count(*) INTO invalid_count FROM agent_tasks WHERE task_number = 0 AND status <> 'backlog';
  IF invalid_count > 0 THEN
    RAISE EXCEPTION 'cannot enforce AT0 backlog: % task_number=0 rows are outside backlog; no rows changed', invalid_count;
  END IF;
END $$;
ALTER TABLE agent_tasks DROP CONSTRAINT IF EXISTS chk_agent_tasks_zero_backlog;
ALTER TABLE agent_tasks ADD CONSTRAINT chk_agent_tasks_zero_backlog CHECK (task_number > 0 OR status = 'backlog');
