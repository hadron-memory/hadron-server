/**
 * #1789 Pin 2 — the rule covers plain HTTP endpoints, not only GraphQL and MCP. A real express app on a real socket:
 * a thrown fault answers the generic envelope with the request id (body and X-Request-Id header agree), the detail
 * reaches only the log, and a framework refusal (malformed JSON, 400) keeps its status.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Prisma } from '../generated/prisma/index.js';
import { assignRequestId } from './requestContext.js';
import { internalFaultErrorHandler, respondInternalFault } from './internalFault.js';
import { AUTH_STORE_BUSY_MESSAGE, AUTH_STORE_UNREACHABLE_MESSAGE, AuthStoreBusyError } from './authStoreBusy.js';

const secret = 'connect ECONNREFUSED 10.0.0.7:5432 password=hunter2';
let server: Server;
let base = '';

/** #4592 F3: the tampered-reason fixtures, ONE named table shared by the route that plants each reason and the assertions on the wire. */
const TAMPERED_CASES: Array<{ name: string; reason: unknown; wireReason: 'STORE_UNREACHABLE' | 'POOL_WAIT'; message: string }> = [
  { name: 'unreachable', reason: 'STORE_UNREACHABLE', wireReason: 'STORE_UNREACHABLE', message: AUTH_STORE_UNREACHABLE_MESSAGE },
  { name: 'pool-wait', reason: 'POOL_WAIT', wireReason: 'POOL_WAIT', message: AUTH_STORE_BUSY_MESSAGE },
  { name: 'absent', reason: undefined, wireReason: 'POOL_WAIT', message: AUTH_STORE_BUSY_MESSAGE },
  { name: 'driver-text', reason: 'driver-secret', wireReason: 'POOL_WAIT', message: AUTH_STORE_BUSY_MESSAGE },
  { name: 'object', reason: { detail: 'driver-secret' }, wireReason: 'POOL_WAIT', message: AUTH_STORE_BUSY_MESSAGE },
];

