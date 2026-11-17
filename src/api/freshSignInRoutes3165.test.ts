/**
 * #3165 (residual of #3047/#3155): the passkey-ceremony email route's THROWN-send path. The route catches a throw from
 * `sendCeremonySignInLink`, reports it to Sentry and answers the same `200 { ok: true }` either way (a failure only for
 * known addresses would be an enumeration oracle). #3155 pins that the sender throws name-only; this pins the route:
 * the exception Sentry receives is the name-only error (no recipient anywhere), and the response is unchanged.
 * Only the mail SDK and Sentry are stubbed; the sender and the route are the real ones.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const RECIPIENT = 'throw.target@example.test';
const sendMock = vi.hoisted(() => vi.fn());
vi.mock('resend', () => ({ Resend: class { emails = { send: sendMock }; } }));
const captureMock = vi.hoisted(() => vi.fn());
vi.mock('@sentry/node', async (importActual) => ({ ...(await importActual<typeof import('@sentry/node')>()), captureException: captureMock }));

class NetworkFault extends Error {
  constructor() {
    super(`connect ECONNRESET while sending to ${RECIPIENT}`);
    this.name = 'NetworkFault';
  }
}

const { createServer } = await import('../server.js');
const { db } = await import('../integrations/db/client.js');
const { cleanDb } = await import('../test/helpers.js');

const ORIGIN = 'https://sign.example.test';
let server: Server;
let base: string;

beforeAll(async () => {
  vi.stubEnv('RESEND_API_KEY', 're_test_3165');
  vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
  vi.stubEnv('PASSKEY_REGISTRATION_ENABLED', 'true');
  vi.stubEnv('PASSKEY_RP_ID', 'example.test');
  vi.stubEnv('SIGNING_CEREMONY_ORIGINS', ORIGIN);
  vi.stubEnv('BASE_URL', 'https://api.example.test');
  server = httpServer(await createServer());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllEnvs();
});
beforeEach(async () => {
  await cleanDb(db);
  sendMock.mockReset();
  captureMock.mockReset();
  sendMock.mockRejectedValue(new NetworkFault());
});

const startEmail = (email: string) => fetch(`${base}/passkeys/sign-in/email`, {
  method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ email }),
});

describe('sign-in link route: a thrown send (#3165)', () => {
  it('reports the name-only error to Sentry, never the recipient, and answers the same 200 { ok: true }', async () => {
    await db.user.create({ data: { handle: 'fsi-3165', email: RECIPIENT, roles: [] } });
    const r = await startEmail(RECIPIENT);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(captureMock).toHaveBeenCalledTimes(1);
    const captured = captureMock.mock.calls[0]![0] as Error;
    expect(captured.message).toBe('mail provider send failed: NetworkFault');
    expect((captured as { cause?: unknown }).cause).toBeUndefined();
    expect(JSON.stringify([captured.message, captured.stack])).not.toContain(RECIPIENT);
  });

  it('answers an address no one owns identically, with nothing sent and nothing reported (no enumeration oracle)', async () => {
    const r = await startEmail('nobody.here@example.test');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect(sendMock).not.toHaveBeenCalled();
    expect(captureMock).not.toHaveBeenCalled();
  });
});
