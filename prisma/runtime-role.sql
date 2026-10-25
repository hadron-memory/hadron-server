-- Runtime (serve) role grants — #2413 S1 (plan §3.2/§3.3).
--
-- Run by the OWNER/migrator role (the role that owns every `public` relation),
-- never by the serve role and not inside a Prisma migration: roles are
-- cluster-level, absent in dev/CI/self-hosted databases, and creating one needs
-- CREATEROLE, which the migrator lacks. The serve role is created once, by a
-- superuser, as a host step; this file only grants.
--
--   psql "$MIGRATE_DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/runtime-role.sql
--   psql "$MIGRATE_DATABASE_URL" -v ON_ERROR_STOP=1 -v serve_role=other_name -f prisma/runtime-role.sql
--
-- `serve_role` defaults to `hadron_app`. The script is idempotent and re-runnable
-- while the server is serving: every table's privileges are reset and regranted
-- inside ONE transaction, so no session ever sees a table with no grant.
--
-- It fails loudly (exception, non-zero psql exit under ON_ERROR_STOP) when the
-- serve role does not exist. It never creates it.
--
-- What the serve role gets: CONNECT, USAGE on `public`, SELECT/INSERT/UPDATE/
-- DELETE on an EXPLICIT list of tables (every ordinary/partitioned `public`
-- relation EXCEPT `_prisma_migrations`; `GRANT ... ON ALL TABLES` would include
-- it), USAGE/SELECT on sequences, and default privileges so a table the owner's
-- next migration creates works with no follow-up step. It never gets CREATE,
-- TRUNCATE, TRIGGER, REFERENCES or MAINTAIN.
--
-- `_prisma_migrations` hazard: if this runs BEFORE the first `migrate deploy`,
-- the default privileges below grant DML on that table when migrate creates it.
-- Re-run this file (or just the final REVOKE) after `migrate deploy`; the
-- verifier (scripts/db/verify-runtime-role.ts) fails until it has run.

\if :{?serve_role}
\else
  \set serve_role hadron_app
\endif

-- DO bodies are dollar-quoted, so psql cannot interpolate into them; hand the
-- name over as a transaction-local setting instead.
BEGIN;
SELECT set_config('hadron.serve_role', :'serve_role', true);

DO $grants$
DECLARE
  serve   text := current_setting('hadron.serve_role');
  owner   text := current_user;
  tbl     record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = serve) THEN
    RAISE EXCEPTION 'runtime-role: serve role "%" does not exist; a superuser must create it first (plan 2413 section 3.3)', serve
      USING ERRCODE = 'undefined_object';
  END IF;

  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), serve);
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', serve);
  -- Revokes only what was granted to the serve role itself. A CREATE that
  -- PUBLIC still holds is not ours to remove here; the verifier reports it.
  EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', serve);
  EXECUTE format('REVOKE CREATE ON DATABASE %I FROM %I', current_database(), serve);

  FOR tbl IN
    SELECT c.oid::regclass AS rel
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p')
       AND c.relname <> '_prisma_migrations'
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE %s FROM %I', tbl.rel, serve);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %s TO %I', tbl.rel, serve);
  END LOOP;

  EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', serve);
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', serve);

  -- Applies to objects created by the role running this script (the migrator),
  -- which must stay the only creator.
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', owner, serve);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I', owner, serve);

  -- Belt and braces, and the order fix: the table may exist now even though the
  -- loop above skipped it, and a default privilege may have granted it.
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    EXECUTE format('REVOKE ALL ON TABLE public._prisma_migrations FROM %I', serve);
  END IF;
END
$grants$;

COMMIT;
