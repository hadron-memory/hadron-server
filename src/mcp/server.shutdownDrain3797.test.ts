/**
 * #3797 — the end of the stopping drain window must not wait on a held `GET /mcp` stream.
 * Real Express server + real SDK transport over localhost, synthetic principals only. The shutdown step under test is
 * `closeHttpListenerForShutdown`, the exact function `src/index.ts` runs at window end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer as createHttpServer, request as httpRequest, Agent, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../server.js';
import { signJwt } from '../auth/jwt.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
import { serveAgentBootPrompt } from '../test/servedBootPrompt.js';
import { startWorkerSessionGql } from '../test/startWorkerSessionGql.js';
import { closeHttpListenerForShutdown } from '../lib/httpShutdown.js';
import { mcpTransportStateForTests } from './server.js';

/** Lets a test hold a POST /mcp suspended inside the role refresh (in flight on its transport). */
const gate = vi.hoisted(() => ({ hold: null as Promise<void> | null, entered: 0, authHold: null as Promise<void> | null, authEntered: 0 }));
vi.mock('../middleware/auth.js', async (orig) => {
  const real = await orig<typeof import('../middleware/auth.js')>();
  return {
    ...real,
    resolveAuthContext: async (...args: Parameters<typeof real.resolveAuthContext>) => {
      if (gate.authHold && args[0].method === 'GET') {
        gate.authEntered += 1;
        await gate.authHold;
      }
      return real.resolveAuthContext(...args);
    },
    getCurrentUserRoles: async (...args: Parameters<typeof real.getCurrentUserRoles>) => {
      if (gate.hold) {
        gate.entered += 1;
        await gate.hold;
      }
      return real.getCurrentUserRoles(...args);
    },
  };
});

let server: Server;
let expressApp: Awaited<ReturnType<typeof createServer>>;
let port: number;
let baseUrl: string;

beforeEach(async () => {
  await cleanDb(db);
  expressApp = await createServer();
  const app = expressApp;
  server = createHttpServer((req, res) => {
    if (req.url === '/__slow') {
      setTimeout(() => res.end('slow-ok'), 400);
      return;
    }
    app(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
});
afterEach(async () => {
  gate.hold = null;
  gate.authHold = null;
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: '3797', version: '1' } } };
const listTools = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };

let githubSeq = 379700;
async function makeUser(): Promise<{ id: string; token: string }> {
  const githubId = githubSeq++;
  const id = generateId();
  await db.user.create({ data: { id, githubId, githubUsername: `u3797-${githubId}`, roles: ['READER'] } });
  const token = await signJwt({ sub: id, githubId, githubUsername: `u3797-${githubId}`, roles: ['READER'] });
  return { id, token };
}
function post(token: string, body: unknown, sessionId?: string): Promise<Response> {
  return fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}
async function open(token: string): Promise<string> {
  const r = await post(token, initialize);
  expect(r.status).toBe(200);
  await r.text();
  return r.headers.get('mcp-session-id')!;
}
/** An SSE GET held open; `ended` resolves when the SERVER ends the stream. */
function holdStream(token: string, sessionId: string): Promise<{ status: number; ended: Promise<void>; destroy: () => void }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path: '/mcp', method: 'GET', headers: { accept: 'text/event-stream', 'mcp-session-id': sessionId, authorization: `Bearer ${token}` } },
      (res) => {
        const ended = new Promise<void>((r) => {
          res.on('end', () => r());
          res.on('close', () => r());
          res.on('error', () => r());
        });
        res.on('data', () => undefined);
        resolve({ status: res.statusCode ?? 0, ended, destroy: () => req.destroy() });
      },
    );
    req.on('error', (e) => {
      if ((e as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(e);
    });
    req.end();
  });
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met');
    await sleep(20);
  }
}
/** The drain result, or 'stuck' if it does not settle within `ms` (the process would sit to its hard deadline). */
async function drain(ms = 2500): Promise<boolean | 'stuck'> {
  return Promise.race([closeHttpListenerForShutdown(server), sleep(ms).then(() => 'stuck' as const)]);
}

describe('#3797 held SSE cleanup', () => {
  it('a held GET /mcp stream does not keep the listener close from completing', async () => {
    const { token } = await makeUser();
    const id = await open(token);
    const stream = await holdStream(token, id);
    expect(stream.status).toBe(200);
    expect(await drain()).toBe(true);
    await stream.ended;
  });

  it('closes every registered transport, with its connection-local state', async () => {
    const a = await makeUser();
    const b = await makeUser();
    const ids = [await open(a.token), await open(b.token)];
    const streams = await Promise.all([holdStream(a.token, ids[0]), holdStream(b.token, ids[1])]);
    expect(await drain()).toBe(true);
    expect(mcpTransportStateForTests().sessionIds).toEqual([]);
    await Promise.all(streams.map((s) => s.ended));
  });

  it('an idle transport with no stream is closed too', async () => {
    const { token } = await makeUser();
    await open(token);
    expect(await drain()).toBe(true);
    expect(mcpTransportStateForTests().sessionIds).toEqual([]);
  });
});

