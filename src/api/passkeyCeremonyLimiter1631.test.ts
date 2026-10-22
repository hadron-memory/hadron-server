/**
 * #1631 S2a PR1a: the ceremony routes' per-IP limiter keys on the TRUSTED client address.
 * The routes inherit whatever 'trust proxy' the app sets (server.ts: Cloudflare CIDRs in
 * production, boot refuses if they cannot be loaded; permissive `true` outside production).
 * These pins show what that inheritance means: a forged X-Forwarded-For from a peer that is
 * NOT a trusted proxy cannot rotate the limiter key; from a trusted proxy it can (that is the
 * point of trusting it). They do not assert production configuration.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mountPasskeyCeremonyRoutes, PASSKEY_CEREMONY_RATE_LIMIT_PER_MINUTE, PASSKEY_REVOKE_PER_CREDENTIAL_LIMIT } from './passkeyCeremonyRoutes.js';

let server: Server | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
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

/**
 * #1631 PR1b: revoke/start also counts per credential, across client addresses, so rotating IPs
 * (or a trusted proxy's forwarded addresses) cannot hammer one credential's row. The key is the
 * DECODED credential id, so two base64url spellings of the same bytes share one budget.
 */
describe('#1631 revoke/start per-credential limit', () => {
  /** One revoke/start from a fresh client address; the assertion is junk, so each is the uniform 403 until limited. */
  const attempt = (base: string, i: number, credentialId: string) => fetch(`${base}/passkeys/revoke/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://sign.example.test', 'x-forwarded-for': `198.51.100.${i + 1}` },
    body: JSON.stringify({ ceremonyId: 'c'.repeat(43), credentialId, authenticatorData: 'AA', clientDataJson: 'AA', signature: 'AA' }),
  }).then((r) => r.status);

  it('limits one credential across rotating trusted client addresses, and leaves other credentials alone', async () => {
    vi.stubEnv('SIGNING_CEREMONY_ORIGINS', 'https://sign.example.test');
    const base = await boot(['127.0.0.1/32']);
    const statuses: number[] = [];
    for (let i = 0; i < PASSKEY_REVOKE_PER_CREDENTIAL_LIMIT + 3; i++) statuses.push(await attempt(base, i, 'AAA'));
    expect(statuses.slice(0, PASSKEY_REVOKE_PER_CREDENTIAL_LIMIT).every((s) => s === 403)).toBe(true);
    expect(statuses.slice(PASSKEY_REVOKE_PER_CREDENTIAL_LIMIT).every((s) => s === 429)).toBe(true);
    // 'AAB' decodes to the same two zero bytes as 'AAA': an alias spelling is the same credential.
    expect(await attempt(base, 100, 'AAB')).toBe(429);
    // A different credential still gets its own budget.
    expect(await attempt(base, 101, 'AQE')).toBe(403);
  });
});
