-- #5213 (billing A16 follow-up, cor:dmo:170:06): the database refuses a price row dated in the past (the trigger gains
-- BEFORE INSERT). Expand-safe: CREATE OR REPLACE of the function and a re-created trigger, no data check (so no HDPRF);
-- the previous image's setAiModelPrice inserts at its app now + 60 s or later and passes during a rollout and after a
-- rollback. Only a database clock more than the mutation's lead ahead of the app's refuses a default insert, and then
-- writes nothing. Shared verbatim with prisma/ai-model-price-invariants.sql (pinned by priceRowKept5021.test.ts).

-- #5021 (billing A16, hrn:node:hadronmemory.com:specs:cor:dmo:170:06): price rows are kept. A row a recorded cost came
-- from is never edited or deleted, and price rows are "effective-dated and kept", so no row is changed or deleted, not
-- even one nothing references and not even by an operator; a new price is a new row. One source, shared verbatim with
-- migration 20261126080400_ai_model_prices_kept (pinned by src/test/migrations/priceRowKept5021.test.ts), applied by
-- post-push.sql and the test globalSetup.
--
-- INSERT (#5213, cor:dmo:170:06): a row dated in the past is refused (23514). effective_at is TIMESTAMP(3) without time zone
--   and holds UTC, so it is compared with clock_timestamp() AT TIME ZONE 'UTC', never a bare clock_timestamp() (which follows
--   the session's TimeZone). The database guards the Decided rule only; the 60 s lead stays in the setAiModelPrice mutation
--   (PRICE_CACHE_TTL_MS), restated nowhere here. The one opt-out is for the OWNER role (the migrating role, and the single
--   role of local dev and tests): SET LOCAL hadron.allow_past_price_row = 'on' inside a transaction. A setting any role can
--   set is not a gate, so the trigger honours it only when current_user owns ai_model_prices; the serve role never does.
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
  IF TG_OP = 'INSERT' THEN
    IF NEW.effective_at < (clock_timestamp() AT TIME ZONE 'UTC')
       AND NOT (coalesce(current_setting('hadron.allow_past_price_row', true), '') = 'on'
                AND current_user::text = (SELECT pg_catalog.pg_get_userbyid(c.relowner)::text FROM pg_catalog.pg_class c
                                          WHERE c.oid = 'public.ai_model_prices'::pg_catalog.regclass)) THEN
      RAISE EXCEPTION 'Price rows are never dated in the past: a new price takes effect from now on' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
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
CREATE TRIGGER ai_model_prices_kept BEFORE INSERT OR UPDATE OR DELETE ON ai_model_prices
FOR EACH ROW EXECUTE FUNCTION hadron_ai_model_prices_kept();
