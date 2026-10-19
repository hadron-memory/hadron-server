/** #1631 S2a PR1 red pins: only a server-origin ceremony proof opens an enabled ceremony route. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../server.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';

let server: Server | undefined;
let base: string;

beforeEach(async () => {
  await cleanDb(db);
  vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
  vi.stubEnv('PASSKEY_REGISTRATION_ENABLED', 'true');
  vi.stubEnv('PASSKEY_RP_ID', 'localhost');
  server = httpServer(await createServer());
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close((e) => e ? reject(e) : resolve()));
  server = undefined;
  vi.unstubAllEnvs();
});

const ROUTES = ['/passkeys/register/start', '/passkeys/revoke/start'];

describe('#1631 enabled ceremony routes refuse every non-proof caller', () => {
  it.each(ROUTES)('%s refuses no credentials, API/App-style keys and a forged ceremony cookie', async (path) => {
    for (const headers of [
      {},
      { authorization: 'Bearer hk_not-a-real-key' },
      { authorization: 'Basic ' + Buffer.from('a:b').toString('base64') },
      { cookie: 'hadron_ceremony=forged-value' },
    ] as Array<Record<string, string>>) {
      const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });
      expect(response.status).toBe(403);
      expect(await db.passkeyCredential.count()).toBe(0);
    }
  });

  it.each(ROUTES)('%s refuses a cross-site form POST (no ceremony CSRF token)', async (path) => {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' },
      body: 'x=1',
    });
    expect(response.status).toBe(403);
  });

  it('refuses identically for every failure: no body distinguishes missing, forged or consumed proof', async () => {
    const bodies = new Set<string>();
    for (const cookie of [undefined, 'hadron_ceremony=forged']) {
      const response = await fetch(`${base}/passkeys/register/start`, { method: 'POST', headers: cookie ? { cookie } : {} });
      expect(response.status).toBe(403);
      bodies.add(await response.text());
    }
    expect(bodies.size).toBe(1);
  });
});
