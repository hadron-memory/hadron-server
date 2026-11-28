-- #5001 (cor:acl:140:07, :09; ruling 0255 item 19): one passkey touch over a selection of one App's pending grants. Additive: two new
-- tables, two nullable columns, widened CHECKs and ceremony purposes, replaced trigger functions (now with a pinned search path).
-- Every existing request has no selection and the one-grant payload version, every existing signature the same, so no row can
-- refuse. The tail is a byte-identical copy of prisma/grant-signing-invariants.sql, prisma/passkey-registration-invariants.sql and,
-- last, prisma/grant-selection-signing-invariants.sql (pinned by src/lib/signing/grantSelection5001.test.ts).

-- CreateTable
CREATE TABLE "grant_signing_selections" (
    "id" TEXT NOT NULL,
    "app_id" TEXT NOT NULL,
    "payload_version" TEXT NOT NULL,
    "requester_user_id" TEXT,
    "requester_app_id" TEXT,
    "requester_worker_id" TEXT,
    "requester_session_id" TEXT,
    "state" TEXT NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT (clock_timestamp() AT TIME ZONE 'UTC'::text),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "last_refused_at" TIMESTAMP(3),

    CONSTRAINT "grant_signing_selections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grant_selection_signatures" (
    "id" TEXT NOT NULL,
    "selection_id" TEXT NOT NULL,
    "signer_id" TEXT NOT NULL,
    "passkey_credential_id" TEXT NOT NULL,
    "payload_version" TEXT NOT NULL,
    "items" JSONB NOT NULL,
    "rp_id" TEXT NOT NULL,
    "authenticator_data" BYTEA NOT NULL,
    "client_data_json" BYTEA NOT NULL,
    "signature" BYTEA NOT NULL,
    "verified_at" TIMESTAMP(3) NOT NULL DEFAULT (clock_timestamp() AT TIME ZONE 'UTC'::text),

    CONSTRAINT "grant_selection_signatures_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "grant_signing_requests" ADD COLUMN "selection_id" TEXT,
ADD COLUMN "position_in_selection" INTEGER;

-- AlterTable
ALTER TABLE "grant_signatures" ADD COLUMN "selection_signature_id" TEXT;

-- CreateIndex
CREATE INDEX "grant_signing_selections_app_id_created_at_idx" ON "grant_signing_selections"("app_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "grant_selection_signatures_selection_id_key" ON "grant_selection_signatures"("selection_id");

-- CreateIndex
CREATE UNIQUE INDEX "grant_signing_requests_selection_id_grant_id_key" ON "grant_signing_requests"("selection_id", "grant_id");

-- CreateIndex
CREATE INDEX "grant_signing_requests_selection_id_idx" ON "grant_signing_requests"("selection_id");

-- AddForeignKey
ALTER TABLE "grant_signing_selections" ADD CONSTRAINT "grant_signing_selections_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "grant_selection_signatures" ADD CONSTRAINT "grant_selection_signatures_selection_id_fkey" FOREIGN KEY ("selection_id") REFERENCES "grant_signing_selections"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "grant_selection_signatures" ADD CONSTRAINT "grant_selection_signatures_passkey_credential_id_fkey" FOREIGN KEY ("passkey_credential_id") REFERENCES "passkey_credentials"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "grant_signing_requests" ADD CONSTRAINT "grant_signing_requests_selection_id_fkey" FOREIGN KEY ("selection_id") REFERENCES "grant_signing_selections"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "grant_signatures" ADD CONSTRAINT "grant_signatures_selection_signature_id_fkey" FOREIGN KEY ("selection_signature_id") REFERENCES "grant_selection_signatures"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- #3649 slice B (cor:acl:140:07, :09; the node-signing mirror cor:dmo:130:03): grant signing requests and append-only grant
-- signature records. One source of SQL (conventions:append-only-table-trigger): included by post-push.sql and appended
-- byte-identical to the newest migration that carries it, 20261110010200_grant_signing_rebase (slice C; slice B's
-- 20261109200000_grant_signing carried it first; pinned by src/lib/signing/grantSigning3649.test.ts). Every timestamp
-- is the DB clock (hadron_signing_now(), prisma/signing-invariants.sql), so a write queued behind a lock gets a later time than
-- the one it waited for.
--
-- ONE grant per request (gate selection 1). #5001: a request may also be one ITEM of a selection
-- (selection_id and position_in_selection set, payload_version the selection's; prisma/grant-selection-signing-invariants.sql). No signer is named (ruling 0255, item 12). A request
-- begins open on a PENDING grant (never activated, revoked or left by its holder) at the grant's current version, and ends
-- exactly once. A record is inserted only against an open, unexpired request whose pins it repeats, by its signer's own
-- unrevoked passkey, on a grant that is still pending, naming the grant's holder as signed; it is never updated. Both are
-- deleted only with their grant (the ON DELETE CASCADE of the grant's hard delete, which only an App's hard delete allows).
-- TRUNCATE fires no row trigger; it is the TEST-ONLY cleanup path (src/test/helpers.ts cleanDb).

ALTER TABLE grant_signing_requests DROP CONSTRAINT IF EXISTS chk_grant_signing_request_shape;
ALTER TABLE grant_signing_requests ADD CONSTRAINT chk_grant_signing_request_shape CHECK (
  id ~ '^[A-Za-z0-9_-]{22}$'
  AND state IS NOT NULL AND state IN ('open','completed','declined','expired','stale','withdrawn')
  AND terms_hash ~ '^[0-9a-f]{64}$'
  AND payload_version IN ('hadron-grant-signature-v1','hadron-grant-selection-signature-v1')
  -- #5001: the selection version belongs to a selection item and the one-grant version to a request with no selection.
  AND ((selection_id IS NULL) = (payload_version = 'hadron-grant-signature-v1'))
  AND ((selection_id IS NULL) = (position_in_selection IS NULL))
  AND (position_in_selection IS NULL OR position_in_selection >= 0)
  AND version >= 1
  AND (requester_user_id IS NOT NULL OR requester_app_id IS NOT NULL)
  AND (requester_user_id IS NULL OR requester_user_id <> '')
  AND (requester_app_id IS NULL OR requester_app_id <> '')
  AND expires_at > created_at
  AND ((state = 'open') = (ended_at IS NULL))
  AND (ended_at IS NULL OR ended_at >= created_at)
);

ALTER TABLE grant_signatures DROP CONSTRAINT IF EXISTS chk_grant_signature_shape;
ALTER TABLE grant_signatures ADD CONSTRAINT chk_grant_signature_shape CHECK (
  terms_hash ~ '^[0-9a-f]{64}$'
  AND payload_version IN ('hadron-grant-signature-v1','hadron-grant-selection-signature-v1')
  -- #5001: a selection-version record names its touch record; a one-grant record never does.
  AND ((selection_signature_id IS NULL) = (payload_version = 'hadron-grant-signature-v1'))
  AND version >= 1
  AND holder_kind IN ('user','agent','worker','app')
  AND holder_id <> ''
  AND signer_id <> ''
  AND rp_id IS NOT NULL AND rp_id <> ''
  AND octet_length(authenticator_data) >= 37
  -- The assertion was made under the recorded RP ID: its rpIdHash is SHA-256(rp_id).
  AND substring(authenticator_data FROM 1 FOR 32) = sha256(convert_to(rp_id, 'UTF8'))
  AND octet_length(client_data_json) > 0
  AND octet_length(signature) > 0
);

-- Ends every open request of one grant: expired (at its deadline) when its lifetime has already passed, otherwise stale (now).
CREATE OR REPLACE FUNCTION hadron_end_open_grant_signing_requests(p_grant_id text) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE platform_now timestamp(3) := hadron_signing_now();
BEGIN
  UPDATE grant_signing_requests SET state = 'expired'
   WHERE grant_id = p_grant_id AND state = 'open' AND expires_at <= platform_now;
  UPDATE grant_signing_requests SET state = 'stale'
   WHERE grant_id = p_grant_id AND state = 'open';
END $$;

-- Requests: begin open on a pending grant at its version, pinned fields immutable, one end, DB-clock times, deleted only with
-- their grant (the FK cascade fires after the grant row is gone), or with their App: an App's hard delete reaches a request by two
-- cascades (App to grants, App to selections to items), and which fires first is not ours to rely on, so a request or signature whose
-- grant's App is already gone may go too.
CREATE OR REPLACE FUNCTION hadron_guard_grant_signing_request() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  platform_now timestamp(3) := hadron_signing_now();
  lifetime interval;
  sel grant_signing_selections%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM grants gr JOIN apps ap ON ap.id = gr.app_id WHERE gr.id = OLD.grant_id) THEN
      RAISE EXCEPTION 'Grant signing requests are kept for the grant''s lifetime' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state IS DISTINCT FROM 'open' OR NEW.ended_at IS NOT NULL THEN
      RAISE EXCEPTION 'A grant signing request begins open' USING ERRCODE = '23514';
    END IF;
    -- FOR SHARE: a revocation or a holder's departure that updates the grant waits for this insert, and its stale trigger then
    -- sees the request; one that committed first is seen here (the lock re-reads the newest row).
    PERFORM 1 FROM grants g
      WHERE g.id = NEW.grant_id AND g.version = NEW.version
        AND g.activated_at IS NULL AND g.revoked_at IS NULL AND g.holder_departed_at IS NULL
      FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'A grant signing request needs a pending grant at its current version' USING ERRCODE = '23514';
    END IF;
    -- Re-read after the lock: an insert that waited behind a grant writer begins when it actually could, and keeps the
    -- lifetime its inserter asked for (#3649 slice C, NP-2): the deadline moves with the start. The inserter states both times
    -- from ONE clock read (or leaves created_at to its default); the lifetime is their difference, taken before the wait.
    lifetime := NEW.expires_at - NEW.created_at;
    platform_now := hadron_signing_now();
    NEW.created_at := platform_now;
    NEW.expires_at := platform_now + lifetime;
    IF NEW.selection_id IS NOT NULL THEN
      -- #5001: an item belongs to an open selection of the grant's own App and ends at the selection's deadline, so the one
      -- touch and its items expire together. The selection is read after the grant lock (grant, then selection: the lock order).
      SELECT * INTO sel FROM grant_signing_selections WHERE id = NEW.selection_id FOR SHARE;
      IF NOT FOUND OR sel.state <> 'open' OR platform_now >= sel.expires_at
         OR NOT EXISTS (SELECT 1 FROM grants g WHERE g.id = NEW.grant_id AND g.app_id = sel.app_id) THEN
        RAISE EXCEPTION 'A selection item needs an open selection of the grant''s own App' USING ERRCODE = '23514';
      END IF;
      NEW.expires_at := sel.expires_at;
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE
  IF ROW(NEW.id, NEW.grant_id, NEW.version, NEW.terms_hash, NEW.payload_version,
         NEW.requester_user_id, NEW.requester_app_id, NEW.requester_worker_id, NEW.requester_session_id,
         NEW.created_at, NEW.expires_at, NEW.selection_id, NEW.position_in_selection)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.grant_id, OLD.version, OLD.terms_hash, OLD.payload_version,
         OLD.requester_user_id, OLD.requester_app_id, OLD.requester_worker_id, OLD.requester_session_id,
         OLD.created_at, OLD.expires_at, OLD.selection_id, OLD.position_in_selection) THEN
    RAISE EXCEPTION 'A grant signing request''s pinned fields are immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.state <> 'open' THEN
    RAISE EXCEPTION 'A grant signing request ends exactly once' USING ERRCODE = '23514';
  END IF;
  IF NEW.state = 'open' THEN
    IF NEW.ended_at IS NOT NULL THEN
      RAISE EXCEPTION 'An open grant signing request has no end time' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.state = 'expired' THEN
    IF platform_now < OLD.expires_at THEN
      RAISE EXCEPTION 'A grant signing request expires only once its lifetime has passed' USING ERRCODE = '23514';
    END IF;
    NEW.ended_at := OLD.expires_at;
    RETURN NEW;
  END IF;
  IF platform_now >= OLD.expires_at THEN
    -- A system-driven stale end that loses the race with the deadline is, in truth, an expiry at the deadline. A person's end
    -- (withdraw, decline, complete) is refused instead; the caller re-reads and reports the expiry.
    IF NEW.state = 'stale' THEN
      NEW.state := 'expired';
      NEW.ended_at := OLD.expires_at;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'An expired grant signing request cannot end any other way' USING ERRCODE = '23514';
  END IF;
  IF NEW.state = 'completed' AND NOT EXISTS (SELECT 1 FROM grant_signatures WHERE signing_request_id = NEW.id) THEN
    RAISE EXCEPTION 'A grant signing request completes only with its signature record' USING ERRCODE = '23514';
  END IF;
  NEW.ended_at := platform_now;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS grant_signing_request_guard ON grant_signing_requests;
CREATE TRIGGER grant_signing_request_guard BEFORE INSERT OR UPDATE OR DELETE ON grant_signing_requests
FOR EACH ROW EXECUTE FUNCTION hadron_guard_grant_signing_request();

-- Records: insert-only against an open, unexpired request whose pins they repeat, by the signer's own unrevoked passkey, on a
-- grant still pending, naming the grant's holder as it is at signing; never updated; deleted only with their grant.
CREATE OR REPLACE FUNCTION hadron_guard_grant_signature() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  -- Read only after both locks below: a clock sampled before a wait would judge a deadline that passed during it as unpassed.
  platform_now timestamp(3);
  req grant_signing_requests%ROWTYPE;
  g grants%ROWTYPE;
  touch grant_selection_signatures%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM grants gr JOIN apps ap ON ap.id = gr.app_id WHERE gr.id = OLD.grant_id) THEN
      RAISE EXCEPTION 'Grant signature records are never deleted' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Grant signature records are append-only' USING ERRCODE = '23514';
  END IF;
  -- The grant row first, then the request: the lock order every grant signing writer takes.
  SELECT * INTO g FROM grants WHERE id = NEW.grant_id FOR SHARE;
  SELECT * INTO req FROM grant_signing_requests WHERE id = NEW.signing_request_id FOR UPDATE;
  platform_now := hadron_signing_now();
  IF NOT FOUND OR req.state <> 'open' OR platform_now >= req.expires_at THEN
    RAISE EXCEPTION 'A grant signature needs an open signing request' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.grant_id, NEW.version, NEW.terms_hash, NEW.payload_version)
     IS DISTINCT FROM ROW(req.grant_id, req.version, req.terms_hash, req.payload_version) THEN
    RAISE EXCEPTION 'A grant signature must sign exactly what its request pinned' USING ERRCODE = '23514';
  END IF;
  IF g.id IS NULL OR g.version <> NEW.version
     OR g.activated_at IS NOT NULL OR g.revoked_at IS NOT NULL OR g.holder_departed_at IS NOT NULL THEN
    RAISE EXCEPTION 'A grant signature needs a pending grant at its signed version' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.holder_kind, NEW.holder_id) IS DISTINCT FROM ROW(
       CASE WHEN g.user_id IS NOT NULL THEN 'user' WHEN g.agent_id IS NOT NULL THEN 'agent'
            WHEN g.worker_id IS NOT NULL THEN 'worker' ELSE 'app' END,
       COALESCE(g.user_id, g.agent_id, g.worker_id, g.grantee_app_id)) THEN
    RAISE EXCEPTION 'A grant signature must name the grant''s holder' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM passkey_credentials
                  WHERE id = NEW.passkey_credential_id AND owner_id = NEW.signer_id AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'A grant signature needs the signer''s own unrevoked passkey' USING ERRCODE = '23514';
  END IF;
  IF NEW.selection_signature_id IS NOT NULL THEN
    -- #5001: a selection item's record repeats its touch record (signer, passkey, RP and assertion bytes) and its item must be
    -- one of the items that touch signed, by grant id, version and terms hash. The touch record is read, never locked here:
    -- its own insert took the selection's lock, and the caller holds the item's request.
    SELECT * INTO touch FROM grant_selection_signatures WHERE id = NEW.selection_signature_id;
    IF NOT FOUND OR touch.selection_id IS DISTINCT FROM req.selection_id
       OR ROW(NEW.signer_id, NEW.passkey_credential_id, NEW.rp_id, NEW.authenticator_data, NEW.client_data_json, NEW.signature)
          IS DISTINCT FROM ROW(touch.signer_id, touch.passkey_credential_id, touch.rp_id, touch.authenticator_data, touch.client_data_json, touch.signature)
       OR NOT (touch.items @> jsonb_build_array(jsonb_build_object('grantId', NEW.grant_id, 'version', NEW.version, 'termsHash', NEW.terms_hash))) THEN
      RAISE EXCEPTION 'A selection grant signature must be one of the items its touch record signed' USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW.verified_at := platform_now;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS grant_signature_guard ON grant_signatures;
