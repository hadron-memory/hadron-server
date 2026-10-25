/**
 * Runtime-role verifier — #2413 S1 (plan §3.3).
 *
 * Read-only catalog checks, run under the OWNER/migrator URL, that the serve
 * role is what `prisma/runtime-role.sql` meant it to be:
 *
 *   MIGRATE_DATABASE_URL=… pnpm tsx scripts/db/verify-runtime-role.ts [--role hadron_app]
 *
 * The owner URL is `MIGRATE_DATABASE_URL`, else `DATABASE_URL` (a single-role
 * deployment). The serve role is `--role`, else `RUNTIME_ROLE_NAME`, else
 * `hadron_app`. "Migrator" means the role this connection logs in as: the
 * ownership rule compares every `public` relation's owner to it.
 *
 * Exit codes (typed, stable — #2445 and the CI lane branch on them):
 *   0  every rule holds
 *   1  one or more rules violated (each printed as `FAIL <rule>: …`)
 *   2  usage or configuration error (no URL, bad flag, bad role name)
 *   3  could not connect or query
 *   4  the serve role does not exist
 *
 * Nothing here prints a URL or a password: connection errors are scrubbed
 * before they reach a log (`redact`).
 */
import { Client } from 'pg';
import { pathToFileURL } from 'node:url';

export const EXIT = { OK: 0, VIOLATIONS: 1, USAGE: 2, CONNECT: 3, ROLE_MISSING: 4 } as const;

export const DEFAULT_SERVE_ROLE = 'hadron_app';
const MIGRATIONS_TABLE = '_prisma_migrations';

export type Rule =
  | 'role-attributes'
  | 'role-membership'
  | 'role-owns-objects'
  | 'create-privilege'
  | 'missing-connect'
  | 'missing-table-privilege'
  | 'forbidden-table-privilege'
  | 'missing-sequence-privilege'
  | 'migrations-table-granted'
  | 'relation-not-owned-by-migrator';

export interface Violation {
  rule: Rule;
  detail: string;
}

export class RoleMissingError extends Error {
  constructor(role: string) {
    super(`serve role "${role}" does not exist`);
  }
}

/** Strip anything URL-shaped, and a known password, from text bound for a log. */
export function redact(text: string, secrets: string[] = []): string {
  let out = text.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi, '<redacted-url>');
  for (const s of secrets) if (s) out = out.split(s).join('<redacted>');
  return out;
}

const FORBIDDEN_TABLE_PRIVS = ['TRUNCATE', 'TRIGGER', 'REFERENCES'];
const REQUIRED_TABLE_PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
const ANY_PRIV_ON_MIGRATIONS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER', 'REFERENCES'];

/** Names only ever reach SQL as bind parameters; the cap keeps a log line short. */
function names(rows: { rel: string }[], max = 5): string {
  const shown = rows.slice(0, max).map((r) => r.rel);
  return rows.length > max ? `${shown.join(', ')} (+${rows.length - max} more)` : shown.join(', ');
}

/**
 * Run every rule. Read-only; the caller owns the connection. Throws
 * `RoleMissingError` when the role is absent, since no other rule means anything then.
 */
