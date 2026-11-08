-- #3668 (S1a): the database half of the grant row, its events and the actions table. One source, shared verbatim with the
-- end of migration 20261107010000_grants (pinned by src/lib/grants/grantRow3668.test.ts) and applied by post-push.sql
-- and the test globalSetup.
--
-- GRANTS. Exactly one holder (a user, an agent, a worker or an App); the CHECK cannot pass on NULL, because
-- num_nonnulls() is never NULL. A row ARRIVES PENDING: no activation, verification, signature, revocation or use, so no
-- path can mint a live row (ruling 0099, the database half). After that a row is never edited. The only moves are:
--   * it ends ONCE, by revoked_at stamped together with revoked_by;
--   * an erased issuer's link goes: issuer_user_id becomes NULL and the reason stays (cor:acl:140:08);
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
  movable text[] := ARRAY['updated_at', 'user_id', 'issuer_user_id', 'requested_by_user_id', 'verified_by', 'revoked_at', 'revoked_by'];
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
       OR NEW.use_count <> 0 OR NEW.version <> 1 THEN
      RAISE EXCEPTION 'grants must arrive pending' USING ERRCODE = '23514';
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
  -- An erased issuer's link goes (cor:acl:140:08). Any other move of a person link must follow a recorded merge.
  IF NEW.issuer_user_id IS DISTINCT FROM OLD.issuer_user_id
     AND NOT (NEW.issuer_user_id IS NULL AND OLD.issuer_user_id IS NOT NULL)
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

-- GRANT EVENTS. Append-only: no UPDATE (an INSERT ... ON CONFLICT DO UPDATE rewrite is an UPDATE), and a DELETE only
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
DROP TRIGGER IF EXISTS grant_events_append_only ON grant_events;
CREATE TRIGGER grant_events_append_only BEFORE UPDATE OR DELETE ON grant_events
FOR EACH ROW EXECUTE FUNCTION hadron_append_only_grant_event();

-- ACTIONS. Written only by the deploy-time upsert (src/lib/grants/actions.ts); this CHECK keeps a row well formed.
ALTER TABLE actions DROP CONSTRAINT IF EXISTS chk_actions_shape;
ALTER TABLE actions ADD CONSTRAINT chk_actions_shape CHECK (
  name <> '' AND source <> '' AND issuer_rule <> '' AND summary_template <> '' AND
  enforcement IN ('SERVER', 'CREDENTIAL', 'HARNESS_INSTRUCTION', 'RECORDED_ONLY')
);
