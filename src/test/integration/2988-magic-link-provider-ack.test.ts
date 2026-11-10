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

const captureMock = vi.hoisted(() => vi.fn());
vi.mock('@sentry/node', async (importActual) => {
  const actual = await importActual<typeof import('@sentry/node')>();
  return { ...actual, captureException: captureMock };
});

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
  captureMock.mockReset();
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

describe('#2988 the per-send log line', () => {
  function sendLines(spy: ReturnType<typeof vi.spyOn>): string[] {
    return spy.mock.calls
      .map((c: unknown[]) => c.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '))
      .filter((l: string) => l.includes('auth.magic_link.send'));
  }

  it('logs the provider message id, duration and outcome for an acknowledged send, with no address or token', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      sendMock.mockResolvedValue({ data: { id: 'em_abc123' }, error: null });
      const email = uniqueEmail();
      await sendMagicLink(email, db);
      const lines = sendLines(spy);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('em_abc123');
      expect(lines[0]).toMatch(/"outcome":"acked"/);
      expect(lines[0]).toMatch(/"durationMs":\d+/);
      const token = (await db.emailVerificationToken.findFirstOrThrow({ where: { email } })).token;
      expect(lines[0]).not.toContain(email);
      expect(lines[0]).not.toContain(email.split('@')[1]!);
      expect(lines[0]).not.toContain(token);
    } finally {
      spy.mockRestore();
    }
  });

  it('emits exactly the allowed field set, so a field cannot be added to the line unnoticed', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      sendMock.mockResolvedValue({ data: { id: 'em_keys' }, error: null });
      await sendMagicLink(uniqueEmail(), db);
      const raw = sendLines(spy)[0]!;
      const payload = JSON.parse(raw.slice(raw.indexOf('{'))) as Record<string, unknown>;
      expect(Object.keys(payload).sort()).toEqual(['durationMs', 'event', 'outcome', 'providerId']);

      spy.mockClear();
      sendMock.mockResolvedValue({ data: null, error: { message: 'm', name: 'validation_error' } });
      await expect(sendMagicLink(uniqueEmail(), db)).rejects.toThrow();
      const raw2 = sendLines(spy)[0]!;
      const refused = JSON.parse(raw2.slice(raw2.indexOf('{'))) as Record<string, unknown>;
      expect(Object.keys(refused).sort()).toEqual(['durationMs', 'event', 'outcome', 'providerError']);
    } finally {
      spy.mockRestore();
    }
  });

  it('logs a refused send with the provider error name and no address', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      sendMock.mockResolvedValue({ data: null, error: { message: 'x@example.test is suppressed', name: 'validation_error' } });
      const email = uniqueEmail();
      await expect(sendMagicLink(email, db)).rejects.toThrow();
      const lines = sendLines(spy);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/"outcome":"refused"/);
      expect(lines[0]).toContain('validation_error');
      // the provider's free-text message can echo the address, so it is never logged
      expect(lines[0]).not.toContain('suppressed');
      expect(lines[0]).not.toContain(email);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('#3012 the failure path of a sign-in send', () => {
  const leaky = (email: string) => ({ data: null, error: { message: `${email} is on the suppression list`, name: 'validation_error' } });

  function sendLines(spy: ReturnType<typeof vi.spyOn>): string[] {
    return spy.mock.calls
      .map((c: unknown[]) => c.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '))
      .filter((l: string) => l.includes('auth.magic_link.send'));
  }

  it('POST /auth/email: neither the fault log nor Sentry carries the address or the provider free text', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const email = uniqueEmail();
      sendMock.mockResolvedValue(leaky(email));
      const res = await post('/auth/email', { email, client_state: 'nonce' });
      expect(res.status).toBe(500);
      const logged = errSpy.mock.calls.map((c: unknown[]) => c.map((x) => (x instanceof Error ? `${x.name} ${x.message}` : JSON.stringify(x, (_k, v) => (v instanceof Error ? `${v.name} ${v.message}` : v)))).join(' ')).join('\n');
      const sentry = captureMock.mock.calls.map((c: unknown[]) => c.map((x) => (x instanceof Error ? `${x.name} ${x.message}` : JSON.stringify(x))).join(' ')).join('\n');
      expect(logged).toContain('internal_fault');
      expect(sentry).toContain('validation_error');
      for (const text of [logged, sentry]) {
        expect(text).not.toContain(email);
        expect(text).not.toContain('suppression list');
      }
    } finally {
      errSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('a send that throws logs outcome "error" with the error machine name, no address or token, and leaves no token row', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const email = uniqueEmail();
      const boom = Object.assign(new Error(`socket hang up talking about ${email}`), { name: 'ConnectTimeoutError' });
      sendMock.mockRejectedValue(boom);
      const thrown = await sendMagicLink(email, db).then(() => null, (e: unknown) => e as Error);
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown!.message).not.toContain(email);
      const lines = sendLines(spy);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/"outcome":"error"/);
      expect(lines[0]).toContain('ConnectTimeoutError');
      expect(lines[0]).not.toContain(email);
      const raw = lines[0]!;
      const payload = JSON.parse(raw.slice(raw.indexOf('{'))) as Record<string, unknown>;
      expect(Object.keys(payload).sort()).toEqual(['durationMs', 'event', 'outcome', 'providerError']);
      expect(await db.emailVerificationToken.count({ where: { email } })).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('a failing cleanup does not replace the original send failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const del = vi.spyOn(db.emailVerificationToken, 'deleteMany').mockRejectedValue(new Error('db down'));
    try {
      sendMock.mockResolvedValue(refused);
      await expect(sendMagicLink(uniqueEmail(), db)).rejects.toThrow(/did not acknowledge/);
      expect(del).toHaveBeenCalledOnce();
    } finally {
      del.mockRestore();
      warn.mockRestore();
    }
  });

  it('cleanup removes only this call\'s token, not an earlier delivered link for the same address', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const email = uniqueEmail();
      sendMock.mockResolvedValue(accepted);
      await sendMagicLink(email, db);
      const earlier = await db.emailVerificationToken.findFirstOrThrow({ where: { email } });
      sendMock.mockResolvedValue(refused);
      await expect(sendMagicLink(email, db)).rejects.toThrow();
      const rows = await db.emailVerificationToken.findMany({ where: { email } });
      expect(rows.map((r) => r.token)).toEqual([earlier.token]);
    } finally {
      warn.mockRestore();
    }
  });
});
