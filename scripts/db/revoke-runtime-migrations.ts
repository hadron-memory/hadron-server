/** #2445: close the default-ACL creation-order hole after migrate deploy. */
import { Client, escapeIdentifier } from 'pg';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SERVE_ROLE } from './verify-runtime-role.js';

/** Owner-only, psql-free. Absent serve role preserves legacy single-role installs. */
export async function revokeRuntimeMigrations(client: Client, role: string): Promise<void> {
  const found = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  if (found.rowCount) {
    // Role is configurable like S1; escapeIdentifier quotes it as ONE identifier.
    // The relation is fixed, and no other grants/default privileges are touched.
    await client.query(`REVOKE ALL PRIVILEGES ON TABLE public._prisma_migrations FROM ${escapeIdentifier(role)}`);
  }
}

export async function main(env: NodeJS.ProcessEnv, log: (line: string) => void): Promise<number> {
  const connectionString = env.MIGRATE_DATABASE_URL || env.DATABASE_URL;
  if (!connectionString) {
    log('db.runtime_role.revoke_database_url_missing');
    return 2;
  }
  const client = new Client({ connectionString });
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
