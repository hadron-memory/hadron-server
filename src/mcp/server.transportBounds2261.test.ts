/**
 * #2261 / #2259 — idle eviction and a per-principal cap on MCP transports.
 * Real Express server + real SDK transport over localhost HTTP/SSE, synthetic principals only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer as createHttpServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
import { createServer } from '../server.js';
import { signJwt } from '../auth/jwt.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { APP_KEY_PREFIX, hashAppKey } from '../middleware/auth.js';
import {
  mcpTransportStateForTests,
  sweepIdleMcpTransportsForTests,
} from './server.js';
import {
  CAP_RETRY_AFTER_SECONDS,
  idleTtlMs,
  maxSessionsPerPrincipal,
  mcpPrincipalKey,
  releaseOnceOnResponseEnd,
} from './transportBounds.js';

let server: Server;
let port: number;
let baseUrl: string;

beforeAll(async () => {
  server = createHttpServer(await createServer());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
});
afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(async () => {
  await cleanDb(db);
});
afterEach(() => {
  delete process.env.MCP_MAX_SESSIONS_PER_PRINCIPAL;
  delete process.env.MCP_TRANSPORT_IDLE_TTL_MS;
});

const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: '2261', version: '1' } } };
const listTools = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };

let githubSeq = 226100;
async function makeUser(): Promise<{ id: string; token: string }> {
  const githubId = githubSeq++;
  const id = generateId();
  await db.user.create({ data: { id, githubId, githubUsername: `u2261-${githubId}`, roles: ['READER'] } });
  const token = await signJwt({ sub: id, githubId, githubUsername: `u2261-${githubId}`, roles: ['READER'] });
  return { id, token };
}
async function makeAppKeys(n: number): Promise<{ appId: string; keys: Array<{ id: string; raw: string }> }> {
  const org = await db.organization.create({ data: { id: generateId(), name: 'Acme', urn: `acme-2261-${generateId().slice(-6)}` } });
  const app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'bot', urn: `${org.urn}:bot` } });
  const keys: Array<{ id: string; raw: string }> = [];
  for (let i = 0; i < n; i++) {
    const raw = `${APP_KEY_PREFIX}${generateId()}${generateId()}`;
    const row = await db.appKey.create({ data: { id: generateId(), appId: app.id, keyHash: hashAppKey(raw), keyPreview: raw.slice(-4) } });
    keys.push({ id: row.id, raw });
  }
  return { appId: app.id, keys };
}

function post(token: string | undefined, body: unknown, sessionId?: string, extra: Record<string, string> = {}): Promise<Response> {
  return fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extra,
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
/** An SSE GET held open until `close()`; resolves once headers arrive. */
function holdStream(token: string, sessionId: string): Promise<{ close: () => void; status: number }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path: '/mcp', method: 'GET', headers: { accept: 'text/event-stream', 'mcp-session-id': sessionId, authorization: `Bearer ${token}` } },
      (res) => {
        res.on('data', () => undefined);
        res.on('error', () => undefined);
        resolve({ status: res.statusCode ?? 0, close: () => req.destroy() });
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
const FAR_FUTURE = (): number => Date.now() + 10 * 3_600_000;

describe('#2261 principal key', () => {
  it('tags by kind, user first, never by clientId', () => {
    expect(mcpPrincipalKey({ userId: 'u1', appId: 'a1', appKeyId: 'k1', clientId: 'x' } as never)).toBe('user:u1');
    expect(mcpPrincipalKey({ appKeyId: 'k1', appId: 'a1' } as never)).toBe('appkey:k1');
    expect(mcpPrincipalKey({ appId: 'a1' } as never)).toBe('app:a1');
    expect(mcpPrincipalKey({ userId: 'u1', clientId: 'forged' } as never)).toBe(mcpPrincipalKey({ userId: 'u1', clientId: 'other' } as never));
  });
  it('a clientId-only principal gets a unique anon bucket per call', () => {
    const a = mcpPrincipalKey({ clientId: 'same' } as never);
    const b = mcpPrincipalKey({ clientId: 'same' } as never);
    expect(a.startsWith('anon:')).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe('#2261 env tunables', () => {
  it.each([
    ['0', 25], ['-3', 25], ['abc', 25], ['1.5', 25], ['1001', 25], ['', 25], ['1', 1], ['1000', 1000], ['7', 7],
  ])('MCP_MAX_SESSIONS_PER_PRINCIPAL=%j → %i', (raw, expected) => {
    process.env.MCP_MAX_SESSIONS_PER_PRINCIPAL = raw;
    expect(maxSessionsPerPrincipal()).toBe(expected);
  });
  it.each([
    ['0', 3_600_000], ['59999', 3_600_000], ['604800001', 3_600_000], ['x', 3_600_000], ['60000', 60_000], ['604800000', 604_800_000],
  ])('MCP_TRANSPORT_IDLE_TTL_MS=%j → %i', (raw, expected) => {
    process.env.MCP_TRANSPORT_IDLE_TTL_MS = raw;
    expect(idleTtlMs()).toBe(expected);
  });
  it('unset means the defaults', () => {
    expect(maxSessionsPerPrincipal()).toBe(25);
    expect(idleTtlMs()).toBe(3_600_000);
  });
});

describe('#2261 response-lifetime guard', () => {
  it('releases exactly once across close, finish and an explicit call', () => {
    const handlers: Record<string, () => void> = {};
    let n = 0;
    const early = releaseOnceOnResponseEnd({ once: (e, l) => { handlers[e] = l; } }, () => { n++; });
    handlers.close();
    handlers.finish();
    early();
    expect(n).toBe(1);
  });
});

describe('#2261 idle eviction', () => {
  it('closes an idle transport past the TTL and empties every side map', async () => {
    const { token } = await makeUser();
    const id = await open(token);
    expect(mcpTransportStateForTests().sessionIds).toContain(id);
    await sweepIdleMcpTransportsForTests(Date.now() + 30_000); // inside the TTL: kept
    expect(mcpTransportStateForTests().sessionIds).toContain(id);
    await sweepIdleMcpTransportsForTests(FAR_FUTURE());
    const s = mcpTransportStateForTests();
    expect(s.sessionIds).not.toContain(id);
    expect(s.sideMapKeys.activeApp).not.toContain(id);
    expect(s.sideMapKeys.workerSessions).not.toContain(id);
    expect(s.sideMapKeys.sharedConnections).not.toContain(id);
    expect(s.sideMapKeys.actorsSeen).not.toContain(id);
    // The existing recovery contract: an evicted id answers 404 / -32001 and the client re-initializes.
    const r = await post(token, listTools, id);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null });
    const revived = await open(token);
    expect((await post(token, listTools, revived)).status).toBe(200);
  });

  it('a request refreshes activity, so a used session outlives an unused one', async () => {
    const { token } = await makeUser();
    const used = await open(token);
    const unused = await open(token);
    const at = mcpTransportStateForTests().entries[unused].lastActivityAt;
    await sleep(15);
    expect((await post(token, listTools, used)).status).toBe(200);
    const s = mcpTransportStateForTests();
    expect(s.entries[used].lastActivityAt).toBeGreaterThan(at);
    expect(s.entries[used].inFlight).toBe(0);
  });

  it('an open GET stream pins its transport past the TTL; evictable once it closes', async () => {
    const { token } = await makeUser();
    const id = await open(token);
    const stream = await holdStream(token, id);
    expect(stream.status).toBe(200);
    expect(mcpTransportStateForTests().entries[id].inFlight).toBe(1);
    await sweepIdleMcpTransportsForTests(FAR_FUTURE());
    expect(mcpTransportStateForTests().sessionIds).toContain(id);
    stream.close();
    await until(() => mcpTransportStateForTests().entries[id]?.inFlight === 0);
    await sweepIdleMcpTransportsForTests(FAR_FUTURE());
    expect(mcpTransportStateForTests().sessionIds).not.toContain(id);
  });

  it('an aborted request releases its count (no stuck counter)', async () => {
    const { token } = await makeUser();
    const id = await open(token);
    for (let i = 0; i < 3; i++) {
      const s = await holdStream(token, id);
      await until(() => (mcpTransportStateForTests().entries[id]?.inFlight ?? 0) >= 1);
      s.close();
    }
    await until(() => mcpTransportStateForTests().entries[id]?.inFlight === 0);
  });

  it('error responses (stale credential, foreign principal) leave no count behind', async () => {
    const { token } = await makeUser();
    const other = await makeUser();
    const id = await open(token);
    expect((await post(other.token, listTools, id)).status).toBe(404);
    expect((await post('garbage', listTools, id)).status).toBe(401);
    expect((await post(undefined, listTools, id)).status).toBe(401);
    await until(() => mcpTransportStateForTests().entries[id]?.inFlight === 0);
  });

  it('a queued POST behind a slow one counts as in flight from arrival', async () => {
    const { token } = await makeUser();
    const id = await open(token);
    const before = mcpTransportStateForTests().entries[id].inFlight;
    const batch = await Promise.all(Array.from({ length: 4 }, () => post(token, listTools, id)));
    expect(batch.every((r) => r.status === 200)).toBe(true);
    await Promise.all(batch.map((r) => r.text()));
    await until(() => mcpTransportStateForTests().entries[id]?.inFlight === before);
  });

  it('the timer is not started under test', () => {
    expect(mcpTransportStateForTests().sweepTimerRunning).toBe(false);
  });
});

describe('#2261 per-principal cap', () => {
  it('evicts the least-recently-active idle transport of that principal, never another principal’s', async () => {
    process.env.MCP_MAX_SESSIONS_PER_PRINCIPAL = '2';
    const a = await makeUser();
    const b = await makeUser();
    const bSession = await open(b.token);
    const a1 = await open(a.token);
    await sleep(5);
    const a2 = await open(a.token);
    await sleep(5);
    expect((await post(a.token, listTools, a1)).status).toBe(200); // a1 now fresher than a2? no: a2 older than a1's refresh
    const a3 = await open(a.token);
    const ids = mcpTransportStateForTests().sessionIds;
    expect(ids).toContain(bSession);
    expect(ids).toContain(a1);
    expect(ids).toContain(a3);
    expect(ids).not.toContain(a2);
    expect((await post(a.token, listTools, a2)).status).toBe(404);
  });

  it('two users, two keys of one App, and a user with a forged clientId each count separately', async () => {
    process.env.MCP_MAX_SESSIONS_PER_PRINCIPAL = '1';
    const u1 = await makeUser();
    const u2 = await makeUser();
    const { keys } = await makeAppKeys(2);
    const sessions = [await open(u1.token), await open(u2.token), await open(keys[0].raw), await open(keys[1].raw)];
    const ids = mcpTransportStateForTests().sessionIds;
    for (const s of sessions) expect(ids).toContain(s);
    const keysSeen = sessions.map((s) => mcpTransportStateForTests().entries[s].principalKey);
    expect(new Set(keysSeen).size).toBe(4);
    expect(keysSeen[0]).toBe(`user:${u1.id}`);
    expect(keysSeen[2].startsWith('appkey:')).toBe(true);
  });

  it('refuses with 429 / Retry-After / -32000 when every transport of the principal is in flight, evicting nothing', async () => {
    process.env.MCP_MAX_SESSIONS_PER_PRINCIPAL = '2';
    const a = await makeUser();
    const s1 = await open(a.token);
    const s2 = await open(a.token);
    const h1 = await holdStream(a.token, s1);
    const h2 = await holdStream(a.token, s2);
    const r = await post(a.token, initialize);
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe(String(CAP_RETRY_AFTER_SECONDS));
    expect(await r.json()).toEqual({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Too many open MCP sessions for this credential (limit 2). Close one and retry.' },
      id: null,
    });
    expect(mcpTransportStateForTests().sessionIds).toEqual(expect.arrayContaining([s1, s2]));
    // A different principal is unaffected.
    const b = await makeUser();
    expect((await post(b.token, initialize)).status).toBe(200);
    h1.close();
    h2.close();
    await until(() => mcpTransportStateForTests().entries[s1]?.inFlight === 0);
    expect((await post(a.token, initialize)).status).toBe(200); // now an idle one can be evicted
  });

  it('concurrent initializes from one principal never exceed the cap; the refused ones release their reservation', async () => {
    process.env.MCP_MAX_SESSIONS_PER_PRINCIPAL = '3';
    const a = await makeUser();
    const results = await Promise.all(Array.from({ length: 8 }, () => post(a.token, initialize)));
    await Promise.all(results.map((r) => r.text()));
    const mine = Object.values(mcpTransportStateForTests().entries).filter((e) => e.principalKey === `user:${a.id}`);
    expect(mine.length).toBeLessThanOrEqual(3);
    expect(results.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(3);
    await until(() => mcpTransportStateForTests().reservations === 0);
  });

  it('an unauthenticated or refused initialize leaves no reservation', async () => {
    process.env.MCP_MAX_SESSIONS_PER_PRINCIPAL = '2';
    for (let i = 0; i < 5; i++) expect((await post('garbage', initialize)).status).toBe(401);
    await until(() => mcpTransportStateForTests().reservations === 0);
    const a = await makeUser();
    await open(a.token);
    await open(a.token);
    await until(() => mcpTransportStateForTests().reservations === 0);
  });
});

describe('#2261 eviction touches connection-local state only', () => {
  /** Calls one tool over HTTP and returns its text (the SDK answers as SSE or JSON). */
  async function callTool(token: string, sessionId: string, name: string, args: Record<string, unknown>): Promise<string> {
    const r = await post(token, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } }, sessionId);
    expect(r.status).toBe(200);
    const raw = await r.text();
    const data = raw.split('\n').find((l) => l.startsWith('data:'));
    const msg = JSON.parse(data ? data.slice(5) : raw) as { result?: { content?: Array<{ text?: string }> } };
    return (msg.result?.content ?? []).map((c) => c.text ?? '').join('\n');
  }

  async function workerFixture(): Promise<{ userId: string; token: string; workerId: string }> {
    const { id: userId, token } = await makeUser();
    const org = await db.organization.create({ data: { id: generateId(), name: 'Team', urn: `team-2261-${generateId().slice(-6)}.com` } });
    await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId, role: 'CONTRIBUTOR' } });
    const agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:backend`, name: 'Backend', visibility: 'ORGANIZATION' } });
    const app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team App', urn: `${org.urn}:team` } });
    await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
    const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'Iris', slug: 'iris' } });
    return { userId, token, workerId: worker.id };
  }

  it('leaves the durable Session row and worker hold unchanged; resume lands on the same open session', async () => {
    const { userId, token, workerId } = await workerFixture();
    const sid = await open(token);
    const started = await callTool(token, sid, 'hadron_start_session', { description: 'evict me', workerRef: workerId });
    const sessionId = started.match(/Session started: (\S+)/)?.[1];
    expect(sessionId, started).toBeTruthy();
    const claim = await callTool(token, sid, 'hadron_create_resume_claim', {});
    expect(claim).toContain(sessionId!);

    const beforeSession = await db.session.findUniqueOrThrow({ where: { id: sessionId! } });
    const beforeWorker = await db.worker.findUniqueOrThrow({ where: { id: workerId } });
    await sweepIdleMcpTransportsForTests(FAR_FUTURE());
    expect(mcpTransportStateForTests().sessionIds).not.toContain(sid);
    expect(await db.session.findUniqueOrThrow({ where: { id: sessionId! } })).toEqual(beforeSession);
    expect(await db.worker.findUniqueOrThrow({ where: { id: workerId } })).toEqual(beforeWorker);
    expect(beforeSession.endedAt).toBeNull();

    const fresh = await open(token);
    const resumed = await callTool(token, fresh, 'hadron_resume_session', {});
    expect(resumed).toContain(sessionId!);
    expect(await db.session.count({ where: { userId } })).toBe(1);
  });

  it('a different principal presenting an evicted id gets the same 404 and creates no state', async () => {
    const a = await makeUser();
    const b = await makeUser();
    const id = await open(a.token);
    await sweepIdleMcpTransportsForTests(FAR_FUTURE());
    const r = await post(b.token, listTools, id);
    expect(r.status).toBe(404);
    expect(mcpTransportStateForTests().sessionIds).not.toContain(id);
  });
});
