/** #2445: close the default-ACL creation-order hole after migrate deploy. */
import { Client, escapeIdentifier } from 'pg';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SERVE_ROLE } from './verify-runtime-role.js';

/**
 * Bound on the TCP connect + startup handshake. pg's default is no timeout, so a
 * listener that accepts and never answers would hang boot forever. This is a
 * connection-attempt bound only: no query deadline, and the warn-only verifier
 * policy is unchanged.
 */
export const CONNECT_TIMEOUT_MS = 15_000;

/** Owner-only, psql-free. Absent serve role preserves legacy single-role installs. */
export async function revokeRuntimeMigrations(client: Client, role: string): Promise<void> {
  const found = await client.query<{ is_current_user: boolean; owns_migrations: boolean; revoke_actions: boolean; revoke_secret_events: boolean }>(`
    SELECT r.rolname = current_user AS is_current_user,
      EXISTS (SELECT 1 FROM pg_class c
        WHERE c.oid = to_regclass('public._prisma_migrations') AND c.relowner = r.oid) AS owns_migrations,
      -- Only the table's own owner can revoke on it, and a serve role that IS the owner keeps its own privileges.
      EXISTS (SELECT 1 FROM pg_class c
        WHERE c.oid = to_regclass('public.actions') AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
          AND c.relowner <> r.oid) AS revoke_actions,
      -- #3997: the same for the append-only audit table.
      EXISTS (SELECT 1 FROM pg_class c
        WHERE c.oid = to_regclass('public.secret_events') AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
          AND c.relowner <> r.oid) AS revoke_secret_events
    FROM pg_roles r WHERE r.rolname = $1`, [role]);
  const target = found.rows[0];
  // Legacy/self-hosted installs may use the configured serve name as OWNER.
  // Owners can revoke their own ordinary privileges: preserve migration access
  // on both the current connection and future boots, including rollback.
  if (target && !target.is_current_user && !target.owns_migrations) {
    // Role is configurable like S1; escapeIdentifier quotes it as ONE identifier.
    // The relation is fixed, and no other grants/default privileges are touched.
    await client.query(`REVOKE ALL PRIVILEGES ON TABLE public._prisma_migrations FROM ${escapeIdentifier(role)}`);
  }
  // #3668 (S1a): the serve role may READ `actions` but never write it (the deploy-time upsert runs as the owner). Default
  // ACLs grant DML to every new table, so it is revoked here, after migrate, exactly like the ledger above. A role that owns
  // the table (a single-role install) keeps its own privileges.
  if (target && !target.is_current_user && target.revoke_actions) {
    await client.query(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.actions FROM ${escapeIdentifier(role)}`);
  }
  // #3997 (R25): `secret_events` is append-only. The serve role keeps INSERT, SELECT and DELETE (the one-year purge runs as the serve
  // role; the guard trigger refuses every other delete) and loses UPDATE and TRUNCATE, which the default ACLs grant to a new table.
  if (target && !target.is_current_user && target.revoke_secret_events) {
    await client.query(`REVOKE UPDATE, TRUNCATE ON TABLE public.secret_events FROM ${escapeIdentifier(role)}`);
  }
}

export async function main(env: NodeJS.ProcessEnv, log: (line: string) => void,
  connectionTimeoutMillis = CONNECT_TIMEOUT_MS): Promise<number> {
  const connectionString = env.MIGRATE_DATABASE_URL || env.DATABASE_URL;
  if (!connectionString) {
    log('db.runtime_role.revoke_database_url_missing');
    return 2;
  }
  const client = new Client({ connectionString, connectionTimeoutMillis });
  try {
    await client.connect();
    await revokeRuntimeMigrations(client, env.RUNTIME_ROLE_NAME || DEFAULT_SERVE_ROLE);
    return 0;
  } catch {
    // Never print pg errors: drivers can include credentials/connection URLs.
    log('db.runtime_role.revoke_failed');
    return 1;
  } finally {
    await client.end().catch(() => undefined);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main(process.env, line => console.error(line));
}
