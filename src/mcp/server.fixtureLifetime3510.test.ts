import { afterEach, expect, it } from 'vitest';
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHmac } from 'node:crypto';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { FixtureLifetime } from '../test/fixtureLifetime.js';
import { assertRateReadiness } from '../lib/rateLimit/index.js';
import { createServer } from '../server.js';
import { signJwt } from '../auth/jwt.js';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
};
let server: Server | undefined;
const close = async () => {
  const current = server;
  current?.closeAllConnections();
  if (current) await new Promise<void>(r => current.close(() => r()));
};
afterEach(close);

it('drains an overdue body through its real policy write before the next reset and two allowed searches', async () => {
  await cleanDb(db);
  await assertRateReadiness(db);
  const first = await db.user.create({ data: { githubUsername: 'late-rate-first', roles: ['ADMIN'] } });
  const lifetime = new FixtureLifetime();
  const entered = deferred(), write = deferred(), written = deferred(), finish = deferred(), closing = deferred();
  const phases: string[] = [];
  const body = lifetime.run(async () => {
    entered.resolve();
    await write.promise;
    await db.rateLimitPolicy.update({ where: { fieldClass: 'FAN_OUT_READS' }, data: { principalLimit: 1, enforcementMode: 'ENFORCING' } });
    phases.push('old-policy-write');
    written.resolve();
    await finish.promise;
    phases.push('old-body-settled');
  });
  await entered.promise;
  let drained = false;
  const cleanup = lifetime.drain(async () => { closing.resolve(); }).then(() => { drained = true; phases.push('drained'); });
  try {
    await closing.promise;
    write.resolve();
    await written.promise; // Observe the REAL write, not a canned allowance or a timer.
    expect((await db.rateLimitPolicy.findUniqueOrThrow({ where: { fieldClass: 'FAN_OUT_READS' } })).principalLimit).toBe(1);
    expect(drained).toBe(false); // The body is still live, even after the write completed.
  } finally {
    write.resolve(); finish.resolve();
    await body; await cleanup;
  }
  expect(phases).toEqual(['old-policy-write', 'old-body-settled', 'drained']);
  phases.push('next-reset');
  await cleanDb(db);
  const user = await db.user.create({ data: { githubUsername: 'late-rate-next', roles: ['ADMIN'] } });
  expect(user.id).not.toBe(first.id);
  server = httpServer(await createServer());
  await new Promise<void>(r => server!.listen(0, '127.0.0.1', r));
  expect(await db.rateLimitPolicy.findUniqueOrThrow({ where: { fieldClass: 'FAN_OUT_READS' } })).toMatchObject({ principalLimit: 300, enforcementMode: 'LOG_ONLY' });
  const token = await signJwt({ sub: user.id, githubId: 0, githubUsername: user.githubUsername!, roles: ['ADMIN'] });
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  for (const ip of ['198.51.100.1', '198.51.100.2']) {
    const response = await fetch(base + '/graphql', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, 'X-Forwarded-For': ip }, body: JSON.stringify({ query: 'query { findNodes(limit:0) { total } }' }) });
    expect((await response.json() as { errors?: unknown }).errors).toBeUndefined();
  }
  const ring = JSON.parse(process.env.RATE_LIMIT_KEYRING!);
  const subject = ring.current + ':' + createHmac('sha256', Buffer.from(ring.keys[ring.current], 'hex')).update(JSON.stringify(['v1', 'FAN_OUT_READS', 'principal', 'USER:' + user.id])).digest('hex');
  const buckets = await db.rateLimitBucket.findMany({ where: { fieldClass: 'FAN_OUT_READS', dimension: 'principal' } });
  // This is an isolation/identity pin, not an assumption that the two
  // requests cannot straddle a minute boundary (#3074).
  expect(buckets.length).toBeGreaterThan(0);
  expect(buckets.every(bucket => bucket.subject === subject)).toBe(true);
  expect(buckets.reduce((sum, bucket) => sum + bucket.used, 0n)).toBe(2n);
});

it('retains the original rejection while cleanup drains and closes resources created by the tail', async () => {
  const lifetime = new FixtureLifetime(), finish = deferred(), entered = deferred();
  const failure = new Error('synthetic failed body');
  let live = false;
  const work = lifetime.run(async () => { entered.resolve(); await finish.promise; live = true; throw failure; });
  const rejected = expect(work).rejects.toBe(failure);
  await entered.promise;
  const cleanup = lifetime.drain(async () => { live = false; });
  finish.resolve();
  await rejected;
  await cleanup;
  expect(live).toBe(false);
});

it('joins one cleanup across hook deadlines and refuses a new body until it settles', async () => {
  const lifetime = new FixtureLifetime(), entered = deferred(), finish = deferred();
  const work = lifetime.run(async () => { entered.resolve(); await finish.promise; });
  await entered.promise;
  let closes = 0;
  const closeResources = async () => { closes++; };
  const first = lifetime.drain(closeResources);
  const nextBeforeEach = lifetime.drain(closeResources);
  expect(nextBeforeEach).toBe(first);
  expect(() => lifetime.run(async () => {})).toThrow('during cleanup');
  finish.resolve();
  await work; await first; await nextBeforeEach;
  expect(closes).toBe(2);
  await expect(lifetime.run(async () => 'next')).resolves.toBe('next');
});
