/**
 * #4111 test support: a private, throwaway PostgreSQL cluster (initdb + pg_ctl) on a free localhost port, so the
 * restore pipeline's tests can create roles, templates and databases, and move the xid counter with `pg_resetwal -x`,
 * without touching any shared cluster. Never point this at a real data directory.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, appendFileSync, statSync, truncateSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** The PostgreSQL server binaries directory, or null when none is installed. */
export function pgBinDir(): string | null {
  for (const v of ['17', '16', '18']) {
    const dir = `/usr/lib/postgresql/${v}/bin`;
    // The Hadron schema needs pgvector in the SAME installation: a runner with server binaries but no vector
    // extension for them (GitHub's ubuntu image, whose pgvector lives in the service container) cannot host the suite.
    if (
      existsSync(join(dir, 'initdb')) &&
      existsSync(join(dir, 'pg_resetwal')) &&
      existsSync(`/usr/share/postgresql/${v}/extension/vector.control`)
    ) {
      return dir;
    }
  }
  return null;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

export interface PrivateCluster {
  bin: string;
  dir: string;
  port: number;
  /** Superuser URL for a database. */
  url(db?: string, user?: string, password?: string): string;
  stop(): void;
  start(): void;
  /** Stop, set the next xid with pg_resetwal -x, start again. Throwaway clusters only. */
  setNextXid(xid: bigint): void;
  /**
   * Turn on TLS with a throwaway CA (server certificate for 127.0.0.1) and require certificate authentication for
   * `certUser` over TLS. Returns the CA and a client certificate/key for that user, as files.
   */
  enableTls(certUser: string): { ca: string; cert: string; key: string };
  destroy(): void;
}

/** initdb a new cluster under TMPDIR (keep TMPDIR on a disk, not /tmp's tmpfs) and start it. */
export async function startPrivateCluster(name: string): Promise<PrivateCluster> {
  const bin = pgBinDir();
  if (!bin) throw new Error('no PostgreSQL server binaries');
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), `pgc-${name}-`));
  const data = join(dir, 'data');
  const port = await freePort();
  execFileSync(join(bin, 'initdb'), ['-D', data, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C.UTF-8'], { stdio: 'pipe' });
  appendFileSync(
    join(data, 'postgresql.conf'),
    `\nport = ${port}\nlisten_addresses = '127.0.0.1'\nunix_socket_directories = '${dir}'\nfsync = off\nwal_level = replica\n`,
  );
  // Password auth for the non-superuser roles the tests create; trust for the superuser fixture connection.
  writeFileSync(
    join(data, 'pg_hba.conf'),
    'host all postgres 127.0.0.1/32 trust\nhost all all 127.0.0.1/32 scram-sha-256\nlocal all all trust\n',
  );
  const ctl = (...args: string[]) => execFileSync(join(bin, 'pg_ctl'), ['-D', data, '-w', '-l', join(dir, 'log'), ...args], { stdio: 'pipe' });
  ctl('start');
  const cluster: PrivateCluster = {
    bin,
    dir,
    port,
    url(db = 'postgres', user = 'postgres', password?: string) {
      const auth = password ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}` : encodeURIComponent(user);
      return `postgresql://${auth}@127.0.0.1:${port}/${encodeURIComponent(db)}`;
    },
    stop: () => ctl('stop', '-m', 'fast'),
    start: () => ctl('start'),
    setNextXid(xid: bigint) {
      ctl('stop', '-m', 'fast');
      execFileSync(join(bin, 'pg_resetwal'), ['-x', xid.toString(), '-f', data], { stdio: 'pipe' });
      // pg_resetwal -x needs the commit-log segment for the new xid to exist.
      // A segment is 32 pages of 8 KiB (4 xids a byte): 1,048,576 xids. Create or zero-extend the one holding `xid`.
      const clog = join(data, 'pg_xact', (xid >> 20n).toString(16).toUpperCase().padStart(4, '0'));
      if (!existsSync(clog)) writeFileSync(clog, Buffer.alloc(256 * 1024));
      else if (statSync(clog).size < 256 * 1024) truncateSync(clog, 256 * 1024);
      ctl('start');
    },
    enableTls(certUser: string) {
      const tls = join(dir, 'tls');
      execFileSync('mkdir', ['-p', tls]);
      const ssl = (...args: string[]) => execFileSync('openssl', args, { cwd: tls, stdio: 'pipe' });
      ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=restore-4111-test-ca', '-keyout', 'ca.key', '-out', 'ca.crt');
      writeFileSync(join(tls, 'san.ext'), 'subjectAltName=IP:127.0.0.1\n');
      ssl('req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=127.0.0.1', '-keyout', 'server.key', '-out', 'server.csr');
      ssl('x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '2', '-extfile', 'san.ext', '-out', 'server.crt');
      ssl('req', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${certUser}`, '-keyout', 'client.key', '-out', 'client.csr');
      ssl('x509', '-req', '-in', 'client.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '2', '-out', 'client.crt');
      execFileSync('chmod', ['600', join(tls, 'server.key'), join(tls, 'client.key')]);
      appendFileSync(
        join(data, 'postgresql.conf'),
        `\nssl = on\nssl_cert_file = '${join(tls, 'server.crt')}'\nssl_key_file = '${join(tls, 'server.key')}'\nssl_ca_file = '${join(tls, 'ca.crt')}'\n`,
      );
      const hba = join(data, 'pg_hba.conf');
      const rest = execFileSync('cat', [hba]).toString();
      writeFileSync(hba, `hostssl all ${certUser} 127.0.0.1/32 cert\nhost all ${certUser} 127.0.0.1/32 reject\n${rest}`);
      ctl('reload');
      return { ca: join(tls, 'ca.crt'), cert: join(tls, 'client.crt'), key: join(tls, 'client.key') };
    },
    destroy() {
      try {
        ctl('stop', '-m', 'immediate');
      } catch {
        /* already stopped */
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return cluster;
}