CREATE TRIGGER grant_signature_guard BEFORE INSERT OR UPDATE OR DELETE ON grant_signatures
FOR EACH ROW EXECUTE FUNCTION hadron_guard_grant_signature();

-- Staleness: a grant that is revoked, whose holder goes, or whose version or terms move (a user merge moving the holder link
-- among them) ends its open requests, so no request can complete over terms the person was not shown. Activation ends them
-- too (#3649 slice C, slice B design choice 6): the completion marks its OWN request completed before it activates, so only
-- the others are still open. Column-scoped, so the issuer-erasure move never pays for it.
CREATE OR REPLACE FUNCTION hadron_grant_signing_stale() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF ROW(NEW.version, NEW.revoked_at, NEW.holder_departed_at, NEW.activated_at, NEW.app_id, NEW.user_id, NEW.agent_id, NEW.worker_id,
         NEW.grantee_app_id, NEW.action, NEW.action_values, NEW.starts_at, NEW.expires_at, NEW.max_uses, NEW.reason)
     IS DISTINCT FROM
     ROW(OLD.version, OLD.revoked_at, OLD.holder_departed_at, OLD.activated_at, OLD.app_id, OLD.user_id, OLD.agent_id, OLD.worker_id,
         OLD.grantee_app_id, OLD.action, OLD.action_values, OLD.starts_at, OLD.expires_at, OLD.max_uses, OLD.reason) THEN
    PERFORM hadron_end_open_grant_signing_requests(NEW.id);
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS grant_signing_stale ON grants;
CREATE TRIGGER grant_signing_stale AFTER UPDATE OF version, revoked_at, holder_departed_at, activated_at, app_id, user_id, agent_id, worker_id,
  grantee_app_id, action, action_values, starts_at, expires_at, max_uses, reason ON grants
FOR EACH ROW EXECUTE FUNCTION hadron_grant_signing_stale();
-- #1631 PR2 / cor:aut:040:07-08: passkey registration lifecycle invariants. One source; the newest migration to carry it
-- (20261110010000_grant_sign_ceremony) ends with it verbatim (pinned by src/lib/passkeys/cancel1631.test.ts).

-- A first passkey's cancel link: one token per first passkey, stored as SHA-256, spent once, never deleted (the
-- cancel itself is recorded on the credential: cancelled_at, cancel_ip, cancel_user_agent).
ALTER TABLE "passkey_cancel_tokens" DROP CONSTRAINT IF EXISTS "chk_passkey_cancel_token_shape";
ALTER TABLE "passkey_cancel_tokens" ADD CONSTRAINT "chk_passkey_cancel_token_shape" CHECK (
  "token_hash" ~ '^[0-9a-f]{64}$' AND ("used_at" IS NULL OR "used_at" >= "created_at")
);
CREATE OR REPLACE FUNCTION hadron_guard_passkey_cancel_token() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE db_now timestamp(3) := (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3);
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Passkey cancel tokens are never deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.used_at IS NOT NULL THEN
      RAISE EXCEPTION 'A cancel token begins unused' USING ERRCODE = '23514';
    END IF;
    NEW.created_at := db_now;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.passkey_id, NEW.token_hash, NEW.created_at) IS DISTINCT FROM ROW(OLD.id, OLD.passkey_id, OLD.token_hash, OLD.created_at) THEN
    RAISE EXCEPTION 'Passkey cancel token identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.used_at IS NOT NULL AND NEW.used_at IS DISTINCT FROM OLD.used_at THEN
    RAISE EXCEPTION 'A cancel token is spent once' USING ERRCODE = '23514';
  END IF;
  IF OLD.used_at IS NULL AND NEW.used_at IS NOT NULL THEN NEW.used_at := db_now; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS passkey_cancel_token_guard ON passkey_cancel_tokens;
