-- #2663: additive storage; findings/result columns remain untouched.
ALTER TABLE agent_tasks ADD COLUMN finding_dispositions JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE agent_tasks ADD COLUMN unresolved_finding_ids TEXT[] NOT NULL DEFAULT ARRAY[]::text[];
-- #2663 / hrn:node:hadronmemory.com:specs:cor:agt:050:30: dispositions live beside the finished result.
-- The bounded open-id projection is database-derived, so every list filters before paging, never after it.
CREATE OR REPLACE FUNCTION maintain_agent_task_dispositions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF jsonb_typeof(NEW.finding_dispositions) IS DISTINCT FROM 'array'
     OR jsonb_array_length(NEW.finding_dispositions) > 100 THEN
    RAISE EXCEPTION 'Invalid finding dispositions' USING ERRCODE = '23514', CONSTRAINT = 'chk_agent_task_dispositions';
  END IF;
  IF jsonb_array_length(NEW.finding_dispositions) > 0 AND NEW.status <> 'finished' THEN
    RAISE EXCEPTION 'Only finished tasks have dispositions' USING ERRCODE = '23514', CONSTRAINT = 'chk_agent_task_dispositions';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.finding_dispositions) d
    WHERE jsonb_typeof(d) IS DISTINCT FROM 'object'
       OR d->>'disposition' IS NULL OR d->>'disposition' NOT IN ('fixed','accepted','deferred','rejected')
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW.result_findings) = 'array' THEN NEW.result_findings ELSE '[]'::jsonb END) f WHERE f->>'id' = d->>'findingId')
  ) OR (SELECT count(*) FROM jsonb_array_elements(NEW.finding_dispositions))
       <> (SELECT count(DISTINCT d->>'findingId') FROM jsonb_array_elements(NEW.finding_dispositions) d) THEN
    RAISE EXCEPTION 'Invalid finding disposition target or code' USING ERRCODE = '23514', CONSTRAINT = 'chk_agent_task_dispositions';
  END IF;
  IF TG_OP = 'UPDATE' AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(OLD.finding_dispositions) d
    WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.finding_dispositions) n WHERE n->>'findingId' = d->>'findingId')
  ) THEN
    RAISE EXCEPTION 'Finding dispositions cannot be cleared' USING ERRCODE = '23514', CONSTRAINT = 'chk_agent_task_dispositions';
  END IF;
  SELECT COALESCE(array_agg(f.value->>'id' ORDER BY f.ordinality), ARRAY[]::text[])
    INTO NEW.unresolved_finding_ids
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW.result_findings) = 'array' THEN NEW.result_findings ELSE '[]'::jsonb END) WITH ORDINALITY f
    WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.finding_dispositions) d WHERE d->>'findingId' = f.value->>'id');
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS agent_task_dispositions ON agent_tasks;
CREATE TRIGGER agent_task_dispositions BEFORE INSERT OR UPDATE OF status, result_findings, finding_dispositions, unresolved_finding_ids ON agent_tasks
FOR EACH ROW EXECUTE FUNCTION maintain_agent_task_dispositions();

-- Backfill only the derived projection for findings finished before this migration.
UPDATE agent_tasks SET finding_dispositions = finding_dispositions WHERE jsonb_typeof(result_findings) = 'array';
