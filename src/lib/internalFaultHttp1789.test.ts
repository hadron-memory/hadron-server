/**
 * #1789 Pin 2 — the rule covers plain HTTP endpoints, not only GraphQL and MCP. A real express app on a real socket:
 * a thrown fault answers the generic envelope with the request id (body and X-Request-Id header agree), the detail
 * reaches only the log, and a framework refusal (malformed JSON, 400) keeps its status.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { assignRequestId } from './requestContext.js';
import { internalFaultErrorHandler, respondInternalFault } from './internalFault.js';

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
});
