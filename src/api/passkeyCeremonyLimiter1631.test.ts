/**
 * #1631 S2a PR1a: the ceremony routes' per-IP limiter keys on the TRUSTED client address.
 * The routes inherit whatever 'trust proxy' the app sets (server.ts: Cloudflare CIDRs in
 * production, boot refuses if they cannot be loaded; permissive `true` outside production).
 * These pins show what that inheritance means: a forged X-Forwarded-For from a peer that is
 * NOT a trusted proxy cannot rotate the limiter key; from a trusted proxy it can (that is the
 * point of trusting it). They do not assert production configuration.
 */
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mountPasskeyCeremonyRoutes, PASSKEY_CEREMONY_RATE_LIMIT_PER_MINUTE } from './passkeyCeremonyRoutes.js';

let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close((e) => e ? reject(e) : resolve()));
  server = undefined;
});

async function boot(trustProxy: boolean | string[]) {
  const app = express();
  app.set('trust proxy', trustProxy);
  mountPasskeyCeremonyRoutes(app, { PASSKEY_SIGNING_ENABLED: 'true', PASSKEY_REGISTRATION_ENABLED: 'true' });
  server = createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Statuses of N register/start calls, each claiming a different client through X-Forwarded-For. */
async function burst(base: string, n: number) {
  const statuses: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = await fetch(`${base}/passkeys/register/start`, { method: 'POST', headers: { 'x-forwarded-for': `198.51.100.${i + 1}` } });
    statuses.push(r.status);
  }
  return statuses;
}

describe('#1631 limiter client identity', () => {
  const OVER = PASSKEY_CEREMONY_RATE_LIMIT_PER_MINUTE + 5;

  it('ignores a forged X-Forwarded-For from a peer that is not a trusted proxy', async () => {
    const statuses = await burst(await boot(['203.0.113.0/24']), OVER);
    expect(statuses.slice(0, PASSKEY_CEREMONY_RATE_LIMIT_PER_MINUTE).every((s) => s === 403)).toBe(true);
    expect(statuses.slice(PASSKEY_CEREMONY_RATE_LIMIT_PER_MINUTE).every((s) => s === 429)).toBe(true);
  });

  it('control: the key follows X-Forwarded-For only when the peer is a trusted proxy', async () => {
    const statuses = await burst(await boot(['127.0.0.1/32']), OVER);
    expect(statuses.every((s) => s === 403)).toBe(true);
  });
});
