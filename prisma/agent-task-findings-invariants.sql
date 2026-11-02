-- #2662 / cor:agt:050:30: findings belong only to the immutable finished result.
-- Shape inside the bounded list is validated by finishFindings before any write.
-- SQL NULL and JSON null both mean no findings (Prisma row copies may emit JSON null).
ALTER TABLE agent_tasks DROP CONSTRAINT IF EXISTS chk_agent_task_findings;
ALTER TABLE agent_tasks ADD CONSTRAINT chk_agent_task_findings CHECK (
  NULLIF(result_findings, 'null'::jsonb) IS NULL OR (
    status = 'finished' AND CASE WHEN jsonb_typeof(result_findings) = 'array'
      THEN jsonb_array_length(result_findings) <= 100 ELSE false END
  )
);
CREATE OR REPLACE FUNCTION guard_agent_task_findings() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'finished' AND NULLIF(NEW.result_findings, 'null'::jsonb) IS DISTINCT FROM NULLIF(OLD.result_findings, 'null'::jsonb) THEN
    RAISE EXCEPTION 'Finished task findings are immutable' USING ERRCODE = '23514', CONSTRAINT = 'chk_agent_task_findings_immutable';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS agent_task_findings_immutable ON agent_tasks;
CREATE TRIGGER agent_task_findings_immutable BEFORE UPDATE ON agent_tasks
FOR EACH ROW EXECUTE FUNCTION guard_agent_task_findings();
