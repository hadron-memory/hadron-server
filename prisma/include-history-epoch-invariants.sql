-- #2046 S9-3: the include-history AUTHORITY EPOCH. One source, shared verbatim with migration
-- 20261022040000_include_history_epoch (pinned by src/lib/includes/epochSchema2046.test.ts).
--
-- Every transaction that takes the include-history fence increments this one row in the same
-- transaction, before any caller work. A SERIALIZABLE account operation runs the same UPDATE right after it
-- takes the fence: if a fence holder committed after its snapshot, PostgreSQL refuses the stale UPDATE with
-- 40001 and the whole attempt retries. The row is therefore monotone, singleton and never reset.
CREATE TABLE IF NOT EXISTS include_history_epoch (
  id integer PRIMARY KEY,
  n bigint NOT NULL
);
ALTER TABLE include_history_epoch DROP CONSTRAINT IF EXISTS chk_include_history_epoch_shape;
ALTER TABLE include_history_epoch ADD CONSTRAINT chk_include_history_epoch_shape CHECK (id = 1 AND n >= 0);

-- Seeded before any holder exists; never overwritten (an existing nonzero value survives a re-run).
INSERT INTO include_history_epoch (id, n) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;

-- Only "+1 on the same row" is admitted: no reset, skip, decrease or identity change. bigint overflow raises
-- (numeric_value_out_of_range) before the trigger, so the epoch fails closed rather than wrapping.
CREATE OR REPLACE FUNCTION hadron_guard_include_history_epoch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.n IS DISTINCT FROM OLD.n + 1 THEN
      RAISE EXCEPTION 'include_history_epoch only advances by exactly one' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'include_history_epoch is never deleted or truncated' USING ERRCODE = '23514';
END $$;
DROP TRIGGER IF EXISTS include_history_epoch_guard_row ON include_history_epoch;
CREATE TRIGGER include_history_epoch_guard_row
  BEFORE UPDATE OR DELETE ON include_history_epoch
  FOR EACH ROW EXECUTE FUNCTION hadron_guard_include_history_epoch();
DROP TRIGGER IF EXISTS include_history_epoch_guard_truncate ON include_history_epoch;
CREATE TRIGGER include_history_epoch_guard_truncate
  BEFORE TRUNCATE ON include_history_epoch
  FOR EACH STATEMENT EXECUTE FUNCTION hadron_guard_include_history_epoch();
