/**
 * #4677 item 13 (refs #419, #1793): the real production boot/CIDR path for the AUTH admission. A local stub
 * serves the Cloudflare range list (no production fetch); the child is the real `createServer()` in
 * NODE_ENV=production with no `app.set('trust proxy')` override. Private worker database only.
 */
import { afterEach, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { PARALLEL_DBS, workerDbName } from '../dbWorkers.js';

let child: ChildProcess | undefined;
let api: Server | undefined;
let cache: string | undefined;

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>(done => child!.once('exit', () => done()));
    child.kill('SIGTERM'); // Only this test's own child; never a process-name kill.
    await exited;
  }
  api?.closeAllConnections();
  if (api) await new Promise<void>(done => api!.close(() => done()));
  if (cache) await rm(cache, { recursive: true, force: true });
  child = undefined; api = undefined; cache = undefined;
});

/** Boot production with these ranges, send /auth/me twice with different forged XFF values, return the IP buckets. */
async function bootAndProbe(ipv4: string[]) {
  const url = new URL(process.env.DATABASE_URL!);
  expect(['localhost', '127.0.0.1', '[::1]']).toContain(url.hostname);
  expect(url.pathname).toBe(`/${workerDbName(process.env.VITEST_POOL_ID ?? '1')}`);
  await cleanDb(db);
  cache = await mkdtemp(join(tmpdir(), 'auth-rate-trust-4677-'));
  api = createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: true, result: { ipv4_cidrs: ipv4, ipv6_cidrs: ['2001:db8::/32'] } }));
  });
  await new Promise<void>(done => api!.listen(0, '127.0.0.1', done));
  const address = api.address();
  if (!address || typeof address === 'string') throw new Error('missing synthetic API port');
  const program = `
    import { createServer } from ${JSON.stringify(resolve('src/server.ts'))};
    const app = await createServer();
    const server = app.listen(0, '127.0.0.1', () => process.send({ port: server.address().port, trust: app.get('trust proxy') }));
  `;
  child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: process.env.DATABASE_URL, NODE_ENV: 'production',
      JWT_SECRET: process.env.JWT_SECRET, RATE_LIMIT_KEYRING: process.env.RATE_LIMIT_KEYRING,
      HADRON_ENCRYPTION_KEY: process.env.HADRON_ENCRYPTION_KEY,
      BASE_URL: 'http://127.0.0.1:4000', FRONTEND_URL: '',
      EMBEDDING_API_URL: '', EMBEDDING_SAGEMAKER_ENDPOINT_NAME: '', NATS_URL: '', PDF_SERVICE_URL: '',
      MS_EXCHANGE_TOOL_URL: '', GMAIL_TOOL_URL: '', SLACK_TOOL_URL: '', MCP_TOOL_URL: '', RESEND_TOOL_URL: '', SENTRY_DSN: '',
      CLOUDFLARE_IPS_API_URL: `http://127.0.0.1:${address.port}/ips`,
      CLOUDFLARE_IPS_CACHE_PATH: join(cache, 'ips.json'),
      DISABLE_RUN_WORKER: 'true', DISABLE_SCHEDULER: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr!.on('data', value => { stderr += value.toString(); });
  child.stdout!.resume();
  const started = await new Promise<{ port: number; trust: unknown }>((done, reject) => {
    const timer = setTimeout(() => reject(new Error('production fixture boot timed out')), 20_000);
    child!.once('message', value => { clearTimeout(timer); done(value as { port: number; trust: unknown }); });
    child!.once('error', error => { clearTimeout(timer); reject(error); });
    child!.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`production fixture exited ${code}/${signal}: ${stderr}`)); });
  });
  expect(started.trust).toEqual([...ipv4, '2001:db8::/32']);
  for (const forged of ['198.51.100.41', '198.51.100.42']) {
    const response = await fetch(`http://127.0.0.1:${started.port}/auth/me`, { headers: { 'X-Forwarded-For': forged } });
    expect(response.status).toBe(401);
    await response.arrayBuffer();
  }
  return db.rateLimitBucket.findMany({ where: { fieldClass: 'CREDENTIALS', dimension: 'ip' } });
}

it.skipIf(!PARALLEL_DBS)('#4677 untrusted peer: forged XFF is ignored, so both requests spend ONE peer bucket', async () => {
  const buckets = await bootAndProbe(['203.0.113.0/24']); // does not include the loopback peer
  expect(buckets).toHaveLength(1);
  expect(buckets[0].used).toBe(2n);
}, 40_000);

it.skipIf(!PARALLEL_DBS)('#4677 trusted peer: the same forged XFF values ARE honored, so each spends its own bucket', async () => {
  const buckets = await bootAndProbe(['127.0.0.0/8']); // includes the loopback peer, as a Cloudflare edge would be
  expect(buckets).toHaveLength(2);
  expect(buckets.map(b => b.used)).toEqual([1n, 1n]);
}, 40_000);
