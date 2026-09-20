/**
 * #560 — `POST /auth/email` is throttled, per IP and per recipient.
 *
 * The defect: the endpoint calls Resend for any caller-supplied address with no
 * brake at all — an email bomb aimed at arbitrary third parties, a Resend cost
 * drain, and a signup-enumeration oracle.
 *
 * The nearby claim that it did not need one was wrong, and checking it is what
 * made this worth fixing rather than closing. `buildAuthorizeEmailRateLimit`'s
 * docstring said the path was "portal-gated by the mandatory #505
 * `client_state` nonce". The nonce IS mandatory — and it is caller-supplied,
 * hashed, and written onto the token row, with nothing validating it against a
 * pre-registered value. Any string satisfies it. Its job is binding a handoff
 * code to one browser, not authenticating a sender. The first test below pins
 * exactly that, so the wrong rationale cannot quietly come back.
 *
 * TWO limiters, because either alone leaves the other threat open: per-IP
 * bounds one attacker, per-ADDRESS bounds what one victim's inbox receives —
 * and spreading a single target across many source addresses is how an email
 * bomb is actually sent, which a per-IP limit cannot see.
 *
 * `sendMagicLink` is mocked because the real one calls Resend. That also makes
 * the budget observable at all: `skipFailedRequests` uncounts 4xx/5xx, so with
 * an unmocked Resend every request would 500, consume nothing, and the limiter
 * would look broken while working perfectly.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../../server.js';

const sendMagicLinkMock = vi.hoisted(() => vi.fn());
vi.mock('../../auth/email.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../auth/email.js')>();
  // The limiter BUILDERS stay real — they are what is under test. Only the
  // Resend call is replaced.
  return { ...mod, sendMagicLink: sendMagicLinkMock };
});

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = await createServer();
  server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  sendMagicLinkMock.mockReset();
  sendMagicLinkMock.mockResolvedValue(undefined);
});

/**
 * `null` means "send no client_state at all". It cannot be `undefined`: a
 * default parameter fires on `undefined`, so the omission case would silently
 * send the default nonce and assert nothing. That is what the first draft of
 * this file did, and it passed the wrong thing.
 */
async function send(
  email: string,
  opts: { clientState?: string | null; ip?: string } = {},
): Promise<number> {
  const { clientState = 'nonce-x', ip = uniqueIp() } = opts;
  const res = await fetch(`${baseUrl}/auth/email`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Outside production the app sets `trust proxy`, so this is what `req.ip`
      // resolves to. Varying it per case keeps the PER-IP budget (10/15min,
      // shared by the whole file otherwise) from silently exhausting and
      // turning every later assertion into a 429 about the wrong limiter.
      'x-forwarded-for': ip,
    },
    body: JSON.stringify({ email, ...(clientState === null ? {} : { client_state: clientState }) }),
    signal: AbortSignal.timeout(10_000),
  });
  return res.status;
}

/** A fresh address per case, so the per-ADDRESS budget never leaks between tests. */
let n = 0;
const uniqueEmail = () => `victim-${Date.now()}-${n++}@example.test`;

/** Likewise for the per-IP budget. */
let ipN = 0;
const uniqueIp = () => `203.0.113.${(ipN++ % 250) + 1}`;

describe('#560 — the client_state nonce is not a gate', () => {
  it('accepts an ARBITRARY client_state, so it throttles nobody', async () => {
    // The premise of the whole fix. If this ever 400s, the nonce became a real
    // gate and the rationale this file corrects would be worth revisiting.
    expect(await send(uniqueEmail(), { clientState: 'not-a-real-nonce-just-a-string' })).toBe(200);
    expect(sendMagicLinkMock).toHaveBeenCalledOnce();
  });

  it('still REQUIRES the nonce to be present (#505 is unchanged)', async () => {
    // The limiter must not have loosened the existing contract.
    expect(await send(uniqueEmail(), { clientState: null })).toBe(400);
    expect(sendMagicLinkMock).not.toHaveBeenCalled();
  });
});

describe('#560 — per-recipient throttling', () => {
  it('cuts one address off after 5 sends, and does not call Resend again', async () => {
    const victim = uniqueEmail();
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push(await send(victim));

    expect(statuses.slice(0, 5), 'first five get through').toEqual([200, 200, 200, 200, 200]);
    expect(statuses.slice(5), 'the rest are refused').toEqual([429, 429]);

    // The assertion that makes this about EMAIL rather than about status codes:
    // a 429 that still reached Resend would have bombed the victim anyway.
    expect(sendMagicLinkMock).toHaveBeenCalledTimes(5);
  });

  it('does not spend a DIFFERENT address\'s budget', async () => {
    const a = uniqueEmail();
    for (let i = 0; i < 6; i++) await send(a);
    // `a` is now exhausted. A different recipient must be unaffected — without
    // this, a single global counter would satisfy the test above while denying
    // service to every user on the platform.
    expect(await send(uniqueEmail())).toBe(200);
  });

  it('treats differing capitalization as the SAME mailbox', async () => {
    const lower = uniqueEmail();
    const upper = lower.toUpperCase();
    for (let i = 0; i < 5; i++) await send(lower);
    // Case-folding is the difference between a limiter and a speed bump:
    // `Victim@x` and `victim@x` deliver to one inbox, so they must share one
    // budget or the brake is bypassed by pressing shift.
    expect(await send(upper)).toBe(429);
  });

  it('does not count a REFUSED request against the budget', async () => {
    const victim = uniqueEmail();
    // Four 400s (no nonce) must not consume the send budget — skipFailedRequests.
    for (let i = 0; i < 4; i++) expect(await send(victim, { clientState: null })).toBe(400);
    expect(await send(victim)).toBe(200);
    expect(sendMagicLinkMock).toHaveBeenCalledOnce();
  });
});

describe('#560 — per-IP throttling', () => {
  it('cuts one SOURCE off after 10 sends even though every address differs', async () => {
    // Every other case in this file varies the IP, which means the per-IP
    // limiter is exercised by none of them. Mounted-but-unasserted is the
    // failure shape this suite exists to avoid, so it is pinned here on its
    // own: one attacker, a fresh victim each time, which the per-ADDRESS
    // limiter cannot see.
    const ip = '198.51.100.7';
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push(await send(uniqueEmail(), { ip }));

    expect(statuses.filter((s) => s === 200), 'ten get through').toHaveLength(10);
    expect(statuses.slice(10), 'the rest are refused').toEqual([429, 429]);
    expect(sendMagicLinkMock).toHaveBeenCalledTimes(10);
  });

  it('does not spend a DIFFERENT source\'s budget', async () => {
    const ip = '198.51.100.8';
    for (let i = 0; i < 11; i++) await send(uniqueEmail(), { ip });
    // Exhausted for that source only — otherwise one abuser locks out everyone.
    expect(await send(uniqueEmail(), { ip: '198.51.100.9' })).toBe(200);
  });
});