beforeAll(async () => {
  const app = express();
  app.use(assignRequestId);
  app.use(express.json());
  app.get('/throws', () => { throw new Error(secret); });
  app.get('/catches', (_req, res) => { try { throw new Error(secret); } catch (e) { respondInternalFault(res, 'test', e); } });
  app.post('/echo', (req, res) => { res.json(req.body); });
  // #4471: the auth middleware's typed store-busy fault forwarded via next(err), as the
  // /graphql/schema, /reload and /sessions/:id/outcome routes forward it.
  app.get('/auth-store-busy', (_req, _res, next) => {
    next(new AuthStoreBusyError(
      new Prisma.PrismaClientKnownRequestError('Timed out fetching a new connection from the pool.', {
        code: 'P2024',
        clientVersion: '6.19.2',
      }),
      'POOL_WAIT',
    ));
  });
  // #4504: the unreachable arm, same forwarding shape.
  app.get('/auth-store-unreachable', (_req, _res, next) => {
    next(new AuthStoreBusyError(
      new Prisma.PrismaClientInitializationError(
        "Can't reach database server at `127.0.0.1:5432` after 1 attempts",
        '6.19.2',
        'P1001',
      ),
      'STORE_UNREACHABLE',
    ));
  });
  // #4519 (BLIND P3-4, the boundary pin): a typed error whose `.message` was TAMPERED to carry
  // driver text — constructor drift, a subclass with its own prose, a late mutation — must still
  // answer the reason's fixed prose. The boundary renders from the reason, never from the message.
  app.get('/auth-store-busy-tampered/:variant', (req, res, next) => {
    // #4592 F3: an unknown variant name is a loud 404, never silently the absent-value case.
    const fixture = TAMPERED_CASES.find((c) => c.name === req.params.variant);
    if (!fixture) { res.status(404).send('unknown tampered fixture variant'); return; }
    const tampered = new AuthStoreBusyError(
      new Prisma.PrismaClientInitializationError(
        "Can't reach database server at `10.9.8.7:5432`",
        '6.19.2',
        'P1001',
      ),
      'STORE_UNREACHABLE',
    );
    tampered.message = "Can't reach database server at `10.9.8.7:5432`";
    tampered.extensions.reason = fixture.reason;
    next(tampered);
  });
  // #4504 (Bradley P3, the double-log check): headers already gone out when the fault
  // surfaces — the carve-out must log ONCE and delegate, never answer, never log again.
  app.get('/auth-store-busy-headers-sent', (_req, res, next) => {
    res.status(200);
    res.write('partial ');
    next(new AuthStoreBusyError(
      new Prisma.PrismaClientKnownRequestError('Timed out fetching a new connection from the pool.', {
        code: 'P2024',
        clientVersion: '6.19.2',
      }),
      'POOL_WAIT',
    ));
  });
  app.use(internalFaultErrorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => new Promise<void>((resolve) => { server.close(() => resolve()); }));

describe('plain HTTP internal faults (#1789)', () => {
  it.each(['/throws', '/catches'])('%s answers the generic envelope; header and body carry the same id; no detail leaks', async (path) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await fetch(base + path);
    const text = await res.text();
    const body = JSON.parse(text);
    expect(res.status).toBe(500);
    expect(body).toEqual({ error: 'Internal server error.', code: 'INTERNAL_SERVER_ERROR', requestId: res.headers.get('x-request-id') });
    expect(text).not.toMatch(/hunter2|ECONNREFUSED|at \w+.*\.ts/);
    expect(log).toHaveBeenCalledWith('[http] internal_fault', expect.objectContaining({ requestId: body.requestId }));
  });

  it('two identical faults on separate requests get distinct request ids', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const [a, b] = await Promise.all([fetch(base + '/throws'), fetch(base + '/throws')]);
    expect(a.headers.get('x-request-id')).not.toBe(b.headers.get('x-request-id'));
    vi.restoreAllMocks();
  });

  it('a caller-supplied X-Request-Id is never adopted', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await fetch(base + '/throws', { headers: { 'X-Request-Id': 'attacker-1' } });
    expect(res.headers.get('x-request-id')).not.toBe('attacker-1');
    vi.restoreAllMocks();
  });

  it('control: a framework refusal (malformed JSON) keeps its 400 and is not folded into the generic code', async () => {
    const res = await fetch(base + '/echo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain('INTERNAL_SERVER_ERROR');
  });

  it('#4471: the typed auth store-busy fault keeps its 503 and its code — and is logged, not swallowed (BLIND P2-2)', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await fetch(base + '/auth-store-busy');
    const text = await res.text();
    const body = JSON.parse(text);
    expect(res.status).toBe(503);
    expect(body.error).toBe(AUTH_STORE_BUSY_MESSAGE);
    expect(body.code).toBe('AUTH_STORE_BUSY');
    expect(body.retryable).toBe(true);
    expect(body.reason).toBe('POOL_WAIT');
    // Correlation like the generic envelope: the body's id is the request's id.
    expect(body.requestId).toBe(res.headers.get('x-request-id'));
    // The fault (driver error on .cause) reaches ONLY the log, under that id — the carve-out
    // is not a blind spot, so "countable evidence" holds on this surface too.
    expect(log).toHaveBeenCalledWith('[http] internal_fault', expect.objectContaining({ requestId: body.requestId, site: 'auth-store-busy' }));
    expect(text).not.toMatch(/P2024|Timed out fetching|INTERNAL_SERVER_ERROR/);
    // #4504 (Bradley P3): exactly one fault line — the carve-out answers this request alone.
    expect(log).toHaveBeenCalledTimes(1);
    // #4504 (Bradley P3, the .cause half): the logged error is the typed fault with the
    // driver error on `.cause` — an operator reading the log sees the P2024 itself.
    const logged = log.mock.calls[0][1] as { error: AuthStoreBusyError };
    expect(logged.error).toBeInstanceOf(AuthStoreBusyError);
    expect(logged.error.cause).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((logged.error.cause as Prisma.PrismaClientKnownRequestError).code).toBe('P2024');
  });

  it('#4504: the unreachable arm keeps the same 503 carve-out with its sibling prose — and its P1001 reaches the log the same way', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await fetch(base + '/auth-store-unreachable');
    const text = await res.text();
    const body = JSON.parse(text);
    expect(res.status).toBe(503);
    expect(body.error).toBe(AUTH_STORE_UNREACHABLE_MESSAGE);
    expect(body.code).toBe('AUTH_STORE_BUSY');
    expect(body.retryable).toBe(true);
    expect(body.reason).toBe('STORE_UNREACHABLE');
    expect(body.requestId).toBe(res.headers.get('x-request-id'));
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('[http] internal_fault', expect.objectContaining({ requestId: body.requestId, site: 'auth-store-busy' }));
    // The driver error (P1001 with its host:port) reaches ONLY the log.
    const logged = log.mock.calls[0][1] as { error: AuthStoreBusyError };
    expect(logged.error.cause).toBeInstanceOf(Prisma.PrismaClientInitializationError);
    expect((logged.error.cause as Prisma.PrismaClientInitializationError).errorCode).toBe('P1001');
    expect(text).not.toMatch(/P1001|Can't reach|127\.0\.0\.1|INTERNAL_SERVER_ERROR/);
  });

  it.each(TAMPERED_CASES)('#4555: tampered variant $name keeps every wire field fixed', async ({ name: variant, wireReason: reason, message }) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await fetch(base + '/auth-store-busy-tampered/' + variant);
    const text = await res.text();
    expect(res.status).toBe(503);
    expect(JSON.parse(text)).toEqual({
      error: message, code: 'AUTH_STORE_BUSY', retryable: true, reason,
      requestId: res.headers.get('x-request-id'),
    });
    expect(text).not.toMatch(/driver-secret|Can't reach|P1001|10\.9\.8\.7|INTERNAL_SERVER_ERROR/);
    // logInternalFault's declared envelope is {requestId, site, error}; only its error retains detail.
    expect(log).toHaveBeenCalledExactlyOnceWith('[http] internal_fault', expect.objectContaining({
      requestId: res.headers.get('x-request-id'), site: 'auth-store-busy',
      error: expect.any(AuthStoreBusyError),
    }));
    const logged = log.mock.calls[0][1] as { error: AuthStoreBusyError };
    expect(logged.error.message).toMatch(/Can't reach database server/);
  });

  it('#4504 (Bradley P3, double-log check): headers already sent → the fault logs EXACTLY once and the handler delegates, never answers', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    // With headers gone out, Express's final handler closes the connection; the fetch may
    // resolve with the partial body or reject on the truncated socket — either is the
    // delegation we assert. The pin is the log count.
    const res = await fetch(base + '/auth-store-busy-headers-sent').catch(() => undefined);
    // #4519 (BLIND P3-6): drain the body on the resolve path — an undrained response keeps its
    // socket held in the keep-alive pool, and afterAll's server.close() then waits on it.
    if (res) await res.text().catch(() => undefined);
    const faultCalls = log.mock.calls.filter((c) => String(c[0]).includes('internal_fault'));
    expect(faultCalls).toHaveLength(1);
    // logInternalFault's declared envelope carries the site and original typed error.
    expect(faultCalls[0][1]).toEqual(expect.objectContaining({ site: 'auth-store-busy', error: expect.any(AuthStoreBusyError) }));
  });
});
