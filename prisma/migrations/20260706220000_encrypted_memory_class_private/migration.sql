-- Spec 041 (D-2026-07-06-B) / #516: 'private' is the ONLY encryptable class.
-- The shipped Tier 2.5 SECRET-mode flow provisioned per-user memories as
-- class='personal' and encrypted them (grandfathered by PR #514). Migrate any
-- such rows to class='private' so the platform has ONE answer to "which classes
-- encrypt?". personal rows already carry user_id (chk_personal_visibility_user),
-- and Tier 2.5 rows also carry app_id + user_memory_of_agent_id, so the flip
-- keeps chk_memory_class_app_id / chk_memory_personal_agent_id satisfied.
UPDATE "memories"
   SET "class" = 'private'
 WHERE "class" = 'personal'
   AND "is_encrypted" = true;

-- Defensive assert: after the flip, no non-private class may hold encrypted
-- content. If one does (e.g. an unexpected pre-#516 anon class='app' promotion
-- with a NULL owner that can't be safely reclassified here), fail the deploy
-- loudly rather than silently leave a row that violates the new single rule.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "memories"
     WHERE "is_encrypted" = true AND "class" <> 'private'
  ) THEN
    RAISE EXCEPTION
      'Encrypted memories exist with class <> private (spec 041/#516); resolve manually before deploy';
  END IF;
END $$;
