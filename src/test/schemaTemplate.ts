/**
 * #1922 — a test template is built for ONE schema version and never reused for
 * another.
 *
 * Before this, every checkout on a machine cloned the same `hadron_test` base,
 * and `pnpm db:test-setup` re-pushed it in place from whichever branch ran it
 * last. That failed in both directions (Chip's reproduction on #1922):
 *
 * - an OLDER branch's push silently drops a newer branch's columns, so the
 *   newer suite fails with P2022;
 * - the push never touches raw-SQL objects it does not know about, so the newer
 *   branch's trigger functions survive the downgrade and fire against rows
 *   that no longer have their columns ("The column `new` does not exist").
 *
 * A columns-only check would miss the second case, so the template is keyed by
 * a fingerprint of EVERYTHING that shapes it ({@link schemaFingerprint}), and is
 * built from an EMPTY database (`template0`). There is nothing left over to
 * keep, so a stale trigger has nowhere to survive.
 *
 * - **Parallel mode** (the default): `globalSetup` builds
 *   `<base>_s<fingerprint>` on first use and clones from it. Checkouts with
 *   different schemas get different templates, and a checkout never writes to
 *   one it did not fingerprint. Templates idle for {@link TEMPLATE_MAX_IDLE_MS}
 *   are dropped.
 * - **Serial mode** (`HADRON_TEST_PARALLEL=0`, for setups without CREATE
 *   DATABASE): the suite runs against the base itself, so `pnpm db:test-setup`
 *   rebuilds it from an empty `public` schema and stamps the fingerprint on it,
 *   and `globalSetup` refuses a base whose stamp does not match the checkout.
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from 'pg';
import { quoteDbIdent, withDbName, baseTestDbUrl, maintenanceUrl } from './dbWorkers.js';

const execFileAsync = promisify(execFile);

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Bump when {@link buildTestSchema}'s procedure changes in a way the input
 * files do not show, so existing templates are rebuilt rather than reused.
 */
export const TEMPLATE_BUILD_VERSION = 1;

/** A template not used by any run for this long is dropped by the next run. */
export const TEMPLATE_MAX_IDLE_MS = 7 * 24 * 60 * 60 * 1000;

const FINGERPRINT_LENGTH = 16;

/**
 * Fingerprint of everything that decides what a built test database contains:
 * `schema.prisma`, every top-level `prisma/*.sql` (pre-push, post-push and the
 * invariant files post-push includes, which carry the triggers and functions
 * Prisma cannot see), the Prisma CLI version that pushes it, and
 * {@link TEMPLATE_BUILD_VERSION}.
 */
export function schemaFingerprint(root = REPO_ROOT): string {
  const prismaDir = join(root, 'prisma');
  const files = [
    'schema.prisma',
    ...readdirSync(prismaDir)
      .filter((f) => f.endsWith('.sql'))
      .sort(),
  ];
  const hash = createHash('sha256');
  hash.update(`build:${TEMPLATE_BUILD_VERSION}\0`);
  hash.update(`prisma:${prismaVersion(root)}\0`);
  for (const file of files) {
    // Name and content, each length-delimited by a NUL, so moving bytes from
    // one file to another changes the hash.
    hash.update(`${file}\0`);
    hash.update(readFileSync(join(prismaDir, file)));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, FINGERPRINT_LENGTH);
}

function prismaVersion(root: string): string {
  const pkg = JSON.parse(readFileSync(join(root, 'node_modules/prisma/package.json'), 'utf8')) as {
    version: string;
  };
  return pkg.version;
}

/**
 * The template database for one fingerprint. The `_s` shape never parses as a
 * worker clone (`_r<run>_<pool>`) or a legacy clone (`_<digits>`), so neither
 * clone sweep can reach it.
 */
export function schemaTemplateDbName(fingerprint: string, base: string): string {
  return `${base}_s${fingerprint}`;
}

