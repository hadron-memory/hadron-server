-- #3668 (S1a): the database half of the grant row, its events and the actions table. One source, shared verbatim with the
-- end of migration 20261107010000_grants (pinned by src/lib/grants/grantRow3668.test.ts) and applied by post-push.sql
-- and the test globalSetup.
--
-- GRANTS. Exactly one holder (a user, an agent, a worker or an App); the CHECK cannot pass on NULL, because
-- num_nonnulls() is never NULL. The holder ids are SEALED (no foreign key, #3690 S2a-h): a holder that goes ENDS its grant and
-- the record stays (cor:acl:140:03, ruling 0255 item 3), so the id must outlive the row, and SET NULL would break the CHECK.
-- The kind of holder is the column that is set; `holder_departed_at` is the end. An INSERT must name a holder that exists and
-- has not gone (a FOR SHARE read, the lock a foreign key took), so a new row cannot race a holder's departure. A row ARRIVES PENDING: no activation, verification, signature, revocation or use, so no
-- path can mint a live row (ruling 0099, the database half). After that a row is never edited. The only moves are:
--   * it ends ONCE, by revoked_at stamped together with revoked_by, or by its HOLDER going: holder_departed_at is stamped
--     (NULL to a time, never back) by the AFTER DELETE triggers below on every hard delete of a holder row, and by the
--     deleting code on the soft deletes (an erased person, a retired worker, a deleted agent or App). The first end stands:
--     a row already revoked, departed, expired or spent (an ACTIVATED row past its expiry or at its count) is not stamped (ruling 0259);
--   * an erased issuer's link goes: issuer_user_id becomes NULL and the reason stays (cor:acl:140:08), and only when that
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
  version >= 1 AND
  (starts_at IS NULL OR expires_at IS NULL OR starts_at < expires_at) AND
  (revoked_at IS NULL) = (revoked_by IS NULL) AND
  (revoked_by IS NULL OR revoked_by <> '')
);
-- True when `old_id` was merged into `new_id` (a recorded merge), the only proof a person link may move on.
CREATE OR REPLACE FUNCTION hadron_grant_link_merged(old_id text, new_id text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT old_id IS NOT NULL AND new_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM user_merges m WHERE m.source_user_id = old_id AND m.target_user_id = new_id)
$$;
CREATE OR REPLACE FUNCTION hadron_guard_grant() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  -- Columns that may differ between OLD and NEW; each is judged by its own rule below.
  movable text[] := ARRAY['updated_at', 'user_id', 'issuer_user_id', 'requested_by_user_id', 'verified_by', 'revoked_at', 'revoked_by', 'holder_departed_at'];
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
       OR NEW.use_count <> 0 OR NEW.version <> 1 OR NEW.holder_departed_at IS NOT NULL THEN
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
       EXISTS (SELECT 1 FROM users u WHERE u.id = OLD.user_id AND u.deleted_at IS NULL)
    OR EXISTS (SELECT 1 FROM agents a WHERE a.id = OLD.agent_id AND a.deleted_at IS NULL)
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
  IF (NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id
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
  EXECUTE format(
    'UPDATE grants SET holder_departed_at = (clock_timestamp() AT TIME ZONE ''UTC''), updated_at = (clock_timestamp() AT TIME ZONE ''UTC'')
      WHERE %I = $1 AND holder_departed_at IS NULL AND revoked_at IS NULL
        AND EXISTS (SELECT 1 FROM apps a WHERE a.id = grants.app_id)
        AND NOT (activated_at IS NOT NULL AND ((expires_at IS NOT NULL AND expires_at <= (clock_timestamp() AT TIME ZONE ''UTC''))
          OR (max_uses IS NOT NULL AND use_count >= max_uses)))', TG_ARGV[0]) USING OLD.id;
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

-- GRANT EVENTS. Each event is bound to its grant's App at insert: the grant must exist and be in the event's App (#3690;
-- the event's own app_id carries the cascade, so an event naming another App's grant would outlive, or be deleted with, the wrong one).
-- Append-only: no UPDATE (an INSERT ... ON CONFLICT DO UPDATE rewrite is an UPDATE), and a DELETE only
-- once the App is gone. Actor, worker, session and run ids carry no foreign key: sealed history (mergeUsers leaves the
-- actors alone; worker and session ids are fenced at write time by the #1162 migration).
ALTER TABLE grant_events DROP CONSTRAINT IF EXISTS chk_grant_events_shape;
ALTER TABLE grant_events ADD CONSTRAINT chk_grant_events_shape CHECK (
  action IN ('CREATE', 'ACTIVATE', 'REVOKE', 'USE') AND grant_id <> '' AND (actor_user_id IS NULL OR actor_user_id <> '')
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
  enforcement IN ('SERVER', 'CREDENTIAL', 'HARNESS_INSTRUCTION', 'RECORDED_ONLY')
);
