-- #5014 (billing A6, hrn:node:hadronmemory.com:specs:cor:dmo:170:01): a person has a credit ledger. An entry names an
-- organization or a person; the owner is one of two columns, never both (chk_credit_ledger_one_owner, in the shared file below).
-- Expand-safe and additive: one nullable column, one index, one restrict FK, one CHECK every existing row satisfies (each has an
-- organization and no person), and organization_id loses NOT NULL. Existing rows are untouched, so there is no preflight and no
-- HDPRF refusal. The previous image only writes organization_id, which this migration leaves valid.
-- Index build: credit_ledger_entries gains a row per grant or adjustment and, only while BILLING_DEBIT_ENABLED is on (off in
-- production), per metered hop, so the table is small; a plain CREATE INDEX holds its write lock for well under a second.

ALTER TABLE "credit_ledger_entries" ALTER COLUMN "organization_id" DROP NOT NULL;
ALTER TABLE "credit_ledger_entries" ADD COLUMN "owner_user_id" TEXT;
CREATE INDEX "credit_ledger_entries_owner_user_id_created_at_idx" ON "credit_ledger_entries"("owner_user_id", "created_at");
ALTER TABLE "credit_ledger_entries" ADD CONSTRAINT "credit_ledger_entries_owner_user_id_fkey"
  FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- #5010 (billing A12, hrn:node:hadronmemory.com:specs:cor:dmo:170:08): a credit ledger entry is never edited and never deleted,
-- not even by an operator; a correction is a new entry. One source, shared verbatim with migration
-- 20261125130000_credit_ledger_append_only (pinned by src/test/migrations/creditLedgerAppendOnly5010.test.ts), applied by
-- post-push.sql and the test globalSetup.
--
-- DELETE: always refused (the owner relation is ON DELETE RESTRICT, so the owner can never be gone first).
-- UPDATE: refused unless only these change, and each only as follows:
--   * organization_id: may stay or become NULL. Any other value is refused. (The link to a deleted owner is an open ruling, plan
--     section 13 item 18: neither reading is built here; the trigger only allows the column to be cleared.)
--   * owner_user_id (#5014, A6): may stay or become NULL, or move from a person to the person they were merged into, along a
--     user_merges row (mergeUsers writes it before it re-points). A move to anyone else is refused, so an entry never changes
--     hands outside a merge. Whole-row, an entry also never changes between an organization and a person: the CHECK below
--     keeps exactly one owner, and the two arms together refuse a switch.
--   * created_by, updated_by, deleted_by: may move only from a user to the user it was merged into, along a user_merges row
--     (mergeUsers writes it before it re-points).
-- Every other column (id, kind, amount, expiry, source, note, created_at, updated_at, deleted_at...) is frozen, and so is any
-- column a later slice adds until that slice exempts it on purpose.
-- #5014: an entry names one owner, an organization or a person (hrn:node:hadronmemory.com:specs:cor:dmo:170:01). The CHECK is
-- "at most one", not "exactly one", so the link to a deleted owner may be cleared later (plan section 13 item 18); the library
-- writers refuse an owner naming neither, so a new entry always has one.
-- Soft delete is retired for this table: a CHECK refuses an entry that carries deleted_at.
-- TRUNCATE fires no row trigger; it is the TEST-ONLY cleanup path (src/test/helpers.ts cleanDb).
ALTER TABLE credit_ledger_entries DROP CONSTRAINT IF EXISTS chk_credit_ledger_one_owner;
ALTER TABLE credit_ledger_entries ADD CONSTRAINT chk_credit_ledger_one_owner CHECK (num_nonnulls(organization_id, owner_user_id) <= 1);
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
  IF (to_jsonb(NEW) - ARRAY['organization_id', 'owner_user_id', 'created_by', 'updated_by', 'deleted_by'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['organization_id', 'owner_user_id', 'created_by', 'updated_by', 'deleted_by'])
     OR (NEW.organization_id IS DISTINCT FROM OLD.organization_id AND NEW.organization_id IS NOT NULL)
     OR (NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id AND NEW.owner_user_id IS NOT NULL
         AND NOT hadron_credit_ledger_user_merged(OLD.owner_user_id, NEW.owner_user_id))
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
