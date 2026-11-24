-- #5096: pin the search path of every guard function (same class as #5089). Read qualification only: no row is refused or changed.
-- Expand-safe, and the premise is checked here, not assumed: the previous image runs against this schema (the same functions, the same
-- results) only if every guard resolves its names in `public`, so the block below refuses (SQLSTATE HDPRF: boot logs it, serves the
-- schema it has and retries on the next boot) when an application table, view or sequence lives in another schema. It takes no table lock:
-- ALTER FUNCTION touches the function's catalog row only.
-- One source, shared verbatim with prisma/guard-search-path-invariants.sql.

-- #5096 (same class as #5089): pin the schema search path of every guard function, so a session-local (pg_temp) table or function
-- of the same name cannot stand in for the real one a guard reads. One source: the newest migration to carry it (today
-- 20261124210000_guard_function_search_path) ends with it verbatim (pinned by src/lib/guardSearchPath5096.test.ts), and post-push.sql
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
