-- #5021 (billing A16, cor:dmo:170:06): price rows are kept. Expand-safe: the previous image only inserts price rows and
-- re-points their audit user ids along a recorded merge (the trigger's own exception); no shipped code updates or
-- deletes one. Applied LAST of #5021's migrations on purpose: if this one refuses, boot serves the schema that exists,
-- and the columns 20261126080000 added are already there for recordLlmUsage to write.

-- Preflight: a soft-deleted price row is already a violation of the rule (a row is never retired), and the lookup
-- skips it, so it has to be settled by hand before rows are frozen. Refuses with HDPRF: boot then serves the schema
-- that exists and logs db.migration.refused_preflight. The message carries a count only: no id, model or price.
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM ai_model_prices WHERE deleted_at IS NOT NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'ai_model_prices: % row(s) are soft-deleted; settle them before this migration', n
      USING ERRCODE = 'HDPRF',
            DETAIL = 'count of rows with deleted_at set: ' || n,
            HINT = 'Decide with the platform owner whether each row is restored (clear the mark by hand) before rows are frozen (cor:dmo:170:06).';
  END IF;
END $$;

-- #5021 (billing A16, hrn:node:hadronmemory.com:specs:cor:dmo:170:06): price rows are kept. A row a recorded cost came
-- from is never edited or deleted, and price rows are "effective-dated and kept", so no row is changed or deleted, not
-- even one nothing references and not even by an operator; a new price is a new row. One source, shared verbatim with
-- migration 20261126080400_ai_model_prices_kept (pinned by src/test/migrations/priceRowKept5021.test.ts), applied by
-- post-push.sql and the test globalSetup.
--
-- DELETE: always refused.
-- UPDATE: refused unless only these change, and each only as follows:
--   * created_by, updated_by, deleted_by: may move only from a user to the user it was merged into, along a user_merges
--     row (mergeUsers writes it before it re-points; gate ruling 3, the same answer as the credit ledger's).
-- Every other column (id, provider, model, tier, both prices, the markup, effective_at, created_at, updated_at,
-- deleted_at) is frozen, and so is any column a later slice adds until that slice exempts it on purpose.
-- TRUNCATE fires no row trigger; it is the TEST-ONLY cleanup path (src/test/helpers.ts cleanDb).
-- Schema-qualified on purpose: an unqualified name would resolve to a session TEMP table of the same name first (TEMP is
-- granted to PUBLIC), letting a DML-only role forge the merge proof (as #5083's SEC10 found for the ledger).
CREATE OR REPLACE FUNCTION hadron_ai_model_price_user_merged(old_id text, new_id text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT old_id IS NOT NULL AND new_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.user_merges m WHERE m.source_user_id = old_id AND m.target_user_id = new_id)
$$;
CREATE OR REPLACE FUNCTION hadron_ai_model_prices_kept() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Price rows are kept: a price row is never deleted' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['created_by', 'updated_by', 'deleted_by'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['created_by', 'updated_by', 'deleted_by'])
     OR (NEW.created_by IS DISTINCT FROM OLD.created_by AND NOT hadron_ai_model_price_user_merged(OLD.created_by, NEW.created_by))
     OR (NEW.updated_by IS DISTINCT FROM OLD.updated_by AND NOT hadron_ai_model_price_user_merged(OLD.updated_by, NEW.updated_by))
     OR (NEW.deleted_by IS DISTINCT FROM OLD.deleted_by AND NOT hadron_ai_model_price_user_merged(OLD.deleted_by, NEW.deleted_by)) THEN
    RAISE EXCEPTION 'Price rows are kept: a price row is never changed; a new price is a new row' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS ai_model_prices_kept ON ai_model_prices;
CREATE TRIGGER ai_model_prices_kept BEFORE UPDATE OR DELETE ON ai_model_prices
FOR EACH ROW EXECUTE FUNCTION hadron_ai_model_prices_kept();
