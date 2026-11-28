-- #5010 (billing A12, cor:dmo:170:08): the credit ledger is append-only. Expand-safe: the previous image only inserts into
-- credit_ledger_entries (the merge re-points are the trigger's own exception) and no product path hard-deletes an organization.

-- Preflight: soft delete is retired, so a soft-deleted entry has to be settled by hand first (clear the mark; offset a mistaken
-- entry with an adjustment). Refuses with HDPRF: boot then serves the schema that exists and logs db.migration.refused_preflight.
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM credit_ledger_entries WHERE deleted_at IS NOT NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'credit_ledger_entries: % entry(ies) are soft-deleted; settle them before this migration', n
      USING ERRCODE = 'HDPRF',
            DETAIL = 'count of rows with deleted_at set: ' || n,
            HINT = 'Clear the mark by hand, and offset a mistaken entry with an adjustment entry (cor:dmo:170:08).';
  END IF;
END $$;

-- The owner relation no longer cascades: a hard delete of an organization that has entries is refused.
ALTER TABLE "credit_ledger_entries" DROP CONSTRAINT "credit_ledger_entries_organization_id_fkey";
ALTER TABLE "credit_ledger_entries" ADD CONSTRAINT "credit_ledger_entries_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- #5010 (billing A12, hrn:node:hadronmemory.com:specs:cor:dmo:170:08): a credit ledger entry is never edited and never deleted,
-- not even by an operator; a correction is a new entry. One source, shared verbatim with migration
-- 20261125130000_credit_ledger_append_only (pinned by src/test/migrations/creditLedgerAppendOnly5010.test.ts), applied by
-- post-push.sql and the test globalSetup.
--
-- DELETE: always refused (the owner relation is ON DELETE RESTRICT, so the owner can never be gone first).
-- UPDATE: refused unless only these change, and each only as follows:
--   * organization_id: may stay or become NULL. Any other value is refused. (The column is still NOT NULL here; A6 / #5014 makes
--     it nullable and pins the success case. The link to a deleted owner is an open ruling, plan section 13 item 18: neither
--     reading is built here.)
--   * created_by, updated_by, deleted_by: may move only from a user to the user it was merged into, along a user_merges row
--     (mergeUsers writes it before it re-points).
-- Every other column (id, kind, amount, expiry, source, note, created_at, updated_at, deleted_at...) is frozen, and so is any
-- column a later slice adds until that slice exempts it on purpose (A6's owner_user_id).
-- Soft delete is retired for this table: a CHECK refuses an entry that carries deleted_at.
-- TRUNCATE fires no row trigger; it is the TEST-ONLY cleanup path (src/test/helpers.ts cleanDb).
ALTER TABLE credit_ledger_entries DROP CONSTRAINT IF EXISTS chk_credit_ledger_not_soft_deleted;
ALTER TABLE credit_ledger_entries ADD CONSTRAINT chk_credit_ledger_not_soft_deleted CHECK (deleted_at IS NULL);
-- Schema-qualified on purpose: an unqualified name would resolve to a session TEMP table of the same name first (TEMP is
-- granted to PUBLIC), letting a DML-only role forge the merge proof (SEC10, #5083).
CREATE OR REPLACE FUNCTION hadron_credit_ledger_user_merged(old_id text, new_id text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT old_id IS NOT NULL AND new_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.user_merges m WHERE m.source_user_id = old_id AND m.target_user_id = new_id)
$$;
CREATE OR REPLACE FUNCTION hadron_credit_ledger_entries_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Credit ledger entries are append-only' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['organization_id', 'created_by', 'updated_by', 'deleted_by'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['organization_id', 'created_by', 'updated_by', 'deleted_by'])
     OR (NEW.organization_id IS DISTINCT FROM OLD.organization_id AND NEW.organization_id IS NOT NULL)
     OR (NEW.created_by IS DISTINCT FROM OLD.created_by AND NOT hadron_credit_ledger_user_merged(OLD.created_by, NEW.created_by))
     OR (NEW.updated_by IS DISTINCT FROM OLD.updated_by AND NOT hadron_credit_ledger_user_merged(OLD.updated_by, NEW.updated_by))
     OR (NEW.deleted_by IS DISTINCT FROM OLD.deleted_by AND NOT hadron_credit_ledger_user_merged(OLD.deleted_by, NEW.deleted_by)) THEN
    RAISE EXCEPTION 'Credit ledger entries are append-only' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS credit_ledger_entries_append_only ON credit_ledger_entries;
CREATE TRIGGER credit_ledger_entries_append_only BEFORE UPDATE OR DELETE ON credit_ledger_entries
FOR EACH ROW EXECUTE FUNCTION hadron_credit_ledger_entries_append_only();
