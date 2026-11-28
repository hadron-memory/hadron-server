-- #5010 (billing A12, hrn:node:hadronmemory.com:specs:cor:dmo:170:08): a credit ledger entry is never edited and never deleted,
-- not even by an operator; a correction is a new entry. One source: the newest migration that carries this file ends with it
-- verbatim (pin 11 of src/test/migrations/creditLedgerAppendOnly5010.test.ts), and post-push.sql and the test globalSetup apply it.
--
-- DELETE: always refused (the owner relation is ON DELETE RESTRICT, so the owner can never be gone first).
-- UPDATE: refused unless only these change, and each only as follows:
--   * organization_id: may stay, or become NULL only when that organization is deleted (#5238, cor:dmo:170:08: the link to a
--     deleted owner is removed; a live owner's link is never cleared, since the entry would leave every balance). Deleted means
--     no organizations row with deleted_at IS NULL: soft delete, or a row already gone. Any other value is refused.
--   * owner_user_id (#5014, A6): may stay, become NULL only when that person is deleted or erased (#5238, same test on users),
--     or move from a person to the person they were merged into, along a user_merges row (mergeUsers writes it before it
--     re-points). A move to anyone else is refused, so an entry never changes hands outside a merge. Whole-row, an entry
--     also never changes between an organization and a person, and a cleared link never comes back: each arm refuses any
--     non-NULL value other than the one it allows, and the CHECK below keeps at most one owner.
--   * created_by, updated_by, deleted_by: may move only from a user to the user it was merged into, along a user_merges row
--     (mergeUsers writes it before it re-points).
--   The deleted test assumes soft delete is final: no path restores an organization or a person (deleted_at back to NULL).
--   A later restore door must account for it: an entry cleared while its owner was deleted stays ownerless after a restore.
-- Every other column (id, kind, amount, expiry, source, note, created_at, updated_at, deleted_at...) is frozen, and so is any
-- column a later slice adds until that slice exempts it on purpose.
-- #5014: an entry names one owner, an organization or a person (hrn:node:hadronmemory.com:specs:cor:dmo:170:01). The CHECK is
-- "at most one", not "exactly one", so the link to a deleted owner may be cleared (the trigger ties the NULL to the deletion,
-- #5238); the library writers refuse an owner naming neither, so a new entry always has one.
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
-- #5238: true when the owner is gone (no live row), so its link may be cleared. Schema-qualified for the same reason as above.
CREATE OR REPLACE FUNCTION hadron_credit_ledger_org_gone(org_id text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = org_id AND o.deleted_at IS NULL)
$$;
CREATE OR REPLACE FUNCTION hadron_credit_ledger_user_gone(user_id text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = user_id AND u.deleted_at IS NULL)
$$;
CREATE OR REPLACE FUNCTION hadron_credit_ledger_entries_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Credit ledger entries are append-only' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['organization_id', 'owner_user_id', 'created_by', 'updated_by', 'deleted_by'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['organization_id', 'owner_user_id', 'created_by', 'updated_by', 'deleted_by'])
     OR (NEW.organization_id IS DISTINCT FROM OLD.organization_id
         AND (NEW.organization_id IS NOT NULL OR NOT hadron_credit_ledger_org_gone(OLD.organization_id)))
     OR (NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
         AND CASE WHEN NEW.owner_user_id IS NULL THEN NOT hadron_credit_ledger_user_gone(OLD.owner_user_id)
                  ELSE NOT hadron_credit_ledger_user_merged(OLD.owner_user_id, NEW.owner_user_id) END)
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