CREATE TRIGGER passkey_cancel_token_guard BEFORE INSERT OR UPDATE OR DELETE ON passkey_cancel_tokens
FOR EACH ROW EXECUTE FUNCTION hadron_guard_passkey_cancel_token();

-- The binding on a ceremony: all or nothing, consistent with its purpose and kind, set once.
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
  -- #3649 slice C (cor:acl:140:07): a grant's signing ceremony (GRANT_SIGN) is bound the same way; GRANT_SIGN_PROOF never is.
  -- #5001: a selection's signing ceremony (GRANT_SELECTION_SIGN) is bound the same way; GRANT_SELECTION_SIGN_PROOF never is.
  OR ("purpose" IN ('SIGN', 'GRANT_SIGN', 'GRANT_SELECTION_SIGN') AND "user_id" IS NOT NULL AND "kind" IS NOT NULL AND "kind" = 'sign' AND "registration_method" IS NULL
    AND "sign_in_browser_hash" IS NULL AND "vouch_passkey_id" IS NULL AND "user_handle" IS NULL)
);
CREATE OR REPLACE FUNCTION hadron_guard_passkey_ceremony_binding() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.user_id IS NOT NULL AND ROW(NEW.user_id, NEW.kind, NEW.registration_method, NEW.sign_in_browser_hash, NEW.vouch_passkey_id, NEW.user_handle)
    IS DISTINCT FROM ROW(OLD.user_id, OLD.kind, OLD.registration_method, OLD.sign_in_browser_hash, OLD.vouch_passkey_id, OLD.user_handle) THEN
    RAISE EXCEPTION 'A registration ceremony is bound once' USING ERRCODE = '23514';
  END IF;
  IF OLD.consumed_at IS NOT NULL AND OLD.user_id IS NULL AND NEW.user_id IS NOT NULL THEN
    RAISE EXCEPTION 'A consumed ceremony cannot be bound' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS passkey_ceremony_binding_guard ON passkey_ceremonies;
