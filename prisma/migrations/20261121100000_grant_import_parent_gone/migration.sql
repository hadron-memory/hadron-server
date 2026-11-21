-- #4179: additive. Carries the full canonical prisma/grant-invariants.sql (the parity guard in grantRow3668.test.ts wants the newest
-- migration to end with a byte-identical copy). What is NEW here: hadron_grant_import_parent_gone() and the AFTER DELETE trigger
-- agent_imports_grant_parent_gone, which end an imported agent's grants when its importing parent is hard-deleted. Everything else is a
-- CREATE OR REPLACE / DROP-then-CREATE of the same text. The previous image runs against this schema unchanged.
-- #3668 (S1a): the database half of the grant row, its events and the actions table. One source; the newest migration to
-- carry it (today 20261121100000_grant_import_parent_gone) ends with it verbatim (pinned by src/lib/grants/grantRow3668.test.ts), and
-- post-push.sql applies it.
--
-- GRANTS. Exactly one holder (a user, an agent, a worker or an App); the CHECK cannot pass on NULL, because
-- num_nonnulls() is never NULL. The holder ids are SEALED (no foreign key, #3690 S2a-h): a holder that goes ENDS its grant and
-- the record stays (cor:acl:140:03, ruling 0255 item 3), so the id must outlive the row, and SET NULL would break the CHECK.
-- The kind of holder is the column that is set; `holder_departed_at` is the end. An INSERT must name a holder that exists and
-- has not gone (a FOR SHARE read, the lock a foreign key took), so a new row cannot race a holder's departure. A row ARRIVES PENDING: no activation, verification, signature, revocation or use, so no
-- path can mint a live row (ruling 0099, the database half). After that a row is never edited. The only moves are:
--   * it ACTIVATES once (#3649 slice C, cor:acl:140:07, :04): activated_at goes from NULL to the database clock, together with
--     verification_kind 'passkey', verified_by (the signer) and signature_id, which must name a signature record of THIS
--     grant at its current version, by that signer, whose signing request has completed. The signer becomes the issuer
--     (issuer_user_id := verified_by). Only a grant not revoked, not left by its holder and not past its expiry activates, and
--     nothing else moves in the same update. After that the three activation columns never move again;
--   * it is USED (#3483, cor:acl:140:03 single-use and repeating grants): use_count goes up by exactly one, and only while the
--     row is live on the database clock (activated, not revoked, holder not gone, App not deleted, started, not expired, below
--     its max_uses), with nothing else moving but updated_at. The caller holds the row FOR UPDATE and writes the USE event;
--   * it ends ONCE, by revoked_at stamped together with revoked_by, or by its HOLDER going: holder_departed_at is stamped
--     (NULL to a time, never back) by the AFTER DELETE triggers below on every hard delete of a holder row, and by the
--     deleting code on the soft deletes (an erased person, a retired worker, a deleted agent or App). The first end stands:
--     a row already revoked, departed, expired or spent (an ACTIVATED row past its expiry or at its count) is not stamped (ruling 0259);
--   * an erased issuer's or requester's link goes: issuer_user_id or requested_by_user_id becomes NULL and the reason stays (cor:acl:140:08), and only when that
--     person is ERASED (the users row is soft-deleted, or gone), never for a live person;
--   * along a user merge ALREADY recorded in user_merges (mergeUsers writes that row before it rewrites links; the
--     #1332 report trigger uses the same proof), a person link moves from the merged-away user to the survivor, and only
--     to that survivor: holder, issuer, requester, revoker, verifier. Never to NULL, never to another kind of holder,
--     never to another App; every other column stays.
-- A DELETE is refused unless the App is already gone (the ON DELETE CASCADE of a hard delete). TRUNCATE fires no row
-- trigger; it is the TEST-ONLY cleanup path (src/test/helpers.ts cleanDb).
ALTER TABLE grants DROP CONSTRAINT IF EXISTS chk_grants_exactly_one_holder;
ALTER TABLE grants ADD CONSTRAINT chk_grants_exactly_one_holder CHECK (
  num_nonnulls(user_id, agent_id, worker_id, grantee_app_id) = 1
);
ALTER TABLE grants DROP CONSTRAINT IF EXISTS chk_grants_shape;
ALTER TABLE grants ADD CONSTRAINT chk_grants_shape CHECK (
  btrim(reason) <> '' AND
  (max_uses IS NULL OR max_uses > 0) AND
  use_count >= 0 AND
  (max_uses IS NULL OR use_count <= max_uses) AND
  version >= 1 AND
  (starts_at IS NULL OR expires_at IS NULL OR starts_at < expires_at) AND
  (revoked_at IS NULL) = (revoked_by IS NULL) AND
  (revoked_by IS NULL OR revoked_by <> '') AND
  (withdrawn_at IS NULL OR (withdrawn_at = revoked_at AND activated_at IS NULL))
);
-- True when `old_id` was merged into `new_id` (a recorded merge), the only proof a person link may move on.
CREATE OR REPLACE FUNCTION hadron_grant_link_merged(old_id text, new_id text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT old_id IS NOT NULL AND new_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM user_merges m WHERE m.source_user_id = old_id AND m.target_user_id = new_id)
$$;
-- #4172: the SQL twin of resolveAppInstallation (src/lib/appInstallations.ts) as the grant guard needs it: does this agent still have an
-- EFFECTIVE installation in this App? TRUE when EITHER a physical app_agents row exists and the agent is live, OR the agent is
-- installed by DERIVATION (#2168): the App belongs to a live organization and is itself live and not uninstalled, a LIVE parent
-- agent is installed in it by row, an agent_imports edge parent -> agent exists, the imported agent is live, the agent's own
-- organization (if any) is live, and the organization's licence to the agent is usable (an activated, unrevoked, unexpired
-- agent_org_grants row, or with no row at all, the agent's own organization is the App's: orgAgentLicenseUsable). It reads the
-- database clock for the licence expiry. Drift from the code is pinned by a differential test (resolveAppInstallation vs this).
CREATE OR REPLACE FUNCTION hadron_agent_installed_in_app(p_app_id text, p_agent_id text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM app_agents aa JOIN agents g ON g.id = aa.agent_id
                  WHERE aa.app_id = p_app_id AND aa.agent_id = p_agent_id AND g.deleted_at IS NULL)
      OR EXISTS (
        SELECT 1
          FROM apps ap
          JOIN organizations o ON o.id = ap.organization_id AND o.deleted_at IS NULL
          JOIN agents ia ON ia.id = p_agent_id AND ia.deleted_at IS NULL
          JOIN agent_imports ai ON ai.imported_agent_id = ia.id
          JOIN app_agents pa ON pa.app_id = ap.id AND pa.agent_id = ai.parent_agent_id
          JOIN agents pg ON pg.id = pa.agent_id AND pg.deleted_at IS NULL
         WHERE ap.id = p_app_id AND ap.deleted_at IS NULL AND ap.uninstalled_at IS NULL
           AND (ia.organization_id IS NULL OR EXISTS (SELECT 1 FROM organizations ao WHERE ao.id = ia.organization_id AND ao.deleted_at IS NULL))
           AND CASE WHEN EXISTS (SELECT 1 FROM agent_org_grants l WHERE l.org_id = ap.organization_id AND l.agent_id = ia.id)
                    THEN EXISTS (SELECT 1 FROM agent_org_grants l WHERE l.org_id = ap.organization_id AND l.agent_id = ia.id
                                  AND l.activated_at IS NOT NULL AND l.revoked_at IS NULL
                                  AND (l.expires_at IS NULL OR l.expires_at > (clock_timestamp() AT TIME ZONE 'UTC')))
                    ELSE ia.organization_id = ap.organization_id END)
$$;

CREATE OR REPLACE FUNCTION hadron_guard_grant() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  -- Columns that may differ between OLD and NEW; each is judged by its own rule below.
  movable text[] := ARRAY['updated_at', 'use_count', 'user_id', 'issuer_user_id', 'requested_by_user_id', 'verified_by', 'revoked_at', 'revoked_by',
                          'holder_departed_at', 'activated_at', 'verification_kind', 'signature_id', 'withdrawn_at'];
  db_now timestamp(3) := (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3);
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM apps WHERE id = OLD.app_id) THEN
      RAISE EXCEPTION 'grants are append-only' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.activated_at IS NOT NULL OR NEW.verification_kind IS NOT NULL OR NEW.verified_by IS NOT NULL
       OR NEW.signature_id IS NOT NULL OR NEW.revoked_by IS NOT NULL -- (revoked_at alone is refused by the pair CHECK)
       OR NEW.use_count <> 0 OR NEW.version <> 1 OR NEW.holder_departed_at IS NOT NULL OR NEW.withdrawn_at IS NOT NULL THEN
      RAISE EXCEPTION 'grants must arrive pending' USING ERRCODE = '23514';
    END IF;
    -- The holder must exist and not have gone. FOR SHARE: a departure that updates the holder row waits for this row (and a
    -- departure that committed first is seen), the protection a foreign key gave. A holder id with no row is never a grant.
    -- (Judged only for exactly one holder: zero or several is chk_grants_exactly_one_holder's refusal, which runs next.)
    IF num_nonnulls(NEW.user_id, NEW.agent_id, NEW.worker_id, NEW.grantee_app_id) = 1 THEN
      IF NEW.user_id IS NOT NULL THEN
        PERFORM 1 FROM users WHERE id = NEW.user_id AND deleted_at IS NULL FOR SHARE;
      ELSIF NEW.agent_id IS NOT NULL THEN
        PERFORM 1 FROM agents WHERE id = NEW.agent_id AND deleted_at IS NULL FOR SHARE;
      ELSIF NEW.worker_id IS NOT NULL THEN
        PERFORM 1 FROM workers WHERE id = NEW.worker_id AND retired_at IS NULL FOR SHARE;
      ELSE
        PERFORM 1 FROM apps WHERE id = NEW.grantee_app_id AND deleted_at IS NULL FOR SHARE;
      END IF;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'a grant needs a holder that exists and has not gone' USING ERRCODE = '23503';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE: nothing but the movable columns may differ.
  IF (to_jsonb(NEW) - movable) <> (to_jsonb(OLD) - movable) THEN
    RAISE EXCEPTION 'grants are append-only' USING ERRCODE = '23514';
  END IF;
  -- A use (#3483): +1 on a row live at this instant, and nothing else in the same update. The caller holds the row FOR UPDATE,
  -- so the revocation, departure, expiry and count read here are the row's newest.
  IF NEW.use_count IS DISTINCT FROM OLD.use_count THEN
    IF NEW.use_count IS DISTINCT FROM OLD.use_count + 1
       OR OLD.activated_at IS NULL OR OLD.revoked_at IS NOT NULL OR OLD.holder_departed_at IS NOT NULL
       OR (OLD.starts_at IS NOT NULL AND OLD.starts_at > db_now)
       OR (OLD.expires_at IS NOT NULL AND OLD.expires_at <= db_now)
       OR (OLD.max_uses IS NOT NULL AND OLD.use_count >= OLD.max_uses)
       -- #4163: the action's own limits (cor:acl:140:02, ruling of 2026-11-14): its count of uses and its lifetime from activation.
       OR EXISTS (SELECT 1 FROM actions x WHERE x.name = OLD.action
                   AND ((x.max_uses IS NOT NULL AND OLD.use_count >= x.max_uses)
                     OR (x.lifetime_seconds IS NOT NULL AND OLD.activated_at + make_interval(secs => x.lifetime_seconds) <= db_now)))
       OR EXISTS (SELECT 1 FROM apps p WHERE p.id = OLD.app_id AND p.deleted_at IS NOT NULL)
       OR (to_jsonb(NEW) - ARRAY['updated_at', 'use_count']) <> (to_jsonb(OLD) - ARRAY['updated_at', 'use_count']) THEN
      RAISE EXCEPTION 'grants are append-only: a use adds one to a live grant and moves nothing else' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  -- The one activation (#3649 slice C): a pending grant, by its own completed signature, and nothing else in the same update.
  -- The signer becomes the issuer; the time is the database's. The caller holds the grant row (FOR UPDATE) when it writes this,
  -- so the revocation, departure and expiry read here are the row's newest.
  IF OLD.activated_at IS NULL AND NEW.activated_at IS NOT NULL THEN
    IF OLD.revoked_at IS NOT NULL OR OLD.holder_departed_at IS NOT NULL
       OR (OLD.expires_at IS NOT NULL AND OLD.expires_at <= db_now)
       OR OLD.verification_kind IS NOT NULL OR OLD.signature_id IS NOT NULL OR OLD.verified_by IS NOT NULL
       OR NEW.verification_kind IS DISTINCT FROM 'passkey' OR NEW.verified_by IS NULL OR NEW.signature_id IS NULL
       OR ROW(NEW.user_id, NEW.requested_by_user_id, NEW.revoked_at, NEW.revoked_by, NEW.holder_departed_at)
          IS DISTINCT FROM ROW(OLD.user_id, OLD.requested_by_user_id, OLD.revoked_at, OLD.revoked_by, OLD.holder_departed_at)
       OR NOT EXISTS (SELECT 1 FROM grant_signatures s JOIN grant_signing_requests r ON r.id = s.signing_request_id
                       WHERE s.id = NEW.signature_id AND s.grant_id = OLD.id AND r.grant_id = OLD.id
                         AND s.version = OLD.version AND r.version = OLD.version
                         AND s.signer_id = NEW.verified_by AND r.state = 'completed') THEN
      RAISE EXCEPTION 'grants are append-only: a grant activates once, by its own completed signature' USING ERRCODE = '23514';
    END IF;
    NEW.issuer_user_id := NEW.verified_by;
    NEW.activated_at := db_now;
    RETURN NEW;
  END IF;
  IF ROW(NEW.activated_at, NEW.verification_kind, NEW.signature_id) IS DISTINCT FROM ROW(OLD.activated_at, OLD.verification_kind, OLD.signature_id) THEN
    RAISE EXCEPTION 'grants are append-only' USING ERRCODE = '23514';
  END IF;
  -- The one revoke: stamped once, together with its revoker (the shape CHECK pairs the two).
  IF NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    -- (an already-revoked row has revoked_by set: the pair CHECK makes OLD.revoked_at redundant here)
    IF NEW.revoked_at IS NULL OR OLD.revoked_by IS NOT NULL THEN
      RAISE EXCEPTION 'grants are append-only' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.revoked_by IS DISTINCT FROM OLD.revoked_by THEN
    IF NOT hadron_grant_link_merged(OLD.revoked_by, NEW.revoked_by) THEN
      RAISE EXCEPTION 'grants are append-only' USING ERRCODE = '23514';
    END IF;
  END IF;
  -- #4173: the withdrawal marker is set once, in the very statement that stamps the revoke (equal to it), on a row never activated.
  -- Never cleared, moved, or added to a row already revoked.
  IF NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at
     AND (OLD.withdrawn_at IS NOT NULL OR NEW.withdrawn_at IS NULL OR OLD.revoked_at IS NOT NULL OR OLD.activated_at IS NOT NULL
          OR NEW.revoked_at IS NULL OR NEW.withdrawn_at <> NEW.revoked_at) THEN
    RAISE EXCEPTION 'grants are append-only' USING ERRCODE = '23514';
  END IF;
  -- The departure of the holder: stamped once (NULL to a time), only on a grant not already ended, never cleared or moved.
  -- A row the holder left cannot be re-pointed (the person link below also refuses it).
  IF NEW.holder_departed_at IS DISTINCT FROM OLD.holder_departed_at
     AND (OLD.holder_departed_at IS NOT NULL OR NEW.holder_departed_at IS NULL OR OLD.revoked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'grants are append-only' USING ERRCODE = '23514';
  END IF;
  -- The stamp is a FACT, so it needs its cause: the sealed holder has actually gone (the row is gone, soft-deleted, or the worker
  -- retired). A bare stamp on a live holder would end a grant by hand; the issuer link below has the same proof. (A hard delete
  -- stamps from the AFTER DELETE trigger, when the row is already gone.)
  IF NEW.holder_departed_at IS DISTINCT FROM OLD.holder_departed_at AND (
       -- #4171: a live person's grant may be stamped only on proof the person left the organization that owns the grant's App: the App
       -- belongs to an organization and the person has no live membership there (a membership live only in ANOTHER organization does
       -- not block; a user-owned App has no org leave, so a live person's stamp there stays refused).
       EXISTS (SELECT 1 FROM users u WHERE u.id = OLD.user_id AND u.deleted_at IS NULL
               AND NOT EXISTS (SELECT 1 FROM apps ga WHERE ga.id = OLD.app_id AND ga.organization_id IS NOT NULL
                               AND NOT EXISTS (SELECT 1 FROM org_members m WHERE m.user_id = OLD.user_id
                                               AND m.organization_id = ga.organization_id AND m.deleted_at IS NULL)))
       -- #4172: a live agent's grant may be stamped only once the agent has no effective installation in the grant's App.
    OR EXISTS (SELECT 1 FROM agents a WHERE a.id = OLD.agent_id AND a.deleted_at IS NULL
               AND hadron_agent_installed_in_app(OLD.app_id, OLD.agent_id))
    OR EXISTS (SELECT 1 FROM workers k WHERE k.id = OLD.worker_id AND k.retired_at IS NULL)
    OR EXISTS (SELECT 1 FROM apps p WHERE p.id = OLD.grantee_app_id AND p.deleted_at IS NULL)) THEN
    RAISE EXCEPTION 'grants are append-only' USING ERRCODE = '23514';
  END IF;
  IF OLD.holder_departed_at IS NOT NULL AND NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'grants are append-only' USING ERRCODE = '23514';
  END IF;
  -- An erased issuer's link goes (cor:acl:140:08), and ONLY for an erased person: the users row is soft-deleted, or gone (the
  -- foreign key's SET NULL on a hard delete runs after the row is deleted). Any other move of a person link must follow a recorded merge.
  IF NEW.issuer_user_id IS DISTINCT FROM OLD.issuer_user_id
     AND NOT (NEW.issuer_user_id IS NULL AND OLD.issuer_user_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = OLD.issuer_user_id AND u.deleted_at IS NULL))
     AND NOT hadron_grant_link_merged(OLD.issuer_user_id, NEW.issuer_user_id) THEN
    RAISE EXCEPTION 'grants are append-only' USING ERRCODE = '23514';
  END IF;
  -- #3813 / cor:acl:140:08, ruling 0265: only the erased requester's link may be cleared; no live-person
  -- clear or arbitrary reassignment. As for issuer erasure, all other append-only checks still apply.
  IF (NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id
      AND NOT (NEW.requested_by_user_id IS NULL AND OLD.requested_by_user_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = OLD.requested_by_user_id AND u.deleted_at IS NULL))
      AND NOT hadron_grant_link_merged(OLD.requested_by_user_id, NEW.requested_by_user_id))
     OR (NEW.verified_by IS DISTINCT FROM OLD.verified_by
      AND NOT hadron_grant_link_merged(OLD.verified_by, NEW.verified_by))
     OR (NEW.user_id IS DISTINCT FROM OLD.user_id
      AND NOT hadron_grant_link_merged(OLD.user_id, NEW.user_id)) THEN
    RAISE EXCEPTION 'grants are append-only' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS grants_guard ON grants;
CREATE TRIGGER grants_guard BEFORE INSERT OR UPDATE OR DELETE ON grants
FOR EACH ROW EXECUTE FUNCTION hadron_guard_grant();

-- HOLDER DEPARTURE on a HARD delete of a holder row, whichever path deletes it (an erasure's cascade, deleteWorker, a tombstone
-- reclaim, the owner rename's raw SQL): the grants it held end, in the deleting transaction. The soft deletes (an erased
-- person, a retired worker, a deleted agent, a deleted App) fire no delete, so those doors stamp the departure in code
-- (src/lib/grants/departure.ts). Only a grant not already ended (revoked, departed, expired or spent: the first end stands), and only one whose own App still
-- exists (a scope App's hard delete takes its grants with it, so there is nothing to stamp).
CREATE OR REPLACE FUNCTION hadron_grant_holder_gone() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Lock first, judge second (two statements, as endHeldGrants): a grant that expired while this delete waited for the row lock
  -- must be judged on the clock AFTER the lock, so it keeps its first end instead of being stamped.
  EXECUTE format(
    'SELECT 1 FROM grants WHERE %I = $1 AND holder_departed_at IS NULL AND revoked_at IS NULL
        AND EXISTS (SELECT 1 FROM apps a WHERE a.id = grants.app_id) ORDER BY id FOR UPDATE', TG_ARGV[0]) USING OLD.id;
  EXECUTE format(
    'UPDATE grants SET holder_departed_at = (clock_timestamp() AT TIME ZONE ''UTC''), updated_at = (clock_timestamp() AT TIME ZONE ''UTC'')
      WHERE %I = $1 AND holder_departed_at IS NULL AND revoked_at IS NULL
        AND EXISTS (SELECT 1 FROM apps a WHERE a.id = grants.app_id)
        AND NOT (activated_at IS NOT NULL AND ((expires_at IS NOT NULL AND expires_at <= (clock_timestamp() AT TIME ZONE ''UTC''))
          OR (max_uses IS NOT NULL AND use_count >= max_uses)
          OR EXISTS (SELECT 1 FROM actions x WHERE x.name = grants.action
               AND ((x.max_uses IS NOT NULL AND grants.use_count >= x.max_uses)
                 OR (x.lifetime_seconds IS NOT NULL
                     AND grants.activated_at + make_interval(secs => x.lifetime_seconds) <= (clock_timestamp() AT TIME ZONE ''UTC''))))))', TG_ARGV[0]) USING OLD.id;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS users_grant_holder_gone ON users;
CREATE TRIGGER users_grant_holder_gone AFTER DELETE ON users
FOR EACH ROW EXECUTE FUNCTION hadron_grant_holder_gone('user_id');
DROP TRIGGER IF EXISTS agents_grant_holder_gone ON agents;
CREATE TRIGGER agents_grant_holder_gone AFTER DELETE ON agents
FOR EACH ROW EXECUTE FUNCTION hadron_grant_holder_gone('agent_id');
DROP TRIGGER IF EXISTS workers_grant_holder_gone ON workers;
CREATE TRIGGER workers_grant_holder_gone AFTER DELETE ON workers
FOR EACH ROW EXECUTE FUNCTION hadron_grant_holder_gone('worker_id');
DROP TRIGGER IF EXISTS apps_grant_holder_gone ON apps;
CREATE TRIGGER apps_grant_holder_gone AFTER DELETE ON apps
FOR EACH ROW EXECUTE FUNCTION hadron_grant_holder_gone('grantee_app_id');

-- #4179 (cor:acl:140:03, Holger R2): a HARD delete of an IMPORTING PARENT agent cascades its agent_imports edges away
-- (parent_agent_id is ON DELETE CASCADE), and an imported agent left with no effective installation in an App has gone for its
-- grants there. Stamped here, in the deleting transaction, because it is a write door: the soft deletes and the code doors
-- stamp through src/lib/grants/agentInstallDeparture.ts, a hard delete fires only this trigger.
--   * Only when the PARENT row is gone. An ordinary edge removal (removeAgentImport, the parent still exists) is judged by its
--     own door under the installation locks (#4172 D2); a raw edge delete with a live parent ends nothing.
--   * hadron_agent_installed_in_app is #4172's effective-installation check: ANY route left (the child's own row, another
--     importing parent under a usable licence) keeps the grant. Only AGENT-held rows, only ones not already ended (revoked,
--     departed, expired, spent or past the action's limits: the first end stands), only ones whose own App still exists.
--   * Lock first, judge second (two statements, as hadron_grant_holder_gone): a grant that expired, or an install that
--     committed, while this delete waited for the row lock is judged on the state AFTER the lock. The grant row lock is the LAST
--     lock THIS TRIGGER takes (src/lib/grants/departure.ts, LOCK ORDER). Inside a multi-table cascade, later cascades of the same
--     delete can still lock other rows after it, so a code door that holds an installation lock and then wants a grant row can
--     deadlock with this delete. Postgres detects that and aborts one transaction whole (no partial stamp, no wrong data): the
--     delete or the door retries. No installation lock is taken here: a concurrent reinstall linearizes after the departure, and
--     a reinstall revives nothing (the stamp never clears), as for every door.
--   * Why only parent_agent_id: it is the ONE cascading foreign key on agent_imports (imported_agent_id and the agent_org_grants
--     key are ON DELETE RESTRICT, so those deletes refuse instead of removing an edge). A new cascading key would need a case here.
CREATE OR REPLACE FUNCTION hadron_grant_import_parent_gone() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM agents WHERE id = OLD.parent_agent_id) THEN
    RETURN NULL;
  END IF;
  PERFORM 1 FROM grants
   WHERE agent_id = OLD.imported_agent_id AND holder_departed_at IS NULL AND revoked_at IS NULL
     AND EXISTS (SELECT 1 FROM apps a WHERE a.id = grants.app_id)
     AND NOT hadron_agent_installed_in_app(grants.app_id, grants.agent_id)
   ORDER BY id FOR UPDATE;
  UPDATE grants SET holder_departed_at = (clock_timestamp() AT TIME ZONE 'UTC'), updated_at = (clock_timestamp() AT TIME ZONE 'UTC')
   WHERE agent_id = OLD.imported_agent_id AND holder_departed_at IS NULL AND revoked_at IS NULL
     AND EXISTS (SELECT 1 FROM apps a WHERE a.id = grants.app_id)
     AND NOT hadron_agent_installed_in_app(grants.app_id, grants.agent_id)
     AND NOT (activated_at IS NOT NULL AND ((expires_at IS NOT NULL AND expires_at <= (clock_timestamp() AT TIME ZONE 'UTC'))
       OR (max_uses IS NOT NULL AND use_count >= max_uses)
       OR EXISTS (SELECT 1 FROM actions x WHERE x.name = grants.action
            AND ((x.max_uses IS NOT NULL AND grants.use_count >= x.max_uses)
              OR (x.lifetime_seconds IS NOT NULL
                  AND grants.activated_at + make_interval(secs => x.lifetime_seconds) <= (clock_timestamp() AT TIME ZONE 'UTC'))))));
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS agent_imports_grant_parent_gone ON agent_imports;
CREATE TRIGGER agent_imports_grant_parent_gone AFTER DELETE ON agent_imports
FOR EACH ROW EXECUTE FUNCTION hadron_grant_import_parent_gone();

-- GRANT EVENTS. Each event is bound to its grant's App at insert: the grant must exist and be in the event's App (#3690;
-- the event's own app_id carries the cascade, so an event naming another App's grant would outlive, or be deleted with, the wrong one).
-- Append-only: no UPDATE (an INSERT ... ON CONFLICT DO UPDATE rewrite is an UPDATE), and a DELETE only
-- once the App is gone. Actor, worker, session and run ids carry no foreign key: sealed history (mergeUsers leaves the
-- actors alone; worker and session ids are fenced at write time by the #1162 migration).
ALTER TABLE grant_events DROP CONSTRAINT IF EXISTS chk_grant_events_shape;
ALTER TABLE grant_events ADD CONSTRAINT chk_grant_events_shape CHECK (
  action IN ('CREATE', 'ACTIVATE', 'REVOKE', 'WITHDRAW', 'USE') AND grant_id <> '' AND (actor_user_id IS NULL OR actor_user_id <> '')
);
CREATE OR REPLACE FUNCTION hadron_append_only_grant_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM apps WHERE id = OLD.app_id) THEN
      RAISE EXCEPTION 'grant events are append-only' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'grant events are append-only' USING ERRCODE = '23514';
END $$;
CREATE OR REPLACE FUNCTION hadron_bind_grant_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM grants g WHERE g.id = NEW.grant_id AND g.app_id = NEW.app_id) THEN
    RAISE EXCEPTION 'a grant event must name a grant of its own App' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS grant_events_bind_app ON grant_events;
CREATE TRIGGER grant_events_bind_app BEFORE INSERT ON grant_events
FOR EACH ROW EXECUTE FUNCTION hadron_bind_grant_event();
DROP TRIGGER IF EXISTS grant_events_append_only ON grant_events;
CREATE TRIGGER grant_events_append_only BEFORE UPDATE OR DELETE ON grant_events
FOR EACH ROW EXECUTE FUNCTION hadron_append_only_grant_event();

-- ACTIONS. Written only by the deploy-time upsert (src/lib/grants/actions.ts); this CHECK keeps a row well formed.
ALTER TABLE actions DROP CONSTRAINT IF EXISTS chk_actions_shape;
ALTER TABLE actions ADD CONSTRAINT chk_actions_shape CHECK (
  name <> '' AND source <> '' AND issuer_rule <> '' AND summary_template <> '' AND
  enforcement IN ('SERVER', 'CREDENTIAL', 'HARNESS_INSTRUCTION', 'RECORDED_ONLY') AND
  (max_uses IS NULL OR max_uses > 0) AND (lifetime_seconds IS NULL OR lifetime_seconds > 0)
);
