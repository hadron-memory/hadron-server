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