CREATE TRIGGER passkey_ceremony_binding_guard BEFORE UPDATE ON passkey_ceremonies
FOR EACH ROW EXECUTE FUNCTION hadron_guard_passkey_ceremony_binding();

-- Notice outbox: a first passkey's notice carries a cancel token until it is sent; a later one's never does.
ALTER TABLE "passkey_registration_notices" DROP CONSTRAINT IF EXISTS "chk_passkey_registration_notice_shape";
ALTER TABLE "passkey_registration_notices" ADD CONSTRAINT "chk_passkey_registration_notice_shape" CHECK (
  "kind" IN ('first', 'later') AND "attempts" >= 0
  AND ("kind" = 'first' OR "cancel_token_enc" IS NULL)
  AND ("kind" = 'later' OR "sent_at" IS NOT NULL OR "failed_at" IS NOT NULL OR "cancel_token_enc" IS NOT NULL)
  AND ("sent_at" IS NULL OR "failed_at" IS NULL)
);
CREATE OR REPLACE FUNCTION hadron_guard_passkey_registration_notice() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Passkey registration notices are never deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND ROW(NEW.id, NEW.passkey_id, NEW.user_id, NEW.kind, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.passkey_id, OLD.user_id, OLD.kind, OLD.created_at) THEN
    RAISE EXCEPTION 'Passkey registration notice identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND ((OLD.sent_at IS NOT NULL AND NEW.sent_at IS DISTINCT FROM OLD.sent_at)
    OR (OLD.seen_at IS NOT NULL AND NEW.seen_at IS DISTINCT FROM OLD.seen_at)
    OR (OLD.cancel_token_enc IS NULL AND NEW.cancel_token_enc IS NOT NULL)) THEN
    RAISE EXCEPTION 'Passkey registration notice delivery is set once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS passkey_registration_notice_guard ON passkey_registration_notices;