/** The fingerprint a `<base>_s<fingerprint>` name carries, or null for any other name. */
export function parseSchemaTemplateDbName(datname: string, base: string): string | null {
  const prefix = `${base}_s`;
  if (!datname.startsWith(prefix)) return null;
  const rest = datname.slice(prefix.length);
  return new RegExp(`^[0-9a-f]{${FINGERPRINT_LENGTH}}$`).test(rest) ? rest : null;
}

const STAMP_PREFIX = 'hadron-test-schema';

/** The database comment recording which fingerprint a database was built for, and when it was last used. */
export function templateStamp(fingerprint: string, usedAt: number): string {
  return `${STAMP_PREFIX} ${fingerprint} used ${usedAt}`;
}

/** Parse {@link templateStamp}; null for a missing or foreign comment. */
export function parseTemplateStamp(
  comment: string | null | undefined,
): { fingerprint: string; usedAt: number } | null {
  const m = new RegExp(`^${STAMP_PREFIX} ([0-9a-f]+) used ([0-9]+)$`).exec(comment ?? '');
  return m ? { fingerprint: m[1], usedAt: Number(m[2]) } : null;
}

/**
 * The schema templates to drop: another fingerprint's, unused for longer than
 * `maxIdleMs`. A template with no readable stamp is dropped too, since only a
 * build that died before stamping leaves one.
 */
export function staleSchemaTemplates(
  databases: { datname: string; comment: string | null }[],
  base: string,
  current: string,
  now: number,
  maxIdleMs = TEMPLATE_MAX_IDLE_MS,
): string[] {
  return databases
    .filter(({ datname, comment }) => {
      const fingerprint = parseSchemaTemplateDbName(datname, base);
      if (fingerprint === null || fingerprint === current) return false;
      const stamp = parseTemplateStamp(comment);
      return stamp === null || now - stamp.usedAt > maxIdleMs;
    })
    .map((d) => d.datname);
}

/**
 * Build this checkout's schema into the EMPTY database at `url`: pre-push.sql,
 * `prisma db push`, post-push.sql — the same three steps as `pnpm db:dev-setup`.
 * Output is kept quiet and surfaced only when a step fails.
 */
