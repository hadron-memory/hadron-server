/**
 * #4677 (refs #419): unit pins of the admission adapter's own control flow, with the rate core mocked.
 * The refusal shapes pinned here are #4659's engineering shape, not a minted spec.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import type { PrismaClient } from '../generated/prisma/index.js';

const admit = vi.hoisted(() => vi.fn());
vi.mock('../lib/rateLimit/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/rateLimit/index.js')>()),
  admitRate: admit,
}));
// Item 3: the adapter must read the cookie under the shared constant's CURRENT value, whatever it is.
vi.mock('./cookieName.js', () => ({ AUTH_COOKIE_NAME: 'renamed_session_4677' }));

import { RateLimited } from '../lib/rateLimit/index.js';
import { buildAuthRateAdmission, authRateAdmissionName } from './authRate.js';
import { signJwt } from './jwt.js';

const liveDb = { user: { findFirst: vi.fn() }, signIn: { findFirst: vi.fn() } } as unknown as PrismaClient;
const fakeRes = () => {
  const res = { locals: {}, headersSent: false, set: vi.fn(), status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
};
const run = (handler: ReturnType<typeof buildAuthRateAdmission>, req: Partial<Request>, res: ReturnType<typeof fakeRes>, next = vi.fn()) =>
  handler({ headers: {}, cookies: {}, ip: '198.51.100.7', ...req } as Request, res as unknown as Response, next);

beforeEach(() => {
  admit.mockReset().mockResolvedValue({ admitted: true });
  (liveDb.user.findFirst as ReturnType<typeof vi.fn>).mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('#4677 item 1: next() runs outside the admission try', () => {
  it('a synchronous throw from next() propagates once; admission does not reclassify it or call next again', async () => {
    const boom = new Error('downstream threw synchronously');
    const next = vi.fn(() => { throw boom; });
    const res = fakeRes();
    await expect(run(buildAuthRateAdmission(liveDb, { protocol: 'rest', credential: 'none' }), {}, res, next)).rejects.toBe(boom);
    expect(admit).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
  it('the oauth carrier does not turn a downstream throw into an admission server_error either', async () => {
    const boom = new Error('downstream threw synchronously');
    const next = vi.fn(() => { throw boom; });
    const res = fakeRes();
    await expect(run(buildAuthRateAdmission(liveDb, { protocol: 'oauth', credential: 'none' }), {}, res, next)).rejects.toBe(boom);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('#4677 item 2: the retry-seconds invariant', () => {
  const withRetry = (value: unknown) => {
    const error = new RateLimited('CREDENTIALS', 1);
    (error.extensions as Record<string, unknown>).retryAfterSeconds = value;
    return error;
  };
  it.each([[0], [-5], [1.5], [Number.NaN], [Number.POSITIVE_INFINITY], ['900'], [undefined], [null]])(
    'a refusal carrying retryAfterSeconds=%s is refused loudly: no 429 body, no invented value, never next()', async (value) => {
      for (const protocol of ['rest', 'oauth'] as const) {
        admit.mockRejectedValueOnce(withRetry(value));
        const res = fakeRes();
        const next = vi.fn();
        await run(buildAuthRateAdmission(liveDb, { protocol, credential: 'none' }), {}, res, next);
        expect(res.set).not.toHaveBeenCalled();
        if (protocol === 'rest') {
          expect(next).toHaveBeenCalledTimes(1);
          expect(next.mock.calls[0][0]).toBeInstanceOf(Error);
          expect(res.status).not.toHaveBeenCalled();
        } else {
          expect(next).not.toHaveBeenCalled();
          expect(res.status).toHaveBeenCalledWith(500);
          expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'server_error' }));
        }
      }
    });
  it('a normal refusal carries one positive integer in the header and the body', async () => {
    admit.mockRejectedValueOnce(new RateLimited('CREDENTIALS', 42));
    const res = fakeRes();
    const next = vi.fn();
    await run(buildAuthRateAdmission(liveDb, { protocol: 'rest', credential: 'none' }), {}, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.set).toHaveBeenCalledWith({ 'Retry-After': '42', 'Cache-Control': 'no-store' });
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith({ error: 'RATE_LIMITED', code: 'RATE_LIMITED', fieldClass: 'CREDENTIALS', retryAfterSeconds: 42 });
  });
});

describe('#4677 item 3: one cookie-name source', () => {
  it('the consent cookie supplies the principal under the shared constant\'s current name, and the old literal does not', async () => {
    (liveDb.user.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'user-4677' });
    const token = await signJwt({ sub: 'user-4677', roles: ['READER'] });
    const handler = buildAuthRateAdmission(liveDb, { protocol: 'oauth', credential: 'cookie' });
    await run(handler, { cookies: { renamed_session_4677: token } }, fakeRes());
    expect(admit.mock.calls[0][2]).toMatchObject({ principal: 'USER:user-4677' });
    admit.mockClear();
    await run(handler, { cookies: { hadron_token: token } }, fakeRes());
    expect(admit.mock.calls[0][2].principal).toBeUndefined();
  });
});

describe('#4677 item 4: explicit credential and protocol choices', () => {
  it('the handler is named for its choices and the choices are honored independently', async () => {
    const handler = buildAuthRateAdmission(liveDb, { protocol: 'oauth', credential: 'bearer' });
    expect(handler.name).toBe(authRateAdmissionName('oauth', 'bearer'));
    (liveDb.user.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'user-4677' });
    const token = await signJwt({ sub: 'user-4677', roles: ['READER'] });
    await run(handler, { headers: { authorization: `Bearer ${token}` }, cookies: { renamed_session_4677: 'ignored' } }, fakeRes());
    expect(admit.mock.calls[0][2]).toMatchObject({ principal: 'USER:user-4677' });
    admit.mockRejectedValueOnce(new RateLimited('CREDENTIALS', 7));
    const res = fakeRes();
    await run(handler, {}, res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'temporarily_unavailable' }));
  });
});
