/**
 * #4111, blind finding F2 on #4116: the pipeline's own sessions and its pg_restore child take every connection setting
 * from one parse of RESTORE_ADMIN_URL. No database needed, so this runs on hosted CI too.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, describe, expect, it } from 'vitest';
import { clientConfig, connectionProfile, ConnectionProfileError, libpqEnv, NO_ROOT_CERT } from './connectionProfile.js';

const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'connprofile-'));
const file = (name: string) => {
  const p = join(dir, name);
  writeFileSync(p, `-----${name}-----\n`);
  return p;
};
const ca = file('ca.crt');
const cert = file('client.crt');
const key = file('client.key');
// A runner's own PGPASSWORD would make every password-less URL below a refusal; the refusal has its own test.
const runnerPassword = process.env.PGPASSWORD;
delete process.env.PGPASSWORD;
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  if (runnerPassword !== undefined) process.env.PGPASSWORD = runnerPassword;
});

const base = 'postgresql://restore_admin:p%40ss@db.example:6543/postgres';
const inherited = {
  PATH: '/usr/bin',
  PGSSLROOTCERT: '/elsewhere/root.crt',
  PGSSLCERT: '/elsewhere/client.crt',
  PGSERVICE: 'other',
  PGOPTIONS: '-c search_path=evil',
  PGHOST: 'other-host',
  PGPASSFILE: '/home/op/.pgpass',
};

describe('#4111 F2: one connection profile for both sides', () => {
  it('certificate authentication: both sides get the same CA, client certificate and key; inherited PG* is dropped', () => {
    const url = `${base}?sslmode=verify-full&sslrootcert=${encodeURIComponent(ca)}&sslcert=${encodeURIComponent(cert)}&sslkey=${encodeURIComponent(key)}`;
    const p = connectionProfile(url, 'restored_1');
    const env = libpqEnv(p, inherited);
    expect(env).toMatchObject({
      PATH: '/usr/bin',
      PGPASSFILE: '/home/op/.pgpass',
      PGHOST: 'db.example',
      PGPORT: '6543',
      PGUSER: 'restore_admin',
      PGPASSWORD: 'p@ss',
      PGDATABASE: 'restored_1',
      PGSSLMODE: 'verify-full',
      PGSSLROOTCERT: ca,
      PGSSLCERT: cert,
      PGSSLKEY: key,
      PGGSSENCMODE: 'disable',
      PGAPPNAME: 'restore-with-rebase',
    });
    expect(env.PGSERVICE).toBeUndefined();
    expect(env.PGOPTIONS).toBeUndefined();
    expect(env.PGSSLCERTMODE).toBeUndefined();
    const c = clientConfig(p);
    expect(c).toMatchObject({ host: 'db.example', port: 6543, user: 'restore_admin', password: 'p@ss', database: 'restored_1' });
    expect(c.ssl).toEqual({ ca: '-----ca.crt-----\n', cert: '-----client.crt-----\n', key: '-----client.key-----\n' });
  });

  it('no sslmode means no TLS on both sides, whatever the environment says', () => {
    const p = connectionProfile(base);
    expect(clientConfig(p).ssl).toBe(false);
    const env = libpqEnv(p, { ...inherited, PGSSLMODE: 'verify-full' });
    expect(env.PGSSLMODE).toBe('disable');
    expect(env.PGSSLROOTCERT).toBeUndefined();
    expect(env.PGSSLCERT).toBeUndefined();
    expect(env.PGHOST).toBe('db.example');
  });

  it('require encrypts without verifying on both sides, and libpq cannot pick up a default root file', () => {
    const p = connectionProfile(`${base}?sslmode=require`);
    expect(clientConfig(p).ssl).toEqual({ rejectUnauthorized: false });
    const env = libpqEnv(p, {});
    expect(env).toMatchObject({ PGSSLMODE: 'require', PGSSLROOTCERT: NO_ROOT_CERT, PGSSLCERTMODE: 'disable' });
  });

  it('verify-ca checks the chain but not the host name; verify-full without a root file uses the system store', () => {
    const ssl = clientConfig(connectionProfile(`${base}?sslmode=verify-ca&sslrootcert=${encodeURIComponent(ca)}`)).ssl as any;
    expect(ssl.ca).toBe('-----ca.crt-----\n');
    expect(ssl.rejectUnauthorized).toBeUndefined();
    expect(ssl.checkServerIdentity()).toBeUndefined();
    const full = connectionProfile(`${base}?sslmode=verify-full`);
    expect(clientConfig(full).ssl).toEqual({});
    // An IP-literal host is checked against that IP, not against Node's "localhost" fallback.
    const ip = clientConfig(connectionProfile('postgresql://u@127.0.0.1/postgres?sslmode=verify-full')).ssl as any;
    const certFor = (ipAddr: string) => ({ subject: { CN: 'x' }, subjectaltname: `IP Address:${ipAddr}` }) as any;
    expect(ip.checkServerIdentity('localhost', certFor('127.0.0.1'))).toBeUndefined();
    expect(ip.checkServerIdentity('localhost', certFor('10.0.0.9'))).toBeInstanceOf(Error);
    expect(libpqEnv(full, {})).toMatchObject({ PGSSLMODE: 'verify-full', PGSSLROOTCERT: 'system', PGSSLCERTMODE: 'disable' });
  });

  it('a password-less URL sets no PGPASSWORD (both sides fall back to the password file)', () => {
    const p = connectionProfile('postgresql://restore_admin@db.example/postgres');
    expect(p.port).toBe(5432);
    expect(libpqEnv(p, { PGPASSWORD: 'inherited' }).PGPASSWORD).toBeUndefined();
    expect(clientConfig(p).password).toBeUndefined();
  });

  it('blind P2 on 338deec1: a password-less URL beside an inherited PGPASSWORD is refused; a URL password wins on both sides', () => {
    const bare = 'postgresql://restore_admin@db.example/postgres';
    expect(() => connectionProfile(bare, undefined, { PGPASSWORD: 'inherited' })).toThrow(ConnectionProfileError);
    expect(() => connectionProfile(bare, undefined, { PGPASSWORD: '' })).toThrow(/PGPASSWORD is set but the connection URL has no password/);
    expect(connectionProfile(bare, undefined, { PGPASSFILE: '/home/op/.pgpass' }).password).toBeUndefined();
    const withPassword = connectionProfile(base, undefined, { PGPASSWORD: 'inherited' });
    expect(clientConfig(withPassword).password).toBe('p@ss');
    expect(libpqEnv(withPassword, { PGPASSWORD: 'inherited' }).PGPASSWORD).toBe('p@ss');
  });

  it.each([
    ['an unknown parameter', `${base}?options=-c%20x%3Dy`, /unsupported connection parameter: options/],
    ['a host parameter', `${base}?host=%2Fvar%2Frun`, /unsupported connection parameter: host/],
    ['uselibpqcompat', `${base}?uselibpqcompat=true`, /unsupported connection parameter: uselibpqcompat/],
    ['sslmode prefer', `${base}?sslmode=prefer`, /unsupported sslmode/],
    ['sslmode no-verify', `${base}?sslmode=no-verify`, /unsupported sslmode/],
    ['require with a root file', `${base}?sslmode=require&sslrootcert=${encodeURIComponent(ca)}`, /verify-ca/],
    ['verify-ca without a root file', `${base}?sslmode=verify-ca`, /needs sslrootcert/],
    ['a certificate without its key', `${base}?sslmode=verify-full&sslcert=${encodeURIComponent(cert)}`, /together/],
    ['certificates with TLS off', `${base}?sslrootcert=${encodeURIComponent(ca)}`, /sslmode disable/],
    ['not a postgres URL', 'mysql://x@y/z', /not postgresql/],
    ['no host', 'postgresql:///postgres', /no host/],
  ])('refuses %s, naming no value', (_what, url, msg) => {
    let err: unknown;
    try {
      connectionProfile(url);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConnectionProfileError);
    expect((err as Error).message).toMatch(msg);
    expect((err as Error).message).not.toContain('p@ss');
    expect((err as Error).message).not.toContain('db.example');
  });
});
