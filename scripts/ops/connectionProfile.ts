/**
 * #4111 (blind finding F2 on #4116): one parse of a connection URL that yields BOTH the node-postgres client config and
 * the libpq environment for `pg_restore`, so the pipeline's own sessions and its child process connect with the same
 * host, credentials and TLS settings. Before this, only `sslmode` reached the child, so a URL whose connection needed a
 * client certificate passed preflight and then failed (or used a different certificate) inside `pg_restore`.
 *
 * The URL is the only source: every inherited `PG*` variable except `PGPASSFILE` is removed from the child's
 * environment, and an absent `sslmode` means no TLS on both sides (not "whatever PGSSLMODE says"). A query parameter
 * outside the supported set is refused before anything is created, rather than honoured by one side only.
 *
 * Supported: `sslmode` = `disable` | `require` | `verify-ca` | `verify-full`, with `sslrootcert`, `sslcert`, `sslkey`
 * (file paths). Refused: `prefer`/`allow` (opportunistic, so the two sides could settle differently), `no-verify`
 * (node-only), `require` with `sslrootcert` (libpq silently upgrades it to verify-ca; write verify-ca), `sslcert`
 * without `sslkey` or the reverse, `verify-ca` without `sslrootcert`, and every other parameter (`host`, `options`,
 * `service`, `uselibpqcompat`, ...).
 */
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { checkServerIdentity } from 'node:tls';
import type { ClientConfig } from 'pg';

const SUPPORTED = new Set(['sslmode', 'sslrootcert', 'sslcert', 'sslkey']);
const MODES = new Set(['disable', 'require', 'verify-ca', 'verify-full']);
export const APPLICATION_NAME = 'restore-with-rebase';
/** A root-certificate path that does not exist: libpq then encrypts without verifying, which is what `require` means. */
export const NO_ROOT_CERT = '/nonexistent/restore-with-rebase/no-root-cert';

export interface ConnectionProfile {
  host: string;
  port: number;
  user: string;
  password: string | undefined;
  database: string;
  sslmode: 'disable' | 'require' | 'verify-ca' | 'verify-full';
  sslrootcert: string | null;
  sslcert: string | null;
  sslkey: string | null;
}

/** A refused connection URL. The message names the parameter, never the URL or a value. */
export class ConnectionProfileError extends Error {}

/** Parse and validate; throws ConnectionProfileError. `database` overrides the URL's path. */
export function connectionProfile(url: string, database?: string): ConnectionProfile {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new ConnectionProfileError('connection URL does not parse');
  }
  if (u.protocol !== 'postgresql:' && u.protocol !== 'postgres:') throw new ConnectionProfileError('connection URL is not postgresql://');
  if (!u.hostname) throw new ConnectionProfileError('connection URL has no host (socket paths are not supported)');
  for (const key of u.searchParams.keys()) {
    if (!SUPPORTED.has(key)) throw new ConnectionProfileError(`unsupported connection parameter: ${key}`);
  }
  const p = (k: string) => u.searchParams.get(k);
  const mode = p('sslmode') ?? 'disable';
  if (!MODES.has(mode)) throw new ConnectionProfileError(`unsupported sslmode (use disable, require, verify-ca or verify-full)`);
  const sslrootcert = p('sslrootcert');
  const sslcert = p('sslcert');
  const sslkey = p('sslkey');
  if (mode === 'disable' && (sslrootcert || sslcert || sslkey)) {
    throw new ConnectionProfileError('sslrootcert/sslcert/sslkey given with sslmode disable');
  }
  if (mode === 'require' && sslrootcert) throw new ConnectionProfileError('sslmode require with sslrootcert: write sslmode verify-ca');
  if (mode === 'verify-ca' && !sslrootcert) throw new ConnectionProfileError('sslmode verify-ca needs sslrootcert');
  if (Boolean(sslcert) !== Boolean(sslkey)) throw new ConnectionProfileError('sslcert and sslkey must be given together');
  const path = decodeURIComponent(u.pathname.slice(1));
  return {
    host: decodeURIComponent(u.hostname.replace(/^\[|\]$/g, '')),
    port: u.port ? Number(u.port) : 5432,
    user: decodeURIComponent(u.username),
    password: u.password ? decodeURIComponent(u.password) : undefined,
    database: database ?? (path || 'postgres'),
    sslmode: mode as ConnectionProfile['sslmode'],
    sslrootcert,
    sslcert,
    sslkey,
  };
}

/** node-postgres config. `ssl` is always explicit, so node-postgres never falls back to PGSSLMODE. */
export function clientConfig(p: ConnectionProfile): ClientConfig {
  let ssl: ClientConfig['ssl'] = false;
  if (p.sslmode !== 'disable') {
    const tls: Exclude<ClientConfig['ssl'], boolean | undefined> = {};
    if (p.sslrootcert) tls.ca = readFileSync(p.sslrootcert, 'utf8');
    if (p.sslcert) tls.cert = readFileSync(p.sslcert, 'utf8');
    if (p.sslkey) tls.key = readFileSync(p.sslkey, 'utf8');
    if (p.sslmode === 'require') tls.rejectUnauthorized = false;
    if (p.sslmode === 'verify-ca') tls.checkServerIdentity = () => undefined;
    // node-postgres sends no servername for an IP-literal host, and Node then checks the certificate against
    // "localhost". libpq checks the IP itself; so does this.
    if (p.sslmode === 'verify-full' && isIP(p.host)) tls.checkServerIdentity = (_name, cert) => checkServerIdentity(p.host, cert);
    ssl = tls;
  }
  return {
    host: p.host,
    port: p.port,
    user: p.user,
    password: p.password,
    database: p.database,
    ssl,
    application_name: APPLICATION_NAME,
  };
}

/**
 * libpq environment for a child process, so no URL appears on a command line. Inherited `PG*` variables (other than
 * `PGPASSFILE`, which both sides read for a password-less URL) are dropped. Without `sslrootcert` a verifying mode uses
 * the system trust store (`PGSSLROOTCERT=system`, libpq 16+), node its bundled one (a named limit: the two stores
 * can differ, so name `sslrootcert` explicitly for a private CA); without `sslcert` no client certificate is
 * sent (`PGSSLCERTMODE=disable`, libpq 16+), as node sends none. GSS encryption is off, as node has none.
 */
export function libpqEnv(p: ConnectionProfile, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!k.startsWith('PG') || k === 'PGPASSFILE') env[k] = v;
  env.PGHOST = p.host;
  env.PGPORT = String(p.port);
  env.PGUSER = p.user;
  if (p.password !== undefined) env.PGPASSWORD = p.password;
  env.PGDATABASE = p.database;
  env.PGAPPNAME = APPLICATION_NAME;
  env.PGGSSENCMODE = 'disable';
  env.PGSSLMODE = p.sslmode;
  if (p.sslmode !== 'disable') {
    // require: point libpq at a root file that cannot exist, or a ~/.postgresql/root.crt would silently turn it into
    // verify-ca on this side only.
    env.PGSSLROOTCERT = p.sslmode === 'require' ? NO_ROOT_CERT : (p.sslrootcert ?? 'system');
    if (p.sslcert) {
      env.PGSSLCERT = p.sslcert;
      env.PGSSLKEY = p.sslkey!;
    } else {
      env.PGSSLCERTMODE = 'disable';
    }
  }
  return env;
}