CREATE TRIGGER passkey_registration_notice_guard BEFORE UPDATE OR DELETE ON passkey_registration_notices
FOR EACH ROW EXECUTE FUNCTION hadron_guard_passkey_registration_notice();
-- #5001 (cor:acl:140:07, :09; ruling 0255 item 19): one passkey touch over a SELECTION of one App's pending grants. One source of
-- SQL (conventions:append-only-table-trigger): included by post-push.sql AFTER grant-signing-invariants.sql and appended
-- byte-identical to migration 20261125130000_grant_selection_signing (pinned by src/lib/signing/grantSelection5001.test.ts).
-- Every timestamp is the DB clock (hadron_signing_now(), prisma/signing-invariants.sql).
--
-- A selection is one row; each of its grants is an ITEM, an ordinary grant_signing_requests row with selection_id set (so the
-- per-grant stale trigger and the activation guard in grant-invariants.sql stay per grant and unchanged). A selection begins
-- open and ends exactly once. When it ends, the items still open end with it (completed: stale; the others: the selection's own
-- end). The touch record (grant_selection_signatures) is insert-only against an open, unexpired selection, by the signer's own
-- unrevoked passkey, and keeps the signed item list: every item must be one of the selection's item requests at the version and
-- terms hash that request pinned, in ascending grant id, at most the cap. Both tables are deleted only with their App.
-- TRUNCATE fires no row trigger; it is the TEST-ONLY cleanup path (src/test/helpers.ts cleanDb).