export async function verifyRuntimeRole(client: Client, role: string): Promise<Violation[]> {
  const out: Violation[] = [];
  const add = (rule: Rule, detail: string) => out.push({ rule, detail });

  const roleRow = (
    await client.query(
      `SELECT oid, rolsuper, rolbypassrls, rolreplication, rolcreaterole, rolcreatedb
         FROM pg_roles WHERE rolname = $1`,
      [role],
    )
  ).rows[0];
  if (!roleRow) throw new RoleMissingError(role);

  const flags = (['rolsuper', 'rolbypassrls', 'rolreplication', 'rolcreaterole', 'rolcreatedb'] as const).filter(
    (f) => roleRow[f],
  );
  if (flags.length) add('role-attributes', `${role} has ${flags.map((f) => f.replace('rol', '').toUpperCase()).join(', ')}`);

  const member = (await client.query(`SELECT roleid::regrole::text AS rel FROM pg_auth_members WHERE member = $1`, [roleRow.oid]))
    .rows;
  if (member.length) add('role-membership', `${role} is a member of ${names(member)}`);

  const owned = (
    await client.query(
      `SELECT 'relation ' || c.oid::regclass::text AS rel FROM pg_class c WHERE c.relowner = $1
       UNION ALL SELECT 'function ' || p.oid::regprocedure::text FROM pg_proc p WHERE p.proowner = $1
       UNION ALL SELECT 'schema ' || n.nspname FROM pg_namespace n WHERE n.nspowner = $1
       UNION ALL SELECT 'type ' || t.typname FROM pg_type t WHERE t.typowner = $1 AND t.typrelid = 0 AND t.typelem = 0
       UNION ALL SELECT 'database ' || d.datname FROM pg_database d WHERE d.datdba = $1`,
      [roleRow.oid],
    )
  ).rows;
  if (owned.length) add('role-owns-objects', `${role} owns ${names(owned)}`);

  // has_*_privilege answers the EFFECTIVE question, so a CREATE inherited from PUBLIC counts.
  const priv = (
    await client.query(
      `SELECT has_schema_privilege($1, 'public', 'CREATE') AS schema_create,
              has_database_privilege($1, current_database(), 'CREATE') AS db_create,
              has_database_privilege($1, current_database(), 'CONNECT') AS db_connect`,
      [role],
    )
  ).rows[0];
  if (priv.schema_create) add('create-privilege', `${role} can CREATE in schema public`);
  if (priv.db_create) add('create-privilege', `${role} can CREATE in the database`);
  if (!priv.db_connect) add('missing-connect', `${role} cannot CONNECT to the database`);

  const tables = (
    await client.query(
      `SELECT c.oid, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY c.relname`,
    )
  ).rows as { oid: number; relname: string }[];
  const maintain = Number((await client.query('SHOW server_version_num')).rows[0].server_version_num) >= 170000;
  const forbidden = maintain ? [...FORBIDDEN_TABLE_PRIVS, 'MAINTAIN'] : FORBIDDEN_TABLE_PRIVS;

  const missing: { rel: string }[] = [];
  const extra: { rel: string }[] = [];
  let migrationsPresent = false;
  for (const t of tables) {
    if (t.relname === MIGRATIONS_TABLE) {
      migrationsPresent = true;
      continue;
    }
    const q = await client.query(
      `SELECT bool_and(has_table_privilege($1, $2::oid, p)) AS ok FROM unnest($3::text[]) p`,
      [role, t.oid, REQUIRED_TABLE_PRIVS],
    );
    if (!q.rows[0].ok) missing.push({ rel: `public.${t.relname}` });
    const f = await client.query(
      `SELECT string_agg(p, '/') AS held FROM unnest($3::text[]) p WHERE has_table_privilege($1, $2::oid, p)`,
      [role, t.oid, forbidden],
    );
    if (f.rows[0].held) extra.push({ rel: `public.${t.relname} (${f.rows[0].held})` });
  }
  if (missing.length) add('missing-table-privilege', `${role} lacks SELECT/INSERT/UPDATE/DELETE on ${names(missing)}`);
  if (extra.length) add('forbidden-table-privilege', `${role} holds ${names(extra)}`);

  if (migrationsPresent) {
    const m = (
      await client.query(
        `SELECT string_agg(p, '/') AS held FROM unnest($2::text[]) p
          WHERE has_table_privilege($1, 'public.${MIGRATIONS_TABLE}'::regclass, p)
             OR (p IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
                 AND has_any_column_privilege($1, 'public.${MIGRATIONS_TABLE}'::regclass, p))`,
        [role, ANY_PRIV_ON_MIGRATIONS],
      )
    ).rows[0];
    if (m.held) add('migrations-table-granted', `${role} holds ${m.held} on ${MIGRATIONS_TABLE}; revoke it (the server never reads it)`);
  }

  const seqs = (
    await client.query(
      `SELECT 'public.' || c.relname AS rel FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'S'
          AND NOT (has_sequence_privilege($1, c.oid, 'USAGE') AND has_sequence_privilege($1, c.oid, 'SELECT'))
        ORDER BY c.relname`,
      [role],
    )
  ).rows;
  if (seqs.length) add('missing-sequence-privilege', `${role} lacks USAGE/SELECT on ${names(seqs)}`);

  // Detective control only: a relation another role created (the documented
  // superuser recovery path) works for the server through default privileges
  // but breaks the "migrator owns everything" assumption.
  const strays = (
    await client.query(
      `SELECT c.oid::regclass::text || ' (owner ' || c.relowner::regrole::text || ')' AS rel
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
          AND c.relowner <> (SELECT oid FROM pg_roles WHERE rolname = current_user)
        ORDER BY c.relname`,
    )
  ).rows;
  if (strays.length) add('relation-not-owned-by-migrator', `not owned by the migrator: ${names(strays)}`);

  return out;
}

function parseArgs(argv: string[]): { role: string } | { error: string } {
  let role = process.env.RUNTIME_ROLE_NAME || DEFAULT_SERVE_ROLE;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--role') {
      const v = argv[++i];
      if (!v) return { error: '--role needs a value' };
      role = v;
    } else return { error: `unknown argument ${JSON.stringify(argv[i])}` };
  }
  return { role };
}

export async function main(argv: string[], env: NodeJS.ProcessEnv, log: (line: string) => void): Promise<number> {
  const args = parseArgs(argv);
  if ('error' in args) {
    log(`usage: ${redact(args.error)}`);
    return EXIT.USAGE;
  }
  const url = env.MIGRATE_DATABASE_URL || env.DATABASE_URL;
  if (!url) {
    log('config: neither MIGRATE_DATABASE_URL nor DATABASE_URL is set');
    return EXIT.USAGE;
  }
  let password = '';
  try {
    password = decodeURIComponent(new URL(url).password);
  } catch {
    log('config: the owner URL is not a valid URL');
    return EXIT.USAGE;
  }

  const client = new Client({ connectionString: url });
  try {
    await client.connect();
    const found = await verifyRuntimeRole(client, args.role);
    if (!found.length) {
      log(`ok: ${args.role} satisfies every runtime-role rule`);
      return EXIT.OK;
    }
    for (const v of found) log(redact(`FAIL ${v.rule}: ${v.detail}`, [password]));
    return EXIT.VIOLATIONS;
  } catch (err) {
    if (err instanceof RoleMissingError) {
      log(redact(`FAIL role-missing: ${err.message}`));
      return EXIT.ROLE_MISSING;
    }
    log(redact(`connect/query failed: ${err instanceof Error ? err.message : String(err)}`, [password]));
    return EXIT.CONNECT;
  } finally {
    await client.end().catch(() => undefined);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main(process.argv.slice(2), process.env, (l) => console.log(l));
}
