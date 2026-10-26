/** #2445: close the default-ACL creation-order hole after migrate deploy. */
import { Client, escapeIdentifier } from 'pg';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SERVE_ROLE } from './verify-runtime-role.js';

/**
 * How long the revoke helper waits to establish its connection (TCP connect and startup handshake). Without it
 * pg waits indefinitely on a stalled server and boot hangs before the server starts. A timeout is the same
 * typed `revoke_failed` result as any other connection failure; no query deadline is set here, and the
 * verifier's warn-only policy is unchanged.
 */
export const CONNECT_TIMEOUT_MS = 10_000;

/** Owner-only, psql-free. Absent serve role preserves legacy single-role installs. */
export async function revokeRuntimeMigrations(client: Client, role: string): Promise<void> {
  const found = await client.query<{ is_current_user: boolean; owns_migrations: boolean }>(`
    SELECT r.rolname = current_user AS is_current_user,
      EXISTS (SELECT 1 FROM pg_class c
        WHERE c.oid = to_regclass('public._prisma_migrations') AND c.relowner = r.oid) AS owns_migrations
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
}

export async function main(
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
  { connectionTimeoutMillis = CONNECT_TIMEOUT_MS }: { connectionTimeoutMillis?: number } = {},
): Promise<number> {
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
