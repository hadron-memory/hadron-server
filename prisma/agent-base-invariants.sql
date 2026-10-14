-- #1885 (cor:dmo:050:14): an Agent may extend one base Agent.
-- Source of truth for these objects; the migration carries a byte-identical copy
-- (pinned by src/api/graphql/schema/resolvers.agentBase1885.test.ts) and post-push.sql includes this file.
--
-- src/lib/agentBase.ts is the only writer of agents.extends_agent_id and refuses
-- each case below with a typed error before writing. This trigger is the backstop:
-- any other write that would break the rule fails here instead of committing.
--
-- It takes the same transaction-scoped graph lock as the writer
-- (`agent-extends-base`), so two changes on disjoint rows can't each pass the
-- checks and together close a cycle or build a chain of 5. The lock is
-- re-entrant, so the writer, which already holds it, doesn't wait on itself.

CREATE OR REPLACE FUNCTION agent_base_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  above integer;
  below integer;
  is_cycle boolean;
  base_retired boolean;
BEGIN
  IF NEW.extends_agent_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.extends_agent_id IS NOT DISTINCT FROM OLD.extends_agent_id THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('agent-extends-base'));

  -- A retired Agent is never a new base.
  SELECT deleted_at IS NOT NULL INTO base_retired FROM agents WHERE id = NEW.extends_agent_id;
  IF base_retired THEN
    RAISE EXCEPTION 'agent % cannot extend retired agent %', NEW.id, NEW.extends_agent_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'agent_base_live';
  END IF;

  -- The new base and every Agent above it. The depth bound only stops a walk
  -- through an already-corrupt chain; a valid one is at most 3 long.
  WITH RECURSIVE up(id, depth) AS (
    SELECT NEW.extends_agent_id, 1
    UNION ALL
    SELECT a.extends_agent_id, up.depth + 1 FROM agents a JOIN up ON a.id = up.id
    WHERE a.extends_agent_id IS NOT NULL AND up.depth < 8
  )
  SELECT count(*), coalesce(bool_or(id = NEW.id), false) INTO above, is_cycle FROM up;
  IF is_cycle THEN
    RAISE EXCEPTION 'agent % cannot extend agent %: the chain would be a cycle', NEW.id, NEW.extends_agent_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'agent_base_no_cycle';
  END IF;

  -- The longest run of live Agents below this one: every chain through it
  -- must still fit (cor:dmo:050:14, "for this Agent or for any Agent that
  -- already extends it").
  WITH RECURSIVE down(id, depth) AS (
    SELECT id, 1 FROM agents WHERE extends_agent_id = NEW.id AND deleted_at IS NULL
    UNION ALL
    SELECT a.id, down.depth + 1 FROM agents a JOIN down ON a.extends_agent_id = down.id
    WHERE a.deleted_at IS NULL AND down.depth < 8
  )
  SELECT coalesce(max(depth), 0) INTO below FROM down;
  IF below + 1 + above > 4 THEN
    RAISE EXCEPTION 'agent % cannot extend agent %: a chain would hold % Agents, more than 4', NEW.id, NEW.extends_agent_id, below + 1 + above
      USING ERRCODE = 'check_violation', CONSTRAINT = 'agent_base_chain_cap';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_base_guard ON agents;
CREATE TRIGGER agent_base_guard
  BEFORE INSERT OR UPDATE OF extends_agent_id ON agents
  FOR EACH ROW EXECUTE FUNCTION agent_base_guard();
