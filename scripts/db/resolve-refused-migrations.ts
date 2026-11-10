/**
 * #3770: a migration whose preflight REFUSES on data must not become an outage.
 *
 * `prisma migrate deploy` records a failed migration as an unfinished ledger row
 * and then refuses every later deploy with P3009, so a refusal at boot used to be
 * a crash loop (the 2026-11-08 outage, #3236). Boot (scripts/docker-start.sh)
 * calls this after a failed deploy. It prints the names of the unfinished
 * migrations, one per line, ONLY when every one of them failed with the refusal
 * SQLSTATE below; the entrypoint then marks each rolled back, raises a structured
 * alarm and keeps serving the schema that exists. Any other failure (a syntax
 * error, a lost connection, a half-applied change) prints nothing and exits 1, so
 * boot still stops on it.
 *
 * CONVENTION for a refusing preflight: raise with this SQLSTATE,
 *   RAISE EXCEPTION '...' USING ERRCODE = 'HDPRF';
 * Prisma stores the database error code in the ledger row's logs, which is what
 * this reads. The code does not itself prove nothing was applied: that holds because
 * Prisma runs a migration file as one implicit transaction, so a refusal rolls back
 * every statement above it. A refusing migration must therefore not use BEGIN, COMMIT,
 * CONCURRENTLY or anything else that ends that transaction (pinned in
 * refused-migration-boot.test.ts). A migration that raises with any other code keeps the old behaviour.
 */
import { Client } from 'pg';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { CONNECT_TIMEOUT_MS } from './revoke-runtime-migrations.js';

/** The SQLSTATE a refusing preflight raises (class-less, so it cannot collide with a built-in code). */
export const REFUSAL_SQLSTATE = 'HDPRF';
/** Prisma migration directory names: the only shape that is ever printed. */
const MIGRATION_NAME = /^[0-9]{14}_[A-Za-z0-9_]+$/;

export interface UnfinishedMigration { migration_name: string; logs: string | null }

/** The refused migrations, or null when ANY unfinished migration is not a refusal (or none is). */
export function refusedMigrationNames(rows: UnfinishedMigration[]): string[] | null {
  if (rows.length === 0) return null;
  const marker = new RegExp(`^Database error code: ${REFUSAL_SQLSTATE}$`, 'm');
  const names: string[] = [];
  for (const row of rows) {
    if (!MIGRATION_NAME.test(row.migration_name) || !marker.test(row.logs ?? '')) return null;
    names.push(row.migration_name);
  }
  return names;
}

/**
 * #3794: the unfinished migrations that are NOT all refusals, by name only. A malformed name is dropped, never
 * printed (the ledger is data, and command output may carry URLs); the `logs` blob (SQL text, driver errors) is
 * never read into the answer.
 */
export function failedMigrationNames(rows: UnfinishedMigration[]): string[] {
  return rows.map(row => row.migration_name).filter(name => MIGRATION_NAME.test(name));
}

export async function main(env: NodeJS.ProcessEnv, out: (names: string[]) => void, log: (line: string) => void,
  connectionTimeoutMillis = CONNECT_TIMEOUT_MS, outFailed: (names: string[]) => void = () => undefined): Promise<number> {
  const connectionString = env.MIGRATE_DATABASE_URL || env.DATABASE_URL;
  if (!connectionString) {
    log('db.migration.resolve_database_url_missing');
    return 2;
  }
  const client = new Client({ connectionString, connectionTimeoutMillis });
  try {
    await client.connect();
    const found = await client.query<UnfinishedMigration>(
      `SELECT migration_name, logs FROM public._prisma_migrations
       WHERE finished_at IS NULL AND rolled_back_at IS NULL ORDER BY started_at`);
    const names = refusedMigrationNames(found.rows);
    if (!names) {
      outFailed(failedMigrationNames(found.rows));
      return 1;
    }
    out(names);
    return 0;
  } catch {
    // Never print pg errors: drivers can include credentials/connection URLs.
    log('db.migration.resolve_failed');
    return 1;
  } finally {
    await client.end().catch(() => undefined);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  // The names go to a FILE when the entrypoint names one: `pnpm tsx ...` prints its own banner lines
  // ("Already up to date", "Done in ...") on stdout, which a captured stdout cannot tell from an answer (#3770 QA).
  const file = process.env.REFUSED_MIGRATIONS_FILE;
  // #3794: a non-refusal failure names its migrations in a second private file, for the entrypoint's one failure line.
  const failedFile = process.env.FAILED_MIGRATIONS_FILE;
  process.exitCode = await main(process.env,
    names => (file ? writeFileSync(file, `${names.join('\n')}\n`) : console.log(names.join('\n'))),
    line => console.error(line), CONNECT_TIMEOUT_MS,
    names => { if (failedFile && names.length) writeFileSync(failedFile, `${names.join('\n')}\n`); });
}
