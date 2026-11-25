-- #5018 (Billing A14): a node's recorded size (hrn:node:hadronmemory.com:specs:cor:dmo:060:18). One source, shared verbatim with
-- migration 20261125010000_node_bytes. Every statement is idempotent (OR REPLACE, drop-then-add).
--
-- nodes.stored_bytes   the bytes of content, description, data and properties as stored (data and properties as their jsonb text),
--                      capped at the Int range so a write is never refused for its size.
-- nodes.revision_bytes the same figure summed over the node's rows in node_revisions; a new node has 0, and a node that is not
--                      measured yet (NULL) stays NULL until the hand-run backfill, so no trigger ever guesses a starting value.
-- Each function pins its own search path (public, pg_temp), as 20261125000000_guard_function_search_path asks of any function created after it (#5096).
-- Every table and function the trigger bodies read or write is schema-qualified, so a session temp table named `nodes` cannot shadow them (#5089).
-- The revision INSERT path depends on createNodeRevision taking the node row's lock first (it bumps rev_seq before it inserts). A bulk delete
-- (clearNodeHistory over K revisions) is K single-row updates of the node row: leave it so, the trigger shape cannot batch it.
-- The triggers keep the figures right for every writer, the raw UPDATEs of data included. The revision triggers update the node
-- row, which the revision writer already holds locked, so the figure cannot drift under a concurrent edit or the backfill.

CREATE OR REPLACE FUNCTION hadron_node_state_bytes(p_content text, p_description text, p_data jsonb, p_properties jsonb)
RETURNS bigint LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = public, pg_temp AS $$
  SELECT COALESCE(octet_length(p_content), 0)::bigint
       + COALESCE(octet_length(p_description), 0)
       + COALESCE(octet_length(p_data::text), 0)
       + COALESCE(octet_length(p_properties::text), 0)
$$;

CREATE OR REPLACE FUNCTION nodes_record_stored_bytes() RETURNS trigger SET search_path = public, pg_temp AS $$
BEGIN
  NEW.stored_bytes := LEAST(public.hadron_node_state_bytes(NEW.content, NEW.description, NEW.data, NEW.properties), 2147483647);
  IF TG_OP = 'INSERT' THEN
    NEW.revision_bytes := 0;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS nodes_record_stored_bytes ON nodes;
CREATE TRIGGER nodes_record_stored_bytes BEFORE INSERT OR UPDATE OF content, description, data, properties ON nodes
  FOR EACH ROW EXECUTE FUNCTION nodes_record_stored_bytes();

CREATE OR REPLACE FUNCTION node_revisions_record_bytes() RETURNS trigger SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.nodes SET revision_bytes = revision_bytes + public.hadron_node_state_bytes(NEW.content, NEW.description, NEW.data, NEW.properties)
      WHERE id = NEW.node_id AND revision_bytes IS NOT NULL;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.nodes SET revision_bytes = GREATEST(revision_bytes - public.hadron_node_state_bytes(OLD.content, OLD.description, OLD.data, OLD.properties), 0)
      WHERE id = OLD.node_id AND revision_bytes IS NOT NULL;
  ELSE
    UPDATE public.nodes SET revision_bytes = GREATEST(
        revision_bytes - public.hadron_node_state_bytes(OLD.content, OLD.description, OLD.data, OLD.properties)
                       + public.hadron_node_state_bytes(NEW.content, NEW.description, NEW.data, NEW.properties), 0)
      WHERE id = NEW.node_id AND revision_bytes IS NOT NULL;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS node_revisions_record_bytes_insert ON node_revisions;
CREATE TRIGGER node_revisions_record_bytes_insert AFTER INSERT ON node_revisions
  FOR EACH ROW EXECUTE FUNCTION node_revisions_record_bytes();
DROP TRIGGER IF EXISTS node_revisions_record_bytes_delete ON node_revisions;
CREATE TRIGGER node_revisions_record_bytes_delete AFTER DELETE ON node_revisions
  FOR EACH ROW EXECUTE FUNCTION node_revisions_record_bytes();
DROP TRIGGER IF EXISTS node_revisions_record_bytes_update ON node_revisions;
CREATE TRIGGER node_revisions_record_bytes_update AFTER UPDATE OF content, description, data, properties ON node_revisions
  FOR EACH ROW EXECUTE FUNCTION node_revisions_record_bytes();
