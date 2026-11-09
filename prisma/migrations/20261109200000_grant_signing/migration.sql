-- #3649 slice B (cor:acl:140:07, :09): grant signing requests and append-only grant signature records, sibling tables beside
-- node signing's (R1 (b): the live node-signing tables stay byte-identical). One grant per request (gate selection 1). The
-- grant's signature_id gains its foreign key and a unique index (a signature activates one grant). The guards and the stale
-- trigger follow as a byte-identical copy of prisma/grant-signing-invariants.sql. Additive on new tables; the only change to an
-- existing table is the signature_id key, a column the grant guard keeps NULL on every row, so no row can refuse.

-- CreateTable
CREATE TABLE "grant_signing_requests" (
    "id" TEXT NOT NULL,
    "grant_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "terms_hash" TEXT NOT NULL,
    "payload_version" TEXT NOT NULL,
    "requester_user_id" TEXT,
    "requester_app_id" TEXT,
    "requester_worker_id" TEXT,
    "requester_session_id" TEXT,
    "state" TEXT NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT (clock_timestamp() AT TIME ZONE 'UTC'::text),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),

    CONSTRAINT "grant_signing_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grant_signatures" (
    "id" TEXT NOT NULL,
    "grant_id" TEXT NOT NULL,
    "signing_request_id" TEXT NOT NULL,
    "signer_id" TEXT NOT NULL,
    "passkey_credential_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "terms_hash" TEXT NOT NULL,
    "holder_kind" TEXT NOT NULL,
    "holder_id" TEXT NOT NULL,
    "payload_version" TEXT NOT NULL,
    "rp_id" TEXT NOT NULL,
    "authenticator_data" BYTEA NOT NULL,
    "client_data_json" BYTEA NOT NULL,
    "signature" BYTEA NOT NULL,
    "verified_at" TIMESTAMP(3) NOT NULL DEFAULT (clock_timestamp() AT TIME ZONE 'UTC'::text),

    CONSTRAINT "grant_signatures_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "grant_signing_requests_grant_id_created_at_idx" ON "grant_signing_requests"("grant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "grant_signatures_signing_request_id_key" ON "grant_signatures"("signing_request_id");

-- CreateIndex
CREATE INDEX "grant_signatures_grant_id_idx" ON "grant_signatures"("grant_id");

-- CreateIndex
CREATE UNIQUE INDEX "grants_signature_id_key" ON "grants"("signature_id");

-- AddForeignKey
ALTER TABLE "grants" ADD CONSTRAINT "grants_signature_id_fkey" FOREIGN KEY ("signature_id") REFERENCES "grant_signatures"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "grant_signing_requests" ADD CONSTRAINT "grant_signing_requests_grant_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "grants"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "grant_signatures" ADD CONSTRAINT "grant_signatures_grant_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "grants"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "grant_signatures" ADD CONSTRAINT "grant_signatures_signing_request_id_fkey" FOREIGN KEY ("signing_request_id") REFERENCES "grant_signing_requests"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "grant_signatures" ADD CONSTRAINT "grant_signatures_passkey_credential_id_fkey" FOREIGN KEY ("passkey_credential_id") REFERENCES "passkey_credentials"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- #3649 slice B (cor:acl:140:07, :09; the node-signing mirror cor:dmo:130:03): grant signing requests and append-only grant
-- signature records. One source of SQL (conventions:append-only-table-trigger): included by post-push.sql and appended
-- byte-identical to migration 20261109200000_grant_signing (pinned by src/lib/signing/grantSigning3649.test.ts). Every timestamp
-- is the DB clock (hadron_signing_now(), prisma/signing-invariants.sql), so a write queued behind a lock gets a later time than
-- the one it waited for.
--
-- ONE grant per request (gate selection 1; a selection is later scope). No signer is named (ruling 0255, item 12). A request
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
  AND payload_version IN ('hadron-grant-signature-v1')
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
  AND payload_version IN ('hadron-grant-signature-v1')
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
LANGUAGE plpgsql AS $$
DECLARE platform_now timestamp(3) := hadron_signing_now();
BEGIN
  UPDATE grant_signing_requests SET state = 'expired'
   WHERE grant_id = p_grant_id AND state = 'open' AND expires_at <= platform_now;
  UPDATE grant_signing_requests SET state = 'stale'
   WHERE grant_id = p_grant_id AND state = 'open';
END $$;

-- Requests: begin open on a pending grant at its version, pinned fields immutable, one end, DB-clock times, deleted only with
-- their grant (the FK cascade fires after the grant row is gone).
CREATE OR REPLACE FUNCTION hadron_guard_grant_signing_request() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE platform_now timestamp(3) := hadron_signing_now();
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM grants WHERE id = OLD.grant_id) THEN
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
    -- Re-read after the lock: an insert that waited behind a grant writer begins when it actually could.
    platform_now := hadron_signing_now();
    NEW.created_at := platform_now;
    RETURN NEW;
  END IF;
  -- UPDATE
  IF ROW(NEW.id, NEW.grant_id, NEW.version, NEW.terms_hash, NEW.payload_version,
         NEW.requester_user_id, NEW.requester_app_id, NEW.requester_worker_id, NEW.requester_session_id,
         NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.grant_id, OLD.version, OLD.terms_hash, OLD.payload_version,
         OLD.requester_user_id, OLD.requester_app_id, OLD.requester_worker_id, OLD.requester_session_id,
         OLD.created_at, OLD.expires_at) THEN
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
LANGUAGE plpgsql AS $$
DECLARE
  -- Read only after both locks below: a clock sampled before a wait would judge a deadline that passed during it as unpassed.
  platform_now timestamp(3);
  req grant_signing_requests%ROWTYPE;
  g grants%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM grants WHERE id = OLD.grant_id) THEN
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
  NEW.verified_at := platform_now;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS grant_signature_guard ON grant_signatures;
CREATE TRIGGER grant_signature_guard BEFORE INSERT OR UPDATE OR DELETE ON grant_signatures
FOR EACH ROW EXECUTE FUNCTION hadron_guard_grant_signature();

-- Staleness: a grant that is revoked, whose holder goes, or whose version or terms move (a user merge moving the holder link
-- among them) ends its open requests, so no request can complete over terms the person was not shown. Column-scoped, so the
-- issuer-erasure move and slice C's activation columns never pay for it.
CREATE OR REPLACE FUNCTION hadron_grant_signing_stale() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.version, NEW.revoked_at, NEW.holder_departed_at, NEW.app_id, NEW.user_id, NEW.agent_id, NEW.worker_id,
         NEW.grantee_app_id, NEW.action, NEW.action_values, NEW.starts_at, NEW.expires_at, NEW.max_uses, NEW.reason)
     IS DISTINCT FROM
     ROW(OLD.version, OLD.revoked_at, OLD.holder_departed_at, OLD.app_id, OLD.user_id, OLD.agent_id, OLD.worker_id,
         OLD.grantee_app_id, OLD.action, OLD.action_values, OLD.starts_at, OLD.expires_at, OLD.max_uses, OLD.reason) THEN
    PERFORM hadron_end_open_grant_signing_requests(NEW.id);
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS grant_signing_stale ON grants;
CREATE TRIGGER grant_signing_stale AFTER UPDATE OF version, revoked_at, holder_departed_at, app_id, user_id, agent_id, worker_id,
  grantee_app_id, action, action_values, starts_at, expires_at, max_uses, reason ON grants
FOR EACH ROW EXECUTE FUNCTION hadron_grant_signing_stale();
