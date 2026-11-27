-- #5335 (hrn:node:hadronmemory.com:specs:cor:sec:060:03): the per-secret option deleteAfterUse, default false, so no
-- existing secret changes behaviour (nothing migrates: an existing protected secret with a marked client is armed only
-- by its owner setting the option). expand-safe: the previous image never reads the column, and the widened operation
-- set only admits more rows. Then the change-request objects file, verbatim, for the two new operation kinds.
ALTER TABLE secrets ADD COLUMN IF NOT EXISTS delete_after_use boolean NOT NULL DEFAULT false;
-- #3999 change-request objects: prisma/secret-change-requests-invariants.sql, included by post-push.sql and copied
-- verbatim into the newest migration that carries it (today 20261127090000_secret_delete_after_use, #5335; first
-- 20261120180000_secret_change_requests, #4717 item 4). Every statement is idempotent, so they apply in either order, twice.
-- #3999: staged values are request-bound; terminal requests retain no ciphertext.
CREATE TABLE IF NOT EXISTS secret_change_requests (
 id text PRIMARY KEY,
 app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE ON UPDATE CASCADE,
 secret_id text,
 secret_name text NOT NULL,
 secret_kind text NOT NULL,
 metadata jsonb NOT NULL,
 operation text NOT NULL,
 requester_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
 state text NOT NULL DEFAULT 'open',
 snapshot text NOT NULL,
 staged_value_encrypted text,
 key_version integer,
 size_bytes integer,
 protected_result boolean,
 write_version boolean NOT NULL DEFAULT true,
 created_at timestamp(3) NOT NULL DEFAULT (clock_timestamp() AT TIME ZONE 'UTC'),
 expires_at timestamp(3) NOT NULL,
 ended_at timestamp(3)
);
ALTER TABLE secret_change_requests DROP CONSTRAINT IF EXISTS chk_secret_change_shape;
ALTER TABLE secret_change_requests ADD CONSTRAINT chk_secret_change_shape CHECK (
 operation IN ('STORE','DELETE','SET_PROTECTED','CLEAR_PROTECTED','SET_DELETE_AFTER_USE','CLEAR_DELETE_AFTER_USE') AND
 state IN ('open','completed','declined','expired','withdrawn','stale') AND
 ((staged_value_encrypted IS NOT NULL) = (operation = 'STORE' AND write_version AND state = 'open')) AND
 ((staged_value_encrypted IS NULL) OR (key_version IS NOT NULL AND size_bytes IS NOT NULL)) AND
 ((state = 'open') = (ended_at IS NULL))
);
CREATE INDEX IF NOT EXISTS secret_change_requests_secret_open ON secret_change_requests(app_id,secret_name,state);
CREATE INDEX IF NOT EXISTS secret_change_requests_expiry ON secret_change_requests(expires_at) WHERE state = 'open';
CREATE OR REPLACE FUNCTION hadron_guard_secret_change_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'UPDATE' THEN
  IF OLD.state <> 'open' OR
    (NEW.id,NEW.app_id,NEW.secret_id,NEW.secret_name,NEW.secret_kind,NEW.metadata,NEW.operation,NEW.requester_id,NEW.snapshot,NEW.created_at,NEW.expires_at,NEW.key_version,NEW.size_bytes,NEW.protected_result,NEW.write_version)
    IS DISTINCT FROM
    (OLD.id,OLD.app_id,OLD.secret_id,OLD.secret_name,OLD.secret_kind,OLD.metadata,OLD.operation,OLD.requester_id,OLD.snapshot,OLD.created_at,OLD.expires_at,OLD.key_version,OLD.size_bytes,OLD.protected_result,OLD.write_version)
  THEN RAISE EXCEPTION 'secret change request immutable'; END IF;
  IF NEW.state = 'open' AND NEW.staged_value_encrypted IS DISTINCT FROM OLD.staged_value_encrypted
  THEN RAISE EXCEPTION 'secret change request immutable'; END IF;
 END IF;
 IF NEW.state <> 'open' THEN NEW.staged_value_encrypted := NULL; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS secret_change_requests_guard ON secret_change_requests;
CREATE TRIGGER secret_change_requests_guard BEFORE INSERT OR UPDATE ON secret_change_requests
 FOR EACH ROW EXECUTE FUNCTION hadron_guard_secret_change_request();
-- External deletion (App deletion, auto-delete) must not leave staged copies behind.
CREATE OR REPLACE FUNCTION hadron_end_deleted_secret_changes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE secret_change_requests SET state='stale',ended_at=(clock_timestamp() AT TIME ZONE 'UTC')
 WHERE secret_id=OLD.id AND state='open';
 RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS secret_changes_secret_deleted ON secrets;
CREATE TRIGGER secret_changes_secret_deleted AFTER DELETE ON secrets FOR EACH ROW EXECUTE FUNCTION hadron_end_deleted_secret_changes();
CREATE OR REPLACE FUNCTION hadron_clear_deleted_app_changes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN DELETE FROM secret_change_requests WHERE app_id=NEW.id; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS secret_changes_app_deleted ON apps;
CREATE TRIGGER secret_changes_app_deleted AFTER UPDATE OF deleted_at ON apps FOR EACH ROW EXECUTE FUNCTION hadron_clear_deleted_app_changes();

-- #5335: the App-secret objects file, verbatim, for chk_secret_delete_after_use_app_only (deleteAfterUse on App rows only).
-- #3997 (S2 of #3991) — App-owned secrets: the widened owner CHECK, the value/owner pairing, versions bound to their
-- App, the append-only event trail with its one-year purge rule, the tombstone, and "no secret outlives its App".
-- Prisma cannot model any of these. One source; the newest migration to carry it (today 20261127090000_secret_delete_after_use, #5335; before it 20261124180200_qualify_secret_guard_reads) ends with it verbatim (pinned by src/api/graphql/schema/resolvers.appSecrets3997.test.ts).

-- The owner types: user, org, app. (#696 narrowed to user/org; D-2026-11-12-001 made an App an owner again.)
ALTER TABLE secrets DROP CONSTRAINT IF EXISTS chk_secret_owner_type;
ALTER TABLE secrets ADD CONSTRAINT chk_secret_owner_type CHECK (owner_type IN ('user', 'org', 'app'));

-- An App row has NO value of its own (its value is its newest version); an org or user row always has one.
ALTER TABLE secrets DROP CONSTRAINT IF EXISTS chk_secret_app_value;
ALTER TABLE secrets ADD CONSTRAINT chk_secret_app_value CHECK ((owner_type = 'app') = (value_encrypted IS NULL));
ALTER TABLE secrets DROP CONSTRAINT IF EXISTS chk_secret_protected_app_only;
ALTER TABLE secrets ADD CONSTRAINT chk_secret_protected_app_only CHECK (owner_type = 'app' OR NOT protected);
-- #5335 (cor:sec:060:03): deleteAfterUse, like protection, exists only on App rows.
ALTER TABLE secrets DROP CONSTRAINT IF EXISTS chk_secret_delete_after_use_app_only;
ALTER TABLE secrets ADD CONSTRAINT chk_secret_delete_after_use_app_only CHECK (owner_type = 'app' OR NOT delete_after_use);

ALTER TABLE secret_versions DROP CONSTRAINT IF EXISTS chk_secret_version_shape;
ALTER TABLE secret_versions ADD CONSTRAINT chk_secret_version_shape
  CHECK (version_no >= 1 AND size_bytes >= 0 AND value_encrypted <> '' AND key_version >= 1);

-- A version's App is its secret's owner, and that owner is an App (owner_id is not a foreign key, so a trigger).
CREATE OR REPLACE FUNCTION hadron_secret_version_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.secrets WHERE id = NEW.secret_id AND owner_type = 'app' AND owner_id = NEW.app_id) THEN
    RAISE EXCEPTION 'A secret version belongs to the App that owns its secret' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS secret_version_owner ON secret_versions;
CREATE TRIGGER secret_version_owner BEFORE INSERT OR UPDATE OF secret_id, app_id ON secret_versions
FOR EACH ROW EXECUTE FUNCTION hadron_secret_version_owner();

-- Append-only events. Update is never allowed. Delete is allowed only for the one-year purge (R25): the owner has a
-- tombstone at least a year old and is not a live App.
CREATE OR REPLACE FUNCTION hadron_secret_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND EXISTS (SELECT 1 FROM public.secret_owner_tombstones t
                 WHERE t.owner_type = OLD.owner_type AND t.owner_id = OLD.owner_id
                   AND t.deleted_at <= (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 year')
     AND NOT EXISTS (SELECT 1 FROM public.apps a WHERE a.id = OLD.owner_id AND a.deleted_at IS NULL) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Secret events are append-only' USING ERRCODE = '23514';
END $$;
DROP TRIGGER IF EXISTS secret_event_append_only ON secret_events;
CREATE TRIGGER secret_event_append_only BEFORE UPDATE OR DELETE ON secret_events
FOR EACH ROW EXECUTE FUNCTION hadron_secret_event_guard();

-- A tombstone is written once and never updated; it is deleted only after its year, and only when its owner has no
-- events left (the purge deletes it last).
CREATE OR REPLACE FUNCTION hadron_secret_tombstone_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND OLD.deleted_at <= (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 year'
     AND NOT EXISTS (SELECT 1 FROM public.secret_events e WHERE e.owner_type = OLD.owner_type AND e.owner_id = OLD.owner_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'A secret owner tombstone is written once and kept until its events are purged' USING ERRCODE = '23514';
END $$;
DROP TRIGGER IF EXISTS secret_owner_tombstone_guard ON secret_owner_tombstones;
CREATE TRIGGER secret_owner_tombstone_guard BEFORE UPDATE OR DELETE ON secret_owner_tombstones
FOR EACH ROW EXECUTE FUNCTION hadron_secret_tombstone_guard();

-- R20 + R25: no App row is deleted, by any path (deleteApp's reclaim, account erasure, a URN reclaim), while its secrets
-- or their ciphertext survive. Runs BEFORE the row goes, so the versions are gone before the cascade reaches the
-- restricted key rows. An owner that has events and no tombstone yet gets one now (a soft delete's tombstone stands).
CREATE OR REPLACE FUNCTION hadron_apps_secrets_gone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.secret_owner_tombstones (owner_type, owner_id)
    SELECT 'app', OLD.id WHERE EXISTS (SELECT 1 FROM public.secret_events WHERE owner_type = 'app' AND owner_id = OLD.id)
    ON CONFLICT DO NOTHING;
  DELETE FROM public.secrets WHERE owner_type = 'app' AND owner_id = OLD.id;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS apps_secrets_gone ON apps;
CREATE TRIGGER apps_secrets_gone BEFORE DELETE ON apps
FOR EACH ROW EXECUTE FUNCTION hadron_apps_secrets_gone();

-- #1162: the worker and session ids these tables record are typed references, under the same writer fence as every other one.
-- The fence function exists from migration 20261016050000; this file is applied after it.
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "secrets";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "secrets"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.created_by_worker_id', 's:$.created_by_session_id');
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "secret_versions";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "secret_versions"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.written_by_worker_id', 's:$.written_by_session_id');
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "secret_events";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "secret_events"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.worker_id', 's:$.session_id');
-- #5096: the functions re-created above get their search_path pinned again; the loop below, verbatim.
-- #5096 (same class as #5089): pin the schema search path of every guard function, so a session-local (pg_temp) table or function
-- of the same name cannot stand in for the real one a guard reads. One source: the newest migration to carry it (today
-- 20261125000000_guard_function_search_path) ends with it verbatim (pinned by src/lib/guardSearchPath5096.test.ts), and post-push.sql
-- applies it LAST, after every file that (re)creates a function: CREATE OR REPLACE FUNCTION without a SET clause resets a function's
-- configuration, so this must run after them.
--
-- Read qualification only: no gate logic, trigger condition or CHECK semantics change. `public, pg_temp` lists pg_temp LAST, so the
-- temp schema is searched after public and never before it (pg_catalog is always first).
--
-- The premise, enforced and not assumed: every guard resolves its names inside `public`. Pinning the path is behaviour-neutral only if
-- no relation the application owns lives in another schema, so the loop REFUSES (SQLSTATE HDPRF: boot serves the schema it has and logs
-- the refusal, nothing is pinned) when a table, view, sequence or foreign table of another non-system, non-extension schema exists. On
-- the development and test databases and on a migrate-built database every function body was swept and none names another schema.
--
-- Scope: every function in schema public that is not extension-owned and has no search_path setting yet (another SET, such as work_mem,
-- does not exempt it). IMMUTABLE functions are included: Postgres does not enforce "immutable means reads no table", and pinning one
-- changes nothing a caller can see. Procedures and aggregates are out of the loop; src/lib/guardSearchPath5096.test.ts proves none
-- exist in public. A function the migrating role cannot alter (not its own, or a member's) is skipped with a NOTICE and then named by
-- that test, instead of aborting the deploy. A new function must carry `SET search_path = public, pg_temp` in its own CREATE or be
-- covered by a later migration that re-runs this loop; the test is red on any that is neither.
DO $guard_search_path$
DECLARE
  f record;
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
       AND n.nspname NOT IN ('public', 'pg_catalog', 'information_schema')
       AND n.nspname NOT LIKE 'pg\_toast%'
       AND n.nspname NOT LIKE 'pg\_temp%'
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')
  ) THEN
    RAISE EXCEPTION 'guard search_path: an application relation lives outside schema public, so pinning the path could change what a guard reads; nothing was pinned'
      USING ERRCODE = 'HDPRF';
  END IF;
  FOR f IN
    SELECT p.oid AS fn_oid, pg_catalog.pg_has_role(current_user, p.proowner, 'USAGE') AS alterable
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prokind = 'f'
       AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}'::text[])) AS c WHERE c LIKE 'search_path=%')
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  LOOP
    IF f.alterable THEN
      EXECUTE pg_catalog.format('ALTER FUNCTION %s SET search_path = public, pg_temp', f.fn_oid::regprocedure);
    ELSE
      RAISE NOTICE 'guard search_path: % is not owned by the migrating role and was not pinned', f.fn_oid::regprocedure;
    END IF;
  END LOOP;
END
$guard_search_path$;