export async function buildTestSchema(url: string, root = REPO_ROOT): Promise<void> {
  const steps: [string, string, string[], NodeJS.ProcessEnv?][] = [
    ['pre-push.sql', 'psql', [url, '-q', '-v', 'ON_ERROR_STOP=1', '-f', 'prisma/pre-push.sql']],
    [
      'prisma db push',
      join(root, 'node_modules/.bin/prisma'),
      ['db', 'push', '--skip-generate', '--accept-data-loss'],
      { DATABASE_URL: url },
    ],
    ['post-push.sql', 'psql', [url, '-q', '-v', 'ON_ERROR_STOP=1', '-f', 'prisma/post-push.sql']],
  ];
  for (const [label, cmd, args, env] of steps) {
    try {
      await execFileAsync(cmd, args, {
        cwd: root,
        env: { ...process.env, ...env },
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (e) {
      const err = e as { code?: string; stdout?: string; stderr?: string };
      const missing = err.code === 'ENOENT' ? ` (\`${cmd}\` is not on PATH)` : '';
      throw new Error(
        `Building the test schema failed at ${label}${missing}.\n${err.stdout ?? ''}${err.stderr ?? ''}`,
        { cause: e },
      );
    }
  }
}

async function databaseComments(
  admin: Client,
): Promise<{ datname: string; comment: string | null }[]> {
  const { rows } = await admin.query<{ datname: string; comment: string | null }>(
    `SELECT datname, shobj_description(oid, 'pg_database') AS comment FROM pg_database`,
  );
  return rows;
}

/**
 * Return the template database for this checkout's schema, building it first if
 * it does not exist. The CALLER must hold the template advisory lock, which is
 * what makes the existence check and the build one step.
 *
 * The build happens under a scratch name and is renamed into place only once it
 * is complete and stamped, so the final name existing means the build finished:
 * a run that died mid-build leaves only the scratch name, which the next build
 * drops.
 */
export async function ensureSchemaTemplate(
  admin: Client,
  base: string,
  { fingerprint = schemaFingerprint(), now = Date.now() } = {},
): Promise<string> {
  const name = schemaTemplateDbName(fingerprint, base);
  const databases = await databaseComments(admin);

  for (const stale of staleSchemaTemplates(databases, base, fingerprint, now)) {
    // Not FORCE: under the lock nothing should be connected, and if something
    // is, leaving the database costs disk, while evicting it could break a run.
    await admin.query(`DROP DATABASE IF EXISTS ${quoteDbIdent(stale)}`).catch(() => {});
  }

  if (databases.some((d) => d.datname === name)) {
    await admin.query(`COMMENT ON DATABASE ${quoteDbIdent(name)} IS '${templateStamp(fingerprint, now)}'`);
    return name;
  }

  const building = `${name}_build`;
  await admin.query(`DROP DATABASE IF EXISTS ${quoteDbIdent(building)} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${quoteDbIdent(building)} TEMPLATE template0`);
  try {
    await buildTestSchema(withDbName(maintenanceUrl(), building));
    await admin.query(
      `COMMENT ON DATABASE ${quoteDbIdent(building)} IS '${templateStamp(fingerprint, now)}'`,
    );
    await admin.query(`ALTER DATABASE ${quoteDbIdent(building)} RENAME TO ${quoteDbIdent(name)}`);
  } catch (e) {
    await admin.query(`DROP DATABASE IF EXISTS ${quoteDbIdent(building)} WITH (FORCE)`).catch(() => {});
    throw e;
  }
  return name;
}

/**
 * Serial mode: refuse a base database that was not built for this checkout's
 * schema, naming the remedy. Run on a connection to the base itself.
 */
export async function assertBaseMatchesSchema(
  client: Client,
  fingerprint = schemaFingerprint(),
): Promise<void> {
  const { rows } = await client.query<{ datname: string; comment: string | null }>(
    `SELECT datname, shobj_description(oid, 'pg_database') AS comment
       FROM pg_database WHERE datname = current_database()`,
  );
  const stamp = parseTemplateStamp(rows[0]?.comment);
  if (stamp?.fingerprint === fingerprint) return;
  throw new Error(
    `The test database "${rows[0]?.datname}" was ${
      stamp ? `built for schema ${stamp.fingerprint}` : 'not built by `pnpm db:test-setup`'
    }, but this checkout's schema is ${fingerprint}. Running against it would mix ` +
      `two schema versions (#1922). Rebuild it with \`pnpm db:test-setup\`, or run in ` +
      `parallel mode, which builds a template per schema automatically.`,
  );
}

/**
 * `pnpm db:test-setup`: rebuild the serial-mode base from EMPTY and stamp it.
 * Empties the `public` schema rather than dropping the database, so it works
 * without CREATE DATABASE, which is the setup serial mode exists for.
 *
 * The old stamp is cleared BEFORE anything is dropped and the new one written
 * only after the build succeeds (#1923 review, Diego P2). Otherwise a rebuild
 * that fails or is interrupted part-way leaves a half-built database still
 * stamped for the previous schema, and that checkout's serial guard accepts it.
 * Unstamped, a failed rebuild is refused by every checkout until one succeeds.
 */
export async function rebuildBaseTestDb(
  url = baseTestDbUrl(),
  { build = buildTestSchema }: { build?: (url: string) => Promise<void> } = {},
): Promise<string> {
  const dbName = new URL(url).pathname.replace(/^\//, '');
  // This wipes the database, so refuse anything that is not a test database.
  if (!/test/.test(dbName)) {
    throw new Error(
      `Refusing to rebuild "${dbName}": db:test-setup wipes its target, and the name does not ` +
        `contain "test". Point TEST_DATABASE_URL at a test database.`,
    );
  }
  const fingerprint = schemaFingerprint();
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`COMMENT ON DATABASE ${quoteDbIdent(dbName)} IS NULL`);
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await build(url);
    await client.query(
      `COMMENT ON DATABASE ${quoteDbIdent(dbName)} IS '${templateStamp(fingerprint, Date.now())}'`,
    );
  } finally {
    await client.end();
  }
  return fingerprint;
}
