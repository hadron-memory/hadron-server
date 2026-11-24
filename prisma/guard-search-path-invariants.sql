-- #5096 (same class as #5089): pin the schema search path of every guard function, so a session-local (pg_temp) table or function
-- of the same name cannot stand in for the real one a guard reads. One source: the newest migration to carry it (today
-- 20261124190000_guard_function_search_path) ends with it verbatim (pinned by src/lib/guardSearchPath5096.test.ts), and post-push.sql
-- applies it LAST, after every file that (re)creates a function: CREATE OR REPLACE FUNCTION without a SET clause resets a function's
-- configuration, so this must run after them.
--
-- Read qualification only: no gate logic, trigger condition or CHECK semantics change. `public, pg_temp` lists pg_temp LAST, so the
-- temp schema is searched after public and never before it (pg_catalog is always first).
--
-- Scope: every function in schema public that is not extension-owned (pgvector's), not IMMUTABLE (an immutable function reads no
-- table) and not already configured. A new function must either carry `SET search_path = public, pg_temp` in its own CREATE or be
-- named by a later migration that re-runs this loop; src/lib/guardSearchPath5096.test.ts is red on any that does neither.
DO $guard_search_path$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prokind = 'f'
       AND p.provolatile <> 'i'
       AND p.proconfig IS NULL
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', f.sig);
  END LOOP;
END
$guard_search_path$;