describe('#3797 idle keep-alive (Node close() already ends it; regression pin on the repo Node)', () => {
  it('an idle keep-alive connection does not hold close()', async () => {
    const agent = new Agent({ keepAlive: true });
    await new Promise<void>((resolve, reject) => {
      httpRequest({ host: '127.0.0.1', port, path: '/ready', agent }, (res) => {
        res.resume();
        res.on('end', resolve);
      }).on('error', reject).end();
    });
    try {
      expect(await drain()).toBe(true);
    } finally {
      agent.destroy();
    }
  });
});

describe('#3797 in-flight work still drains', () => {
  it('an ordinary non-MCP request in flight completes normally', async () => {
    const slow = fetch(`${baseUrl}/__slow`).then((r) => r.text());
    await sleep(80);
    const drained = drain(4000);
    expect(await slow).toBe('slow-ok');
    expect(await drained).toBe(true);
  });

  it('a POST /mcp in flight on a transport that also holds a GET stream completes; the stream is ended', async () => {
    const { token } = await makeUser();
    const id = await open(token);
    const stream = await holdStream(token, id);
    let release!: () => void;
    gate.hold = new Promise<void>((r) => (release = r));
    const inFlight = post(token, listTools, id);
    await until(() => gate.entered >= 1);

    const drained = drain(4000);
    await stream.ended; // the held GET is ended at once...
    await sleep(150);
    gate.hold = null;
    release(); // ...while the POST was still suspended, and now finishes
    const r = await inFlight;
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).toContain('"tools"');
    expect(await drained).toBe(true);
    expect(mcpTransportStateForTests().sessionIds).toEqual([]);
  });

  it('a GET still authenticating when the drain starts is ended once it registers its stream', async () => {
    const { token } = await makeUser();
    const id = await open(token);
    let release!: () => void;
    gate.authHold = new Promise<void>((r) => (release = r));
    const before = gate.authEntered;
    const late = holdStream(token, id);
    await until(() => gate.authEntered > before);

    const drained = drain(4000);
    await sleep(100); // the shutdown pass has run; this GET has no stream registered yet
    gate.authHold = null;
    release();
    const stream = await late;
    expect(stream.status).toBe(200);
    await stream.ended;
    expect(await drained).toBe(true);
    expect(mcpTransportStateForTests().sessionIds).toEqual([]);
  });
});

describe('#3797 the durable session survives a shutdown-closed transport', () => {
  it('leaves the worker Session open and its hold kept; a reconnect re-attributes through X-Hadron-Session', async () => {
    const { id: userId, token } = await makeUser();
    const org = await db.organization.create({ data: { id: generateId(), name: 'Team', urn: `team-3797-${generateId().slice(-6)}.com` } });
    await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId, role: 'CONTRIBUTOR' } });
    const agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:backend`, name: 'Backend', visibility: 'ORGANIZATION' } });
    await serveAgentBootPrompt(db, agent.id, 'Test boot prompt.');
    const app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team App', urn: `${org.urn}:team` } });
    await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
    const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'Iris', slug: 'iris' } });
    const sid = await open(token);
    const sessionId = await startWorkerSessionGql({ workerRef: worker.id, userId, appId: app.id });
    const stream = await holdStream(token, sid);

    const beforeSession = await db.session.findUniqueOrThrow({ where: { id: sessionId } });
    const beforeWorker = await db.worker.findUniqueOrThrow({ where: { id: worker.id } });
    expect(await drain()).toBe(true);
    await stream.ended;
    expect(await db.session.findUniqueOrThrow({ where: { id: sessionId } })).toEqual(beforeSession);
    expect(await db.worker.findUniqueOrThrow({ where: { id: worker.id } })).toEqual(beforeWorker);
    expect(beforeSession.endedAt).toBeNull();

    // A reconnecting client (the next listener, a fresh transport) re-attributes through X-Hadron-Session, never
    // through hadron_resume_session (off on MCP, #3082).
    const next = createHttpServer(expressApp);
    await new Promise<void>((resolve) => next.listen(0, '127.0.0.1', resolve));
    try {
      const nextUrl = `http://127.0.0.1:${(next.address() as AddressInfo).port}/mcp`;
      const headers = { accept: 'application/json, text/event-stream', 'content-type': 'application/json', authorization: `Bearer ${token}` };
      const init = await fetch(nextUrl, { method: 'POST', headers, body: JSON.stringify(initialize) });
      expect(init.status).toBe(200);
      await init.text();
      const sid2 = init.headers.get('mcp-session-id')!;
      const call = await fetch(nextUrl, {
        method: 'POST',
        headers: { ...headers, 'mcp-session-id': sid2, 'x-hadron-session': sessionId },
        body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'hadron_whoami', arguments: {} } }),
      });
      expect(call.status).toBe(200);
      expect(await call.text()).toContain(sessionId);
    } finally {
      next.closeAllConnections?.();
      await new Promise<void>((resolve) => next.close(() => resolve()));
    }
  });
});
