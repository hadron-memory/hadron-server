/** Real production boot/CIDR path, private worker DB and local synthetic API only. */
import { afterEach, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { PARALLEL_DBS, workerDbName } from '../dbWorkers.js';
import { signJwt } from '../../auth/jwt.js';

let child: ChildProcess | undefined;
let api: Server | undefined;
let cache: string | undefined;

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>(done => child!.once('exit', () => done()));
    child.kill('SIGTERM'); // Only this test's actual child; never a process-name kill.
    await exited;
  }
  api?.closeAllConnections();
  if (api) await new Promise<void>(done => api!.close(() => done()));
  if (cache) await rm(cache, { recursive: true, force: true });
  child = undefined; api = undefined; cache = undefined;
});

it.skipIf(!PARALLEL_DBS)('#1793 actual production CIDR boot ignores forged XFF from an untrusted peer', async () => {
  const url = new URL(process.env.DATABASE_URL!);
  expect(['localhost', '127.0.0.1', '[::1]']).toContain(url.hostname);
  expect(url.pathname).toBe(`/${workerDbName(process.env.VITEST_POOL_ID ?? '1')}`);
  await cleanDb(db);
  const user = await db.user.create({ data: { githubId: 179394, githubUsername: 'production-proxy-fixture', roles: ['ADMIN'] } });
  const token = await signJwt({ sub: user.id, githubId: user.githubId!, githubUsername: user.githubUsername!, roles: ['ADMIN'] });
  cache = await mkdtemp(join(tmpdir(), 'rate-trust-1793-'));
  const cidrs = ['203.0.113.0/24', '2001:db8::/32']; // Neither trusts the loopback HTTP peer.
  api = createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: true, result: { ipv4_cidrs: [cidrs[0]], ipv6_cidrs: [cidrs[1]] } }));
  });
  await new Promise<void>(done => api!.listen(0, '127.0.0.1', done));
  const address = api.address();
  if (!address || typeof address === 'string') throw new Error('missing synthetic API port');
  const program = `
    import { createServer } from ${JSON.stringify(resolve('src/server.ts'))};
    const app = await createServer();
    const server = app.listen(0, '127.0.0.1', () => {
      process.send({ port: server.address().port, trust: app.get('trust proxy') });
    });
  `;
  child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME,
      DATABASE_URL: process.env.DATABASE_URL,
      NODE_ENV: 'production',
      JWT_SECRET: process.env.JWT_SECRET,
      RATE_LIMIT_KEYRING: process.env.RATE_LIMIT_KEYRING,
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
    child!.once('exit', (code, signal) => {
      clearTimeout(timer); reject(new Error(`production fixture exited ${code}/${signal}: ${stderr}`));
    });
  });
  expect(started.trust).toEqual(cidrs); // Configured by production createServer; no app.set override.
  const base = `http://127.0.0.1:${started.port}`;
  for (const forged of ['198.51.100.31', '198.51.100.32']) {
    const response = await fetch(base + '/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Forwarded-For': forged },
      body: JSON.stringify({ query: 'query { findNodes(limit:0) { total } }' }),
    });
    expect((await response.json() as { errors?: unknown }).errors).toBeUndefined();
  }
  const buckets = await db.rateLimitBucket.findMany({ where: { fieldClass: 'FAN_OUT_READS', dimension: 'ip' } });
  expect(buckets).toHaveLength(1);
  expect(buckets[0].used).toBe(2n);
}, 30_000);
