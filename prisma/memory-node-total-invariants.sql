-- #5078 (Billing A7d): how many live nodes each memory holds, kept by triggers on nodes, so ONE mechanism covers every writer.
-- Prisma can model neither the functions nor the triggers. One source, shared verbatim with migration
-- 20261124210000_memory_node_totals (pinned by a test). Idempotent.
--
-- A write inserts its change into memory_node_pending and nothing else; a DEFERRED constraint trigger folds the
-- transaction's own rows into memory_node_totals at COMMIT, in memory_id order. Locking the total in the write itself would
-- hold it while the transaction goes on to take other locks, and a door that writes a node and then locks a row would
-- deadlock with one that locks the row and then writes a node in the same memory.
-- A figure is always totals + pending, so it also counts the reader's own uncommitted writes.

CREATE OR REPLACE FUNCTION hadron_memory_node_total_after_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.memory_node_pending (id, tx_id, memory_id, delta)
  SELECT gen_random_uuid()::text, pg_current_xact_id()::text::bigint, n.memory_id, count(*)
  FROM new_rows n WHERE n.deleted_at IS NULL GROUP BY n.memory_id;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION hadron_memory_node_total_after_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.memory_node_pending (id, tx_id, memory_id, delta)
  SELECT gen_random_uuid()::text, pg_current_xact_id()::text::bigint, o.memory_id, -count(*)
  FROM old_rows o WHERE o.deleted_at IS NULL GROUP BY o.memory_id;
  RETURN NULL;
END $$;

-- Per row: Postgres allows no transition tables on an UPDATE trigger with a column list, and without the list every node
-- edit would be copied, content included.
CREATE OR REPLACE FUNCTION hadron_memory_node_total_after_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.memory_node_pending (id, tx_id, memory_id, delta)
  SELECT gen_random_uuid()::text, pg_current_xact_id()::text::bigint, d.memory_id, d.delta
  FROM (VALUES (OLD.memory_id, -1, OLD.deleted_at), (NEW.memory_id, 1, NEW.deleted_at)) AS d(memory_id, delta, deleted_at)
  WHERE d.deleted_at IS NULL;
  RETURN NULL;
END $$;

-- TRUNCATE holds nodes exclusively, so no other transaction has anything pending.
CREATE OR REPLACE FUNCTION hadron_memory_node_total_after_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM public.memory_node_pending;
  UPDATE public.memory_node_totals SET live_nodes = 0;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION hadron_memory_node_total_fold() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE d record;
BEGIN
  -- One event per pending row; the first one folds them all, the rest find their row gone.
  PERFORM 1 FROM public.memory_node_pending WHERE id = NEW.id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  FOR d IN
    WITH mine AS (
      DELETE FROM public.memory_node_pending WHERE tx_id = NEW.tx_id RETURNING memory_id, delta
    )
    SELECT memory_id, sum(delta)::bigint AS delta FROM mine GROUP BY memory_id HAVING sum(delta) <> 0 ORDER BY memory_id
  LOOP
    UPDATE public.memory_node_totals SET live_nodes = live_nodes + d.delta WHERE memory_id = d.memory_id;
    IF NOT FOUND THEN
      -- The memory's first node, or a memory deleted in this transaction (its total is gone and must stay gone).
      INSERT INTO public.memory_node_totals (memory_id, live_nodes)
      SELECT m.id, d.delta FROM public.memories m WHERE m.id = d.memory_id
      ON CONFLICT (memory_id) DO UPDATE SET live_nodes = memory_node_totals.live_nodes + EXCLUDED.live_nodes;
    END IF;
  END LOOP;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS memory_node_total_insert ON nodes;
CREATE TRIGGER memory_node_total_insert AFTER INSERT ON nodes
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION hadron_memory_node_total_after_insert();

DROP TRIGGER IF EXISTS memory_node_total_delete ON nodes;
CREATE TRIGGER memory_node_total_delete AFTER DELETE ON nodes
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION hadron_memory_node_total_after_delete();

DROP TRIGGER IF EXISTS memory_node_total_update ON nodes;
CREATE TRIGGER memory_node_total_update AFTER UPDATE OF deleted_at, memory_id ON nodes
  FOR EACH ROW WHEN ((OLD.deleted_at IS NULL) IS DISTINCT FROM (NEW.deleted_at IS NULL) OR OLD.memory_id IS DISTINCT FROM NEW.memory_id)
  EXECUTE FUNCTION hadron_memory_node_total_after_update();

DROP TRIGGER IF EXISTS memory_node_total_truncate ON nodes;
CREATE TRIGGER memory_node_total_truncate AFTER TRUNCATE ON nodes
  FOR EACH STATEMENT EXECUTE FUNCTION hadron_memory_node_total_after_truncate();

DROP TRIGGER IF EXISTS memory_node_pending_fold ON memory_node_pending;
CREATE CONSTRAINT TRIGGER memory_node_pending_fold AFTER INSERT ON memory_node_pending
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hadron_memory_node_total_fold();
