/**
 * #3401 D1 over the REAL MCP HTTP transport (`handleMcpRequest`), which `createTestableMcpServer` bypasses: a
 * transport keeps the `auth` it was initialized with, including the session the App key was bound to. Once the key
 * reads its person's personal/private session memory (ruling 0203), that retained session must not keep reading
 * after it ends, expires or goes dormant, whether or not later requests repeat the session header. Private memory
 * too, while ANOTHER live session of the same memory still holds its key in the session key cache.
 *
 * The sessions are made by `startAgentSession` (USER_ID for personal, SECRET for private), GraphQL reads go over
 * real HTTP with `X-Hadron-Session`, and every refusal is compared with the answer for an unknown memory.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { APP_KEY_PREFIX, hashAppKey, validateSessionBinding } from '../middleware/auth.js';
import { parseDataKey } from '../lib/crypto.js';
import { encryptNodeFieldsWithKey } from '../lib/nodeCrypto.js';
import { sessionKeyCache } from '../lib/sessionKeyCache.js';
import { drainNodeUsage } from '../lib/usageRecorder.js';
import { closeServerIfStarted, createServerOnCleanDb } from '../test/startServerFixture.js';

vi.mock('../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const opKey = Buffer.alloc(32, 34).toString('base64');
let server: Server;
let baseUrl: string;
let appId: string;
let agentId: string;
let orgUrn: string;
let key: string;

beforeAll(async () => {
  server = createHttpServer(await createServerOnCleanDb());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await closeServerIfStarted(server); });
afterEach(() => sessionKeyCache.clear());

beforeEach(async () => {
  await cleanDb(db);
  sessionKeyCache.clear();
  const s = generateId().toLowerCase().slice(-8);
  orgUrn = `w3401-${s}.test`;
  const org = await db.organization.create({ data: { id: generateId(), name: 'w3401', urn: orgUrn } });
  agentId = (await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'A', urn: `${orgUrn}:a` } })).id;
  appId = (await db.app.create({
    data: { id: generateId(), organizationId: org.id, name: 'X', urn: `${orgUrn}:x`, identifyUserMethod: 'USER_ID', createUserPermission: 'IMPLICIT' },
  })).id;
  await db.appAgent.create({ data: { appId, agentId } });
  key = `${APP_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  await db.appKey.create({ data: { id: generateId(), appId, keyHash: hashAppKey(key), keyPreview: key.slice(-4), label: 'k' } });
});

async function gql(query: string, variables: Record<string, unknown>, opts: { session?: string; operationKey?: string } = {}) {
  const res = await fetch(`${baseUrl}/graphql`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', authorization: `Bearer ${key}`,
      ...(opts.session ? { 'x-hadron-session': opts.session } : {}),
      ...(opts.operationKey ? { 'x-hadron-operation-key': opts.operationKey } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });
  return (await res.json()) as { data?: Record<string, any>; errors?: Array<{ message: string }> };
}

async function startSession(user: string, operationKey?: string) {
  const out = await gql(
    'mutation($a: ID!, $u: String) { startAgentSession(agentRef: $a, externalUserId: $u) { id memoryId } }',
    { a: agentId, u: user }, { operationKey },
  );
  expect(out.errors).toBeUndefined();
  return out.data!.startAgentSession as { id: string; memoryId: string };
}

/** A distinguishable node in the session memory, encrypted under the supplied key when the memory is. */
async function seedNode(memoryId: string, operationKey?: string) {
  const memory = await db.memory.findUniqueOrThrow({ where: { id: memoryId } });
  const marker = `w3401-${generateId().toLowerCase().slice(-10)}`;
  const fields = { content: marker, abstract: null, data: null };
  await db.node.create({
    data: {
      id: generateId(), memoryId, loc: 'diary', name: 'Diary',
      ...(operationKey ? encryptNodeFieldsWithKey(fields, parseDataKey(operationKey)) : fields),
    } as never,
  });
  return { urn: memory.urn, cls: memory.class, nodeUrn: `hrn:node:${memory.urn}:diary`, marker };
}