ALTER TABLE grant_signing_selections DROP CONSTRAINT IF EXISTS chk_grant_signing_selection_shape;
ALTER TABLE grant_signing_selections ADD CONSTRAINT chk_grant_signing_selection_shape CHECK (
  id ~ '^[A-Za-z0-9_-]{22}$'
  AND state IS NOT NULL AND state IN ('open','completed','declined','expired','withdrawn')
  AND payload_version IN ('hadron-grant-selection-signature-v1')
  AND (requester_user_id IS NOT NULL OR requester_app_id IS NOT NULL)
  AND (requester_user_id IS NULL OR requester_user_id <> '')
  AND (requester_app_id IS NULL OR requester_app_id <> '')
  AND expires_at > created_at
  AND ((state = 'open') = (ended_at IS NULL))
  AND (ended_at IS NULL OR ended_at >= created_at)
);

ALTER TABLE grant_selection_signatures DROP CONSTRAINT IF EXISTS chk_grant_selection_signature_shape;
ALTER TABLE grant_selection_signatures ADD CONSTRAINT chk_grant_selection_signature_shape CHECK (
  payload_version IN ('hadron-grant-selection-signature-v1')
  AND signer_id <> ''
  AND jsonb_typeof(items) = 'array'
  AND jsonb_array_length(items) BETWEEN 1 AND 25
  AND rp_id IS NOT NULL AND rp_id <> ''
  AND octet_length(authenticator_data) >= 37
  AND substring(authenticator_data FROM 1 FOR 32) = sha256(convert_to(rp_id, 'UTF8'))
  AND octet_length(client_data_json) > 0
  AND octet_length(signature) > 0
);

