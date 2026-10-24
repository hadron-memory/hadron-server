/** #1631 S2a first red pin: a JWT cookie is a carrier, never ceremony proof. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../server.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { signJwt } from '../auth/jwt.js';

let server: Server | undefined;
let base: string;
let token: string;

beforeEach(async () => {
  await cleanDb(db);
  vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
  vi.stubEnv('PASSKEY_REGISTRATION_ENABLED', 'true');
  vi.stubEnv('PASSKEY_RP_ID', 'localhost');
  const user = await db.user.create({ data: { handle: 'ceremony-owner', roles: [] } });
  // A legitimately issued current JWT, not junk that an ordinary auth gate
  // would reject before the ceremony's stronger proof requirement.
  token = await signJwt({ sub: user.id, roles: [] });
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close((e) => e ? reject(e) : resolve()));
  server = undefined;
  vi.unstubAllEnvs();
});

async function boot() {
  server = httpServer(await createServer());
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('#1631 enabled ceremony refuses bearer-only callers', () => {
  it.each(['/passkeys/register/start', '/passkeys/revoke/start'])(
    '%s refuses a real sign-in bearer and the same JWT copied into a cookie', async (path) => {
      await boot();
      for (const auth of <Array<Record<string, string>>>[
        { authorization: `Bearer ${token}` },
        { cookie: `hadron_token=${token}` },
        { authorization: `Bearer ${token}`, cookie: `hadron_token=${token}` },
      ]) {
        const response = await fetch(`${base}${path}`, {
          method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: '{}',
        });
        expect(response.status).toBe(403);
        const text = await response.text();
        expect(text).not.toContain(token);
        expect(await db.passkeyCredential.count()).toBe(0);
      }
    },
  );

  it('leaves disabled routes ordinarily absent even for a valid bearer', async () => {
    vi.stubEnv('PASSKEY_REGISTRATION_ENABLED', 'false');
    await boot();
    for (const path of ['/passkeys/register/start', '/passkeys/revoke/start']) {
      const response = await fetch(`${base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
      expect(response.status).toBe(404);
      expect(await response.text()).toContain(`Cannot POST ${path}`);
    }
  });
});
