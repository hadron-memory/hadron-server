/**
 * #2988 — a sign-in email the provider REFUSED must not read as sent.
 *
 * The Resend SDK resolves a failure (HTTP 422, suppressed recipient, rejected sender) as `{ data: null, error }`
 * instead of throwing. `sendMagicLink` awaited the call and dropped the result, so `POST /auth/email` answered
 * `{ ok: true }` and the portal said "check your inbox" for a message that was never sent. Only the Resend SDK is
 * mocked here: the real sendMagicLink, the real limiters and the real routes run.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../../server.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { sendMagicLink } from '../../auth/email.js';

const sendMock = vi.hoisted(() => vi.fn());
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: sendMock };
  },
}));

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  process.env.RESEND_API_KEY = 're_test_2988';
  const app = await createServer();
  server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  await cleanDb(db);
  sendMock.mockReset();
});

const refused = { data: null, error: { message: 'recipient is suppressed', name: 'validation_error' } };
const accepted = { data: { id: 'em_1' }, error: null };

let n = 0;
const uniqueEmail = () => `holger-${Date.now()}-${n++}@example.test`;
let ipN = 0;
const uniqueIp = () => `198.51.100.${(ipN++ % 250) + 1}`;

async function post(path: string, body: Record<string, string>) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': uniqueIp() },
    body: JSON.stringify(body),
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
}

describe('#2988 sendMagicLink and the provider acknowledgement', () => {
  it('rejects when the provider resolves an error result', async () => {
    sendMock.mockResolvedValue(refused);
    await expect(sendMagicLink(uniqueEmail(), db)).rejects.toThrow(/did not acknowledge/);
  });

  it('rejects when the provider resolves no data and no error', async () => {
    sendMock.mockResolvedValue({ data: null, error: null });
    await expect(sendMagicLink(uniqueEmail(), db)).rejects.toThrow(/did not acknowledge/);
  });

  it('resolves when the provider acknowledges', async () => {
    sendMock.mockResolvedValue(accepted);
    await expect(sendMagicLink(uniqueEmail(), db)).resolves.toBeUndefined();
    expect(sendMock).toHaveBeenCalledOnce();
  });

  it('leaves no usable token behind when the send was refused', async () => {
    sendMock.mockResolvedValue(refused);
    const email = uniqueEmail();
    await expect(sendMagicLink(email, db)).rejects.toThrow();
    expect(await db.emailVerificationToken.count({ where: { email } })).toBe(0);
  });
});

describe('#2988 POST /auth/email', () => {
  it('does not answer ok:true for a refused send', async () => {
    sendMock.mockResolvedValue(refused);
    const res = await post('/auth/email', { email: uniqueEmail(), client_state: 'nonce' });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('"ok":true');
  });

  it('still answers ok:true when the provider acknowledges', async () => {
    sendMock.mockResolvedValue(accepted);
    const res = await post('/auth/email', { email: uniqueEmail(), client_state: 'nonce' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