-- Selections: begin open, pinned fields immutable, one end, DB-clock times, deleted only with their App.
CREATE OR REPLACE FUNCTION hadron_guard_grant_signing_selection() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  platform_now timestamp(3) := hadron_signing_now();
  lifetime interval;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM apps WHERE id = OLD.app_id) THEN
      RAISE EXCEPTION 'Grant signing selections are kept for the App''s lifetime' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state IS DISTINCT FROM 'open' OR NEW.ended_at IS NOT NULL THEN
      RAISE EXCEPTION 'A grant signing selection begins open' USING ERRCODE = '23514';
    END IF;
    -- The inserter states both times from ONE clock read; the lifetime is their difference, and the start is re-stamped here.
    lifetime := NEW.expires_at - NEW.created_at;
    NEW.created_at := platform_now;
    NEW.expires_at := platform_now + lifetime;
    RETURN NEW;
  END IF;
  -- UPDATE
  IF ROW(NEW.id, NEW.app_id, NEW.payload_version, NEW.requester_user_id, NEW.requester_app_id, NEW.requester_worker_id,
         NEW.requester_session_id, NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.app_id, OLD.payload_version, OLD.requester_user_id, OLD.requester_app_id, OLD.requester_worker_id,
         OLD.requester_session_id, OLD.created_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'A grant signing selection''s pinned fields are immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.state <> 'open' THEN
    RAISE EXCEPTION 'A grant signing selection ends exactly once' USING ERRCODE = '23514';
  END IF;
  IF NEW.state = 'open' THEN
    IF NEW.ended_at IS NOT NULL THEN
      RAISE EXCEPTION 'An open grant signing selection has no end time' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.state = 'expired' THEN
    IF platform_now < OLD.expires_at THEN
      RAISE EXCEPTION 'A grant signing selection expires only once its lifetime has passed' USING ERRCODE = '23514';
    END IF;
    NEW.ended_at := OLD.expires_at;
    RETURN NEW;
  END IF;
  IF platform_now >= OLD.expires_at THEN
    RAISE EXCEPTION 'An expired grant signing selection cannot end any other way' USING ERRCODE = '23514';
  END IF;
  IF NEW.state = 'completed' AND NOT EXISTS (SELECT 1 FROM grant_selection_signatures WHERE selection_id = NEW.id) THEN
    RAISE EXCEPTION 'A grant signing selection completes only with its touch record' USING ERRCODE = '23514';
  END IF;
  NEW.ended_at := platform_now;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS grant_signing_selection_guard ON grant_signing_selections;
CREATE TRIGGER grant_signing_selection_guard BEFORE INSERT OR UPDATE OR DELETE ON grant_signing_selections
FOR EACH ROW EXECUTE FUNCTION hadron_guard_grant_signing_selection();

-- When a selection ends, the items still open end with it (ruling R6: a new request is needed for what did not activate). A
-- completed selection leaves its failed items stale; the other ends carry through; an expiry ends them at the same deadline.
CREATE OR REPLACE FUNCTION hadron_end_selection_items() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.state = 'open' AND NEW.state <> 'open' THEN
    UPDATE grant_signing_requests
       SET state = CASE WHEN NEW.state = 'completed' THEN 'stale' ELSE NEW.state END
     WHERE selection_id = NEW.id AND state = 'open';
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS grant_signing_selection_end_items ON grant_signing_selections;
CREATE TRIGGER grant_signing_selection_end_items AFTER UPDATE OF state ON grant_signing_selections
FOR EACH ROW EXECUTE FUNCTION hadron_end_selection_items();

-- Touch records: insert-only against an open, unexpired selection, by the signer's own unrevoked passkey, over items that are
-- exactly some of the selection's item requests at their pins, ascending by grant id; never updated; deleted only with the App.
CREATE OR REPLACE FUNCTION hadron_guard_grant_selection_signature() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  platform_now timestamp(3);
  sel grant_signing_selections%ROWTYPE;
  prev text := NULL;
  item jsonb;
  gid text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM grant_signing_selections WHERE id = OLD.selection_id) THEN
      RAISE EXCEPTION 'Grant selection signature records are never deleted' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Grant selection signature records are append-only' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO sel FROM grant_signing_selections WHERE id = NEW.selection_id FOR UPDATE;
  platform_now := hadron_signing_now();
  IF NOT FOUND OR sel.state <> 'open' OR platform_now >= sel.expires_at THEN
    RAISE EXCEPTION 'A selection signature needs an open signing selection' USING ERRCODE = '23514';
  END IF;
  IF NEW.payload_version IS DISTINCT FROM sel.payload_version THEN
    RAISE EXCEPTION 'A selection signature must sign exactly what its selection pinned' USING ERRCODE = '23514';
  END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(NEW.items) LOOP
    IF jsonb_typeof(item) <> 'object' OR (SELECT count(*) FROM jsonb_object_keys(item)) <> 3
       OR jsonb_typeof(item -> 'grantId') <> 'string' OR jsonb_typeof(item -> 'version') <> 'number'
       OR (item ->> 'version') !~ '^[0-9]{1,9}$'
       OR jsonb_typeof(item -> 'termsHash') <> 'string' THEN
      RAISE EXCEPTION 'A selection signature item is a grant id, a version and a terms hash' USING ERRCODE = '23514';
    END IF;
    gid := item ->> 'grantId';
    -- Strictly ascending by byte order of the id (the order the payload is built in): no duplicate, no reordering.
    IF prev IS NOT NULL AND convert_to(gid, 'UTF8') <= convert_to(prev, 'UTF8') THEN
      RAISE EXCEPTION 'A selection signature lists its items in ascending grant id, once each' USING ERRCODE = '23514';
    END IF;
    prev := gid;
    IF NOT EXISTS (SELECT 1 FROM grant_signing_requests r
                    WHERE r.selection_id = NEW.selection_id AND r.grant_id = gid
                      AND r.version = (item ->> 'version')::int AND r.terms_hash = item ->> 'termsHash'
                      AND r.payload_version = sel.payload_version) THEN
      RAISE EXCEPTION 'A selection signature item must be an item of its selection at its pinned terms' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM passkey_credentials
                  WHERE id = NEW.passkey_credential_id AND owner_id = NEW.signer_id AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'A selection signature needs the signer''s own unrevoked passkey' USING ERRCODE = '23514';
  END IF;
  NEW.verified_at := platform_now;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS grant_selection_signature_guard ON grant_selection_signatures;
CREATE TRIGGER grant_selection_signature_guard BEFORE INSERT OR UPDATE OR DELETE ON grant_selection_signatures
FOR EACH ROW EXECUTE FUNCTION hadron_guard_grant_selection_signature();

-- #5001: the selection's FK-free requester worker and session ids join the closed #1162 fence inventory (this file's own entry in
-- src/lib/workerReferenceFence1162.test.ts laterFences).
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "grant_signing_selections";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "grant_signing_selections"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.requester_worker_id', 's:$.requester_session_id');
