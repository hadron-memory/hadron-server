-- #5212 (cor:api:010:02, "The merge record is the only proof of a merge"): the one writer of `user_merges`, as an owner-owned
-- SECURITY DEFINER function, so a bare row pairing two live users cannot be forged by a session that only holds DML on the table.
-- Four triggers accept a `user_merges` row as proof (credit-ledger-invariants.sql, grant-invariants.sql,
-- content-validation-report-invariants.sql, and ai-model-price-invariants.sql when #5208 lands); this one change covers them all.
-- One source, shared verbatim with migration 20261126070000_user_merge_record_function (pinned by
-- src/test/migrations/userMergeRecord5212.test.ts), applied by post-push.sql and the test globalSetup.
--
-- It writes the row only under the conditions the merge itself creates in the calling transaction, so it is the merge's own step
-- and not a general insert door:
--   * source and target are two different users, both live (not soft-deleted);
--   * the target has not itself been merged away (it is not the source of a row; the primary key already refuses a second
--     merge of the same source);
--   * the consent proof it is given was consumed IN THIS TRANSACTION (the consent row's xmin is the current transaction's id)
--     for exactly this source and target. Every merge consumes one (consumeUserMergeConsent refuses without it).
-- On success it inserts the row and soft-deletes the source (deleted_at, deleted_by = merged_by), so a forged proof can only be
-- made by merging a live user away, which is visible and is no more than the application's own merge power. Any refusal raises and
-- writes nothing. It cannot stop a COMPLETE merge by a compromised serve credential; the contract step (REVOKE INSERT, UPDATE,
-- DELETE on user_merges from the serve role, and the verifier rule) is a separate change, after every running image calls this.
-- Schema-qualified and search_path-pinned on purpose: an unqualified name would resolve to a session TEMP table first (TEMP is
-- granted to PUBLIC), the SEC10 finding of #5083.
CREATE OR REPLACE FUNCTION public.hadron_record_user_merge(
  p_source text, p_target text, p_merged_by text, p_consent_hash text, p_consent_receipt jsonb
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_source IS NULL OR p_target IS NULL OR p_source = p_target THEN
    RAISE EXCEPTION 'user merge record refused: source and target must be two different users';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_source AND u.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'user merge record refused: the source is missing or already retired';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_target AND u.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'user merge record refused: the target is missing or retired';
  END IF;
  IF EXISTS (SELECT 1 FROM public.user_merges m WHERE m.source_user_id = p_target) THEN
    RAISE EXCEPTION 'user merge record refused: the target was itself merged away';
  END IF;
  IF p_consent_hash IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.user_merge_consents c
     WHERE c.proof_hash = p_consent_hash AND c.source_user_id = p_source AND c.target_user_id = p_target
       AND c.consumed_at IS NOT NULL AND c.xmin = pg_current_xact_id()::xid
  ) THEN
    RAISE EXCEPTION 'user merge record refused: no consent consumed by this transaction for this source and target';
  END IF;
  INSERT INTO public.user_merges (source_user_id, target_user_id, merged_by, consent_hash, consent_receipt)
  VALUES (p_source, p_target, p_merged_by, p_consent_hash, p_consent_receipt);
  UPDATE public.users
     SET deleted_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'), deleted_by = p_merged_by,
         updated_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'), updated_by = p_merged_by
   WHERE id = p_source;
  RETURN true;
END $$;
-- Callable only by the owner and the serve role: never PUBLIC (functions are executable by PUBLIC by default). The serve role's
-- permanent grant is in runtime-role.sql; this one covers a deployment that already has the default `hadron_app` role.
REVOKE ALL ON FUNCTION public.hadron_record_user_merge(text, text, text, text, jsonb) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hadron_app') THEN
    GRANT EXECUTE ON FUNCTION public.hadron_record_user_merge(text, text, text, text, jsonb) TO hadron_app;
  END IF;
END $$;
