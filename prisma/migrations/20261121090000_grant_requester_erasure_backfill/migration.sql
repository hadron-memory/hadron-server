-- #3852 (follow-on to #3813 / 20261110010300_grant_requester_erasure): clear the requester link on grants whose requester
-- was erased BEFORE the forward path (deleteUser.ts) existed. Ruling 0265 / cor:acl:140:08: an erased requester's link is
-- dead and goes; the grant, its state and its reason stay. The requester is not in the signed terms (cor:acl:140:09), and
-- the column is outside grant_signing_stale's column list, so signatures keep verifying and no open signing request ends.
--
-- Cleared: a requester id with NO users row, and one whose users row is soft-deleted as an account erasure
-- (cor:aut:020:03). Never cleared: a live requester, and an ACCOUNT-MERGE SOURCE (user_merges.source_user_id,
-- cor:api:010:02), which is a person who still exists as the merge target; its link follows the merge
-- (hadron_grant_link_merged), it is not dead. Mergers have moved this column since S1a, so none is expected; if any grant
-- still names one, the migration refuses with SQLSTATE HDPRF (#3770: boot marks it rolled back and serves on) and, being
-- one statement, writes nothing. The refusal is judged AFTER the update, so an update that ever reached a merge source
-- could not hide it. The message carries a count only.
--
-- Only requested_by_user_id is written, through the erased-requester arm the #3813 guard already admits; no trigger is
-- disabled, and updated_at is left as it was (as the forward path leaves it). Idempotent: a second run matches no row.
--
-- prod-preflight: required. A count-only read-only production preflight (no-row ids, erasure soft-deletes, merge sources,
-- reported separately) under its own register grant, read before the deploy that applies this (gate, #3852).
-- expand-safe: the previous image runs against this schema (a data change to a nullable column only; the previous image
-- reads requested_by_user_id as string | null everywhere and its #3847 forward path already writes null).
DO $$
DECLARE
  merge_sources integer;
BEGIN
  UPDATE grants AS g
     SET requested_by_user_id = NULL
   WHERE g.requested_by_user_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = g.requested_by_user_id AND u.deleted_at IS NULL)
     AND NOT EXISTS (SELECT 1 FROM user_merges m WHERE m.source_user_id = g.requested_by_user_id);

  SELECT count(*) INTO merge_sources
    FROM grants g
   WHERE g.requested_by_user_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM user_merges m WHERE m.source_user_id = g.requested_by_user_id);
  IF merge_sources > 0 THEN
    RAISE EXCEPTION '#3852: % grant(s) name an account-merge source as requester; nothing was cleared', merge_sources
      USING ERRCODE = 'HDPRF';
  END IF;
END $$;
