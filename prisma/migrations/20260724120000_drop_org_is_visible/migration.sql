-- Spec 048 Phase D: retire the `Organization.isVisible` listing-visibility flag.
--
-- `isVisible` only ever distinguished the auto-personal ("shadow") org
-- (`false`/`null`) from a real, activated org (`true`). Spec 048 retires the
-- personal org entirely (the Phase B admin migration re-homes + deletes them),
-- so every remaining org is listable and the column is vestigial. Non-member /
-- public discovery is governed solely by `listed_on_marketplace` + public
-- resources.
--
-- HARD SAFETY GATE (PR #771 review, Codex P1). The Phase B retirement is
-- refuse-and-report: it SKIPS any org it can't prove is a clean scaffold (a
-- side-data row, a createdBy mismatch, …), leaving those as live
-- `is_visible = false/null` rows. Dropping the column while any remain would
-- silently expose their full Organization surface the moment this deploy removes
-- the isVisible listing/search/ref gates. So refuse the drop while any LIVE
-- non-visible org exists — the operator must retire it
-- (`pnpm admin:retire-personal-orgs --apply`) or activate it (`is_visible=true`)
-- first. Soft-deleted orgs are already invisible to every gate, so they don't
-- count.
DO $$
DECLARE
  remaining bigint;
BEGIN
  SELECT count(*) INTO remaining
  FROM organizations
  WHERE is_visible IS DISTINCT FROM true
    AND deleted_at IS NULL;
  IF remaining > 0 THEN
    RAISE EXCEPTION
      'Refusing to drop organizations.is_visible: % live non-visible org(s) remain. Retire them (pnpm admin:retire-personal-orgs --apply) or set is_visible=true before this migration.',
      remaining;
  END IF;
END $$;

ALTER TABLE "organizations" DROP COLUMN IF EXISTS "is_visible";
