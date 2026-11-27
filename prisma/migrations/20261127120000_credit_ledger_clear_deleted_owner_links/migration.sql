-- #5352 (hrn:node:hadronmemory.com:specs:cor:dmo:170:08, Edge case "An entry is never written for a deleted owner", Decided,
-- Holger 2026-11-27: "entries from before are cleaned by migration"): remove the owner link from every credit ledger entry that
-- still names a deleted owner. #5340 made the two deletion writers clear the link in the deleting transaction, but entries of
-- an organization or a person deleted BEFORE that deploy still name them; nothing else ever clears them.
--
-- ONE UPDATE, and only the owner columns change: the append-only trigger (prisma/credit-ledger-invariants.sql, #5238) admits
-- organization_id -> NULL only for an organization with no live row, and owner_user_id -> NULL only for a person with no live
-- row, which is exactly what the WHERE selects; an unchanged column passes. Every other column (amount, kind, source, times,
-- updated_at) stays as written, so no entry is re-authored and no balance figure moves for any LIVE owner.
--
-- A person merged into another (a user_merges row names them as the source) is NOT cleared: their row is soft-deleted by the
-- merge, but #5014's repoint (src/lib/metering/repointMergedOwners.ts) moves such an entry to the survivor; clearing it would
-- take it off the survivor's ledger for good.
--
-- Expected rows: the entries of organizations and persons soft-deleted before #5340's deploy (c228e939); zero on a database
-- where none exist (a fresh one, and every run after the first). Idempotent: a re-run finds no row naming a deleted owner and
-- changes nothing. No table rewrite and no row can fail the trigger, so there is no preflight and no HDPRF refusal.
-- Production: deploying this migration needs its own register grant (the standing production-database rule); the gate does not
-- authorize it.
UPDATE credit_ledger_entries e
   SET organization_id = CASE WHEN e.organization_id IS NOT NULL AND NOT EXISTS (
                                     SELECT 1 FROM organizations o WHERE o.id = e.organization_id AND o.deleted_at IS NULL)
                              THEN NULL ELSE e.organization_id END,
       owner_user_id = CASE WHEN e.owner_user_id IS NOT NULL
                                 AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = e.owner_user_id AND u.deleted_at IS NULL)
                                 AND NOT EXISTS (SELECT 1 FROM user_merges m WHERE m.source_user_id = e.owner_user_id)
                            THEN NULL ELSE e.owner_user_id END
 WHERE (e.organization_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = e.organization_id AND o.deleted_at IS NULL))
    OR (e.owner_user_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = e.owner_user_id AND u.deleted_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM user_merges m WHERE m.source_user_id = e.owner_user_id));
