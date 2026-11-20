-- #4414 / cor:agt:050:30: optional role tasks followed, set once at finish. Existing results stay NULL.
ALTER TABLE "agent_tasks" ADD COLUMN "result_worked_from_role_task_refs" JSONB;
-- #4414 / cor:agt:050:30: the role tasks followed belong only to the immutable finished result.
-- Shape inside the bounded list is validated by finishRoleTaskRefs before any write.
-- SQL NULL and JSON null both mean none (Prisma row copies may emit JSON null).
ALTER TABLE agent_tasks DROP CONSTRAINT IF EXISTS chk_agent_task_role_task_refs;
ALTER TABLE agent_tasks ADD CONSTRAINT chk_agent_task_role_task_refs CHECK (
  NULLIF(result_worked_from_role_task_refs, 'null'::jsonb) IS NULL OR (
    status = 'finished' AND CASE WHEN jsonb_typeof(result_worked_from_role_task_refs) = 'array'
      THEN jsonb_array_length(result_worked_from_role_task_refs) <= 10 ELSE false END
  )
);
CREATE OR REPLACE FUNCTION guard_agent_task_role_task_refs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'finished' AND NULLIF(NEW.result_worked_from_role_task_refs, 'null'::jsonb) IS DISTINCT FROM NULLIF(OLD.result_worked_from_role_task_refs, 'null'::jsonb) THEN
    RAISE EXCEPTION 'Finished task role tasks followed are immutable' USING ERRCODE = '23514', CONSTRAINT = 'chk_agent_task_role_task_refs_immutable';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS agent_task_role_task_refs_immutable ON agent_tasks;
CREATE TRIGGER agent_task_role_task_refs_immutable BEFORE UPDATE ON agent_tasks
FOR EACH ROW EXECUTE FUNCTION guard_agent_task_role_task_refs();