const initializeBody = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'w3401', version: '1.0.0' } },
};
async function post(body: unknown, opts: { mcpSession?: string; hadronSession?: string }) {
  const headers: Record<string, string> = {
    accept: 'application/json, text/event-stream', 'content-type': 'application/json', authorization: `Bearer ${key}`,
  };
  if (opts.mcpSession) headers['mcp-session-id'] = opts.mcpSession;
  if (opts.hadronSession) headers['x-hadron-session'] = opts.hadronSession;
  return fetch(`${baseUrl}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) });
}
/** Open a transport bound (at initialize) to `hadronSession`. */
async function open(hadronSession: string): Promise<string> {
  const res = await post(initializeBody, { hadronSession });
  expect(res.status).toBe(200);
  const id = res.headers.get('mcp-session-id')!;
  await res.text();
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { mcpSession: id, hadronSession });
  return id;
}
let rpc = 10;
async function call(mcpSession: string, name: string, args: Record<string, unknown>, hadronSession?: string) {
  const res = await post({ jsonrpc: '2.0', id: rpc++, method: 'tools/call', params: { name, arguments: args } }, { mcpSession, hadronSession });
  expect(res.status).toBe(200);
  const raw = await res.text();
  const data = raw.split('\n').find((l) => l.startsWith('data:'))?.slice(5) ?? raw;
  return (JSON.parse(data).result?.content?.[0]?.text ?? '') as string;
}
const getNode = (t: string, urn: string, header?: string) => call(t, 'hadron_get_node', { urn }, header);

/** hadron_get_node's answer for a memory that does not exist, with its URN swapped for `urn`. */
async function unknownAnswer(t: string, urn: string, header?: string) {
  const ghost = `${orgUrn}:ghost${generateId().toLowerCase().slice(-6)}`;
  return (await getNode(t, `hrn:node:${ghost}:diary`, header)).split(ghost).join(urn);
}

const gqlNode = (nodeUrn: string, session: string) =>
  gql('query($r: ID!) { node(ref: $r) { content } }', { r: nodeUrn }, { session });

describe('#3401 owner-positive over the wire', () => {
  it('personal: the session key reads it on MCP and GraphQL', async () => {
    const s = await startSession('mia');
    const n = await seedNode(s.memoryId);
    expect(n.cls).toBe('personal');
    const t = await open(s.id);
    expect(await getNode(t, n.nodeUrn, s.id)).toContain(n.marker);
    expect(await getNode(t, n.nodeUrn)).toContain(n.marker);
    expect((await gqlNode(n.nodeUrn, s.id)).data?.node?.content).toBe(n.marker);
  });

  it('private (SECRET): the session key reads it on MCP and GraphQL', async () => {
    await db.app.update({ where: { id: appId }, data: { identifyUserMethod: 'SECRET' } });
    const s = await startSession('mia', opKey);
    const n = await seedNode(s.memoryId, opKey);
    expect(n.cls).toBe('private');
    const t = await open(s.id);
    expect(await getNode(t, n.nodeUrn, s.id)).toContain(n.marker);
    expect((await gqlNode(n.nodeUrn, s.id)).data?.node?.content).toBe(n.marker);
  });
});

describe('#3401 D1: a retained transport loses the read the moment its session is no longer live', () => {
  for (const header of ['repeated', 'omitted'] as const) {
    it(`personal, ended by endAgentSession (later requests ${header} the header)`, async () => {
      const s = await startSession('mia');
      const n = await seedNode(s.memoryId);
      const t = await open(s.id);
      const h = header === 'repeated' ? s.id : undefined;
      expect(await getNode(t, n.nodeUrn, h)).toContain(n.marker);
      expect((await gql('mutation($s: ID!) { endAgentSession(sessionId: $s) }', { s: s.id })).errors).toBeUndefined();
      const after = await getNode(t, n.nodeUrn, h);
      expect(after).not.toContain(n.marker);
      expect(after).toBe(await unknownAnswer(t, n.urn, h));
    });
  }

  it('personal, past its hard expiry', async () => {
    const s = await startSession('mia');
    const n = await seedNode(s.memoryId);
    const t = await open(s.id);
    expect(await getNode(t, n.nodeUrn)).toContain(n.marker);
    await db.session.update({ where: { id: s.id }, data: { expiresAt: new Date(Date.now() - 1_000) } });
    const after = await getNode(t, n.nodeUrn);
    expect(after).not.toContain(n.marker);
    expect(after).toBe(await unknownAnswer(t, n.urn));
  });

  it('personal, gone dormant', async () => {
    const s = await startSession('mia');
    const n = await seedNode(s.memoryId);
    const t = await open(s.id);
    // Zero baseline for the control below (#4726 blind delta follow-up): nothing counted before the live read.
    await drainNodeUsage(db);
    expect(await db.usageEvent.count({ where: { sessionId: s.id, countsAsActivity: true } })).toBe(0);
    expect(await getNode(t, n.nodeUrn)).toContain(n.marker);
    const old = new Date(Date.now() - 3 * 86_400_000);
    await db.app.update({ where: { id: appId }, data: { sessionDormancyDays: 1 } });
    // The read above records its usage heartbeat after answering, off the request path. Flush it (#4726 blind P2-2:
    // polling for dormancy raced a late write), then age the session; it is dormant in the ONE binding check.
    await drainNodeUsage(db);
    // Control (#4726 blind delta P2): the live read went through the recorder and the flush caught it, so the
    // "zero counted events" check below can fail.
    expect(await db.usageEvent.count({ where: { sessionId: s.id, countsAsActivity: true } })).toBeGreaterThan(0);
    await db.usageEvent.deleteMany({ where: { sessionId: s.id } });
    await db.session.update({ where: { id: s.id }, data: { startedAt: old, updatedAt: old, expiresAt: null } });
    expect(await validateSessionBinding(db, { appId }, s.id)).toBeNull();
    const after = await getNode(t, n.nodeUrn);
    expect(after).not.toContain(n.marker);
    expect(after).toBe(await unknownAnswer(t, n.urn));
    // #4726 blind P2-1: the retained transport keeps asking. A refused read must not count as a drive, or the
    // next call would find the session live and read again. Repeat, flush every usage write, and the session is
    // still dormant, with no counted event and its heartbeat column untouched.
    for (let i = 0; i < 3; i += 1) expect(await getNode(t, n.nodeUrn)).not.toContain(n.marker);
    await drainNodeUsage(db);
    expect(await db.usageEvent.count({ where: { sessionId: s.id, countsAsActivity: true } })).toBe(0);
    expect((await db.session.findUniqueOrThrow({ where: { id: s.id } })).updatedAt).toEqual(old);
    expect(await validateSessionBinding(db, { appId }, s.id)).toBeNull();
    expect(await getNode(t, n.nodeUrn)).toBe(await unknownAnswer(t, n.urn));
  });

  it('private, ended while ANOTHER live session of the same memory still caches its key', async () => {
    await db.app.update({ where: { id: appId }, data: { identifyUserMethod: 'SECRET' } });
    const first = await startSession('mia', opKey);
    const n = await seedNode(first.memoryId, opKey);
    const second = await startSession('mia', opKey);
    expect(second.memoryId).toBe(first.memoryId);
    const t1 = await open(first.id);
    const t2 = await open(second.id);
    expect(await getNode(t1, n.nodeUrn)).toContain(n.marker);
    expect((await gql('mutation($s: ID!) { endAgentSession(sessionId: $s) }', { s: first.id })).errors).toBeUndefined();
    expect(sessionKeyCache.getByMemoryId(first.memoryId)).toBeTruthy();
    const after = await getNode(t1, n.nodeUrn);
    expect(after).not.toContain(n.marker);
    expect(after).toBe(await unknownAnswer(t1, n.urn));
    // The live session keeps its read.
    expect(await getNode(t2, n.nodeUrn)).toContain(n.marker);
  });
});

describe('#3401 over the wire: another person\'s session never reaches the memory', () => {
  it('Leo\'s session of the same App asks for Mia\'s node: unknown-memory answer on MCP, null on GraphQL', async () => {
    const mia = await startSession('mia');
    const n = await seedNode(mia.memoryId);
    const leo = await startSession('leo');
    const t = await open(leo.id);
    expect(await getNode(t, n.nodeUrn)).toBe(await unknownAnswer(t, n.urn));
    expect((await gqlNode(n.nodeUrn, leo.id)).data?.node ?? null).toBeNull();
  });
});

describe('#3401 D2 through startAgentSession: two Apps, one Agent, the same external user id', () => {
  it('each App gets its own user and session memory, so the narrowed D2 orphans nothing; neither reaches the other', async () => {
    // #4726 blind P2-3: startAgentSession reuses a session memory by (Agent, user), and D2 now refuses a
    // personal row whose App is not the session's. The user is found by (externalAppId = the calling App,
    // externalId), so the same external id in a second App is a second user with a second memory, App-tied.
    const keyX = key;
    const a = await startSession('mia');
    const nA = await seedNode(a.memoryId);
    const org = await db.app.findUniqueOrThrow({ where: { id: appId }, select: { organizationId: true } });
    const appY = (await db.app.create({
      data: { id: generateId(), organizationId: org.organizationId, name: 'Y', urn: `${orgUrn}:y`, identifyUserMethod: 'USER_ID', createUserPermission: 'IMPLICIT' },
    })).id;
    await db.appAgent.create({ data: { appId: appY, agentId } });
    const keyY = `${APP_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
    await db.appKey.create({ data: { id: generateId(), appId: appY, keyHash: hashAppKey(keyY), keyPreview: keyY.slice(-4), label: 'y' } });
    try {
      key = keyY;
      const b = await startSession('mia');
      expect(b.memoryId).not.toBe(a.memoryId);
      const [memA, memB] = await Promise.all([a.memoryId, b.memoryId].map((id) => db.memory.findUniqueOrThrow({ where: { id } })));
      expect([memA.appId, memB.appId]).toEqual([appId, appY]);
      expect(memA.userId).not.toBe(memB.userId);
      const nB = await seedNode(b.memoryId);
      const tB = await open(b.id);
      expect(await getNode(tB, nB.nodeUrn)).toContain(nB.marker);
      expect(await getNode(tB, nA.nodeUrn)).toBe(await unknownAnswer(tB, nA.urn));
      key = keyX;
      const tA = await open(a.id);
      expect(await getNode(tA, nA.nodeUrn)).toContain(nA.marker);
      expect(await getNode(tA, nB.nodeUrn)).toBe(await unknownAnswer(tA, nB.urn));
    } finally {
      key = keyX;
    }
  });
});
