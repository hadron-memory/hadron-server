/**
 * #1789 Pin 2 — the rule covers plain HTTP endpoints, not only GraphQL and MCP. A real express app on a real socket:
 * a thrown fault answers the generic envelope with the request id (body and X-Request-Id header agree), the detail
 * reaches only the log, and a framework refusal (malformed JSON, 400) keeps its status.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
      } as never),
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
  // #4504 (Bradley P3, the double-log check): headers already gone out when the fault
  // surfaces — the carve-out must log ONCE and delegate, never answer, never log again.
  app.get('/auth-store-busy-headers-sent', (_req, res, next) => {
    res.status(200);
    res.write('partial ');
    next(new AuthStoreBusyError(
      new Prisma.PrismaClientKnownRequestError('Timed out fetching a new connection from the pool.', {
        code: 'P2024',
        clientVersion: '6.19.2',
      } as never),
    ));
  });
  app.use(internalFaultErrorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
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
    log.mockRestore();
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
    log.mockRestore();
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
    log.mockRestore();
  });

  it('#4504 (Bradley P3, double-log check): headers already sent → the fault logs EXACTLY once and the handler delegates, never answers', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    // With headers gone out, Express's final handler closes the connection; the fetch may
    // resolve with the partial body or reject on the truncated socket — either is the
    // delegation we assert. The pin is the log count.
    await fetch(base + '/auth-store-busy-headers-sent').catch(() => undefined);
    const faultCalls = log.mock.calls.filter((c) => String(c[0]).includes('internal_fault'));
    expect(faultCalls).toHaveLength(1);
    expect(faultCalls[0][1]).toEqual(expect.objectContaining({ site: 'auth-store-busy' }));
    log.mockRestore();
  });
});
