-- #1632 S2b-2 (cor:dmo:130:08): the signing ceremony's SIGN purpose may bind a user (the person the proof ceremony
-- proved), once, with no registration field. Same constraint as before plus one branch.
ALTER TABLE "passkey_ceremonies" DROP CONSTRAINT IF EXISTS "chk_passkey_ceremony_registration";
ALTER TABLE "passkey_ceremonies" ADD CONSTRAINT "chk_passkey_ceremony_registration" CHECK (
  ("user_id" IS NULL AND "kind" IS NULL AND "registration_method" IS NULL AND "sign_in_browser_hash" IS NULL
    AND "vouch_passkey_id" IS NULL AND "user_handle" IS NULL)
  OR ("purpose" = 'REGISTER' AND "user_id" IS NOT NULL AND "user_handle" IS NOT NULL AND octet_length("user_handle") = 32
    AND (("kind" IS NOT NULL AND "kind" = 'first' AND "registration_method" IS NOT NULL
          AND "registration_method" IN ('github', 'google', 'apple', 'email')
          AND "sign_in_browser_hash" IS NOT NULL AND "sign_in_browser_hash" ~ '^[0-9a-f]{64}$' AND "vouch_passkey_id" IS NULL)
      OR ("kind" IS NOT NULL AND "kind" = 'later' AND "vouch_passkey_id" IS NOT NULL
          AND "registration_method" IS NULL AND "sign_in_browser_hash" IS NULL)))
  -- #1631 PR3 (cor:aut:040:08): a REVOKE ceremony is bound to its owner by the proof: another passkey's assertion
  -- (the prover, never revocable by its own ceremony) or this browser's fresh identity-provider sign-in, never a
  -- magic link. It carries no WebAuthn user handle.
  OR ("purpose" = 'REVOKE' AND "user_id" IS NOT NULL AND "kind" IS NOT NULL AND "kind" = 'revoke' AND "user_handle" IS NULL
    AND (("vouch_passkey_id" IS NOT NULL AND "registration_method" IS NULL AND "sign_in_browser_hash" IS NULL)
      OR ("vouch_passkey_id" IS NULL AND "registration_method" IS NOT NULL AND "registration_method" IN ('github', 'google', 'apple')
        AND "sign_in_browser_hash" IS NOT NULL AND "sign_in_browser_hash" ~ '^[0-9a-f]{64}$')))
  -- #1632 S2b-2 (cor:dmo:130:08): a SIGN ceremony is bound to the person the proof ceremony proved, set once. It
  -- carries no registration field. The proof ceremony itself (SIGN_PROOF) is never bound: it is spent proving.
  OR ("purpose" = 'SIGN' AND "user_id" IS NOT NULL AND "kind" IS NOT NULL AND "kind" = 'sign' AND "registration_method" IS NULL
    AND "sign_in_browser_hash" IS NULL AND "vouch_passkey_id" IS NULL AND "user_handle" IS NULL)
);
