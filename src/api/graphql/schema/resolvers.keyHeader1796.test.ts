/** #1796 removal slice: secrets travel beside the operation, never in its arguments. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { parse, Kind } from 'graphql';
import { createServer } from '../../../server.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { hashAppKey, mintUserApiKey } from '../../../middleware/auth.js';
import { parseDataKey } from '../../../lib/crypto.js';
import { verifyDataKey } from '../../../lib/memoryUnlock.js';
import { decryptNodeFieldsWithKey } from '../../../lib/nodeCrypto.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';
import { typeDefs } from './typeDefs.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn() }));
const header = 'x-hadron-operation-key';
const key = Buffer.alloc(32, 71).toString('base64');
const wrongKey = Buffer.alloc(32, 72).toString('base64');
let server: Server, url: string, appId: string, agentId: string, token: string, siblingToken: string;

beforeAll(async () => {
  server = createHttpServer(await createServer());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/graphql';
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
afterEach(() => sessionKeyCache.clear());
beforeEach(async () => {
  await cleanDb(db);
  sessionKeyCache.clear();
  const org = await db.organization.create({ data: { name: 'Header fixture', urn: 'header1796.test' } });
  const agent = await db.agent.create({ data: { name: 'Header Agent', urn: 'header1796.test:agent', organizationId: org.id } });
  agentId = agent.id;
  const app = await db.app.create({ data: { name: 'Header App', urn: 'header1796.test:app', organizationId: org.id, identifyUserMethod: 'SECRET', createUserPermission: 'IMPLICIT' } });
  appId = app.id;
  await db.appAgent.create({ data: { appId, agentId } });
  const sibling = await db.app.create({ data: { name: 'Sibling', urn: 'header1796.test:sibling', organizationId: org.id, identifyUserMethod: 'SECRET', createUserPermission: 'IMPLICIT' } });
  const mint = async (id: string) => {
    const raw = 'hdr_app_' + randomBytes(32).toString('hex');
    await db.appKey.create({ data: { appId: id, keyHash: hashAppKey(raw), keyPreview: raw.slice(-4) } });
    return raw;
  };
  token = await mint(appId);
  siblingToken = await mint(sibling.id);
});
async function request(query: string, variables: Record<string, unknown>, supplied?: string, auth: string | null = token) {
  const response = await fetch(url, { method: 'POST', headers: {
    'content-type': 'application/json', ...(auth ? { authorization: 'Bearer ' + auth } : {}),
    ...(supplied !== undefined ? { [header]: supplied } : {}),
  }, body: JSON.stringify({ query, variables }) });
  return { status: response.status, body: await response.json() as {
    data?: Record<string, any>; errors?: Array<{ message: string; path?: Array<string | number>; extensions?: { code?: string } }>
  } };
}
const startQuery = 'mutation($agent: ID!, $user: String) { startAgentSession(agentId: $agent, externalUserId: $user) { id memoryId } }';
const linkQuery = 'mutation($memory: ID!, $user: String!) { linkMemoryToUser(memoryId: $memory, externalUserId: $user) { id isEncrypted class } }';

describe('#1796 schema boundary', () => {
  it('removes provisioning key arguments and allow-lists encryptMemory by name', () => {
    const found: string[] = [];
    const encryptionArgs: string[] = [];
    for (const definition of parse(typeDefs).definitions) {
      if (definition.kind !== Kind.OBJECT_TYPE_DEFINITION && definition.kind !== Kind.OBJECT_TYPE_EXTENSION) continue;
      if (!['Query', 'Mutation'].includes(definition.name.value)) continue;
      for (const field of definition.fields ?? []) {
        if (['startAgentSession', 'linkMemoryToUser'].includes(field.name.value)) {
          expect(field.arguments?.map(arg => arg.name.value)).not.toContain('dataKey');
        }
        for (const arg of field.arguments ?? []) {
          if (field.name.value === 'encryptMemory') encryptionArgs.push(arg.name.value);
          if (['dataKey', 'passphrase'].includes(arg.name.value) || arg.directives?.some(d => /keyMaterial/i.test(d.name.value))) {
            found.push(definition.name.value + '.' + field.name.value + '.' + arg.name.value);
          }
        }
      }
    }
    expect(encryptionArgs.sort()).toEqual(['dataKey', 'memoryId', 'passphrase']);
    expect(found.sort()).toEqual(['Mutation.encryptMemory.dataKey', 'Mutation.encryptMemory.passphrase']);
  });


});

describe('#1796 real HTTP header operations', () => {
  it('creates an encrypted SECRET session and holds only the committed, verified key', async () => {
    const result = await request(startQuery, { agent: agentId, user: 'registered' }, key);
    expect(result.body.errors).toBeUndefined();
    const session = result.body.data?.startAgentSession;
    const memory = await db.memory.findUniqueOrThrow({ where: { id: session.memoryId } });
    expect(memory).toMatchObject({ class: 'private', isEncrypted: true });
    expect(verifyDataKey(memory.keyVerifier!, parseDataKey(key))).toBe(true);
    expect(sessionKeyCache.getByMemoryId(memory.id)?.raw).toEqual(parseDataKey(key).raw);
  });

  it('does not borrow a warm session key when a later request carries no key, and rejects a wrong supplied key', async () => {
    const first = await request(startQuery, { agent: agentId, user: 'registered' }, key);
    expect(first.body.errors).toBeUndefined();
    const before = await db.session.count();
    for (const supplied of [undefined, wrongKey]) {
      const result = await request(startQuery, { agent: agentId, user: 'registered' }, supplied);
      expect(result.body.errors).toBeDefined();
      expect(await db.session.count()).toBe(before);
    }
    const correct = await request(startQuery, { agent: agentId, user: 'registered' }, key);
    expect(correct.body.errors).toBeUndefined();
  });

  it('encrypts a live anonymous promotion and completes historical fields through the supplied header', async () => {
    await db.app.update({ where: { id: appId }, data: { identifyUserMethod: 'USER_ID' } });
    const anonymous = await request(startQuery, { agent: agentId });
    expect(anonymous.body.errors).toBeUndefined();
    const memoryId = anonymous.body.data?.startAgentSession.memoryId;
    const node = await db.node.create({ data: { memoryId, loc: 'note', name: 'Note', content: 'Private note', abstract: 'Private abstract', data: { text: 'Private data' } } });
    await db.nodeRevision.create({ data: { nodeId: node.id, memoryId, loc: 'note', name: 'Note', content: 'Earlier private note' } });
    const result = await request(linkQuery, { memory: memoryId, user: 'promoted' }, key);
    expect(result.body.errors).toBeUndefined();
    expect(result.body.data?.linkMemoryToUser).toMatchObject({ isEncrypted: true, class: 'private' });
    const row = await db.node.findUniqueOrThrow({ where: { id: node.id } });
    expect(decryptNodeFieldsWithKey(row, parseDataKey(key))).toMatchObject({ content: 'Private note', abstract: 'Private abstract', data: { text: 'Private data' } });
    const revision = await db.nodeRevision.findFirstOrThrow({ where: { nodeId: node.id } });
    expect(decryptNodeFieldsWithKey(revision, parseDataKey(key)).content).toBe('Earlier private note');
    expect(sessionKeyCache.getByMemoryId(memoryId)).toBeNull();
  });

  it('a supplied key grants no installation authority', async () => {
    const result = await request(startQuery, { agent: agentId, user: 'foreign' }, key, siblingToken);
    expect(result.body.errors).toBeDefined();
    expect(await db.session.count()).toBe(0);
    expect(await db.user.count({ where: { externalId: 'foreign' } })).toBe(0);
  });

  it('retains the plaintext USER_ID path without a header', async () => {
    await db.app.update({ where: { id: appId }, data: { identifyUserMethod: 'USER_ID' } });
    const result = await request(startQuery, { agent: agentId, user: 'plain' });
    expect(result.body.errors).toBeUndefined();
    expect(await db.memory.findUniqueOrThrow({ where: { id: result.body.data?.startAgentSession.memoryId } })).toMatchObject({ class: 'personal', isEncrypted: false });
  });

  it('requires authentication before parsing key material', async () => {
    const result = await request(startQuery, { agent: agentId }, 'malformed', null);
    expect(result.body.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
    expect(JSON.stringify(result.body)).not.toContain('malformed');
    expect(await db.session.count()).toBe(0);
  });

  it('rejects malformed key material generically without provisioning', async () => {
    const result = await request(startQuery, { agent: agentId, user: 'invalid' }, 'malformed');
    expect(result.body.errors?.[0]?.extensions?.code).toBe('BAD_UNLOCK_INPUT');
    expect(JSON.stringify(result.body)).not.toContain('malformed');
    expect(await db.user.count({ where: { externalId: 'invalid' } })).toBe(0);
  });
  it('keeps concurrent requests with different supplied keys isolated', async () => {
    const results = await Promise.all([
      request(startQuery, { agent: agentId, user: 'parallel-a' }, key),
      request(startQuery, { agent: agentId, user: 'parallel-b' }, wrongKey),
    ]);
    for (const [index, result] of results.entries()) {
      expect(result.body.errors).toBeUndefined();
      const memory = await db.memory.findUniqueOrThrow({ where: { id: result.body.data?.startAgentSession.memoryId } });
      expect(verifyDataKey(memory.keyVerifier!, parseDataKey(index === 0 ? key : wrongKey))).toBe(true);
      expect(verifyDataKey(memory.keyVerifier!, parseDataKey(index === 0 ? wrongKey : key))).toBe(false);
    }
  });

  it('a supplied promotion key cannot claim another App anonymous memory', async () => {
    await db.app.update({ where: { id: appId }, data: { identifyUserMethod: 'USER_ID' } });
    const anonymous = await request(startQuery, { agent: agentId });
    expect(anonymous.body.errors).toBeUndefined();
    const memoryId = anonymous.body.data?.startAgentSession.memoryId;
    const before = await db.memory.findUniqueOrThrow({ where: { id: memoryId } });
    const result = await request(linkQuery, { memory: memoryId, user: 'foreign-promotion' }, key, siblingToken);
    expect(result.body.errors?.[0]?.extensions?.code).toBe('MEMORY_NOT_FOUND');
    expect(await db.memory.findUniqueOrThrow({ where: { id: memoryId } })).toEqual(before);
    expect(await db.user.count({ where: { externalId: 'foreign-promotion' } })).toBe(0);
  });

  it('rejects a key in USER_ID mode before provisioning', async () => {
    await db.app.update({ where: { id: appId }, data: { identifyUserMethod: 'USER_ID' } });
    const result = await request(startQuery, { agent: agentId, user: 'wrong-mode' }, key);
    expect(result.body.errors?.[0]?.extensions?.code).toBe('BAD_UNLOCK_INPUT');
    expect(await db.session.count()).toBe(0);
    expect(await db.user.count({ where: { externalId: 'wrong-mode' } })).toBe(0);
  });

  it.each(['session', 'promotion'])('old %s documents refuse before any writes, including null or absent keys', async operation => {
    await db.app.update({ where: { id: appId }, data: { identifyUserMethod: 'USER_ID' } });
    const anonymous = await request(startQuery, { agent: agentId });
    const memoryId = anonymous.body.data?.startAgentSession.memoryId;
    const snapshot = async () => ({ users: await db.user.findMany(), memories: await db.memory.findMany(), sessions: await db.session.findMany(), nodes: await db.node.findMany() });
    const before = await snapshot();
    for (const legacy of [undefined, null, '', key]) {
      const query = operation === 'session'
        ? 'mutation($id: ID!, $key: String) { startAgentSession(agentId: $id, externalUserId: "removed", dataKey: $key) { id } }'
        : 'mutation($id: ID!, $key: String) { linkMemoryToUser(memoryId: $id, externalUserId: "removed", dataKey: $key) { id } }';
      const result = await request(query, { id: operation === 'session' ? agentId : memoryId, key: legacy });
      expect(result.body.errors?.[0]?.extensions?.code).toBe('GRAPHQL_VALIDATION_FAILED');
      expect(result.body.errors?.[0]?.message).toContain('Unknown argument "dataKey"');
      expect(JSON.stringify(result.body)).not.toContain(key);
      expect(await snapshot()).toEqual(before);
    }
  });

  it.each(['session', 'promotion', 'mixed'])('a second header-key consumption refuses before its writes in a two-field %s document', async mode => {
    let firstMemory: string | undefined;
    let secondMemory: string | undefined;
    let secondBefore: unknown;
    let nodeId: string | undefined;
    if (mode !== 'session') {
      await db.app.update({ where: { id: appId }, data: { identifyUserMethod: 'USER_ID' } });
      const first = await request(startQuery, { agent: agentId });
      const second = await request(startQuery, { agent: agentId });
      expect(first.body.errors).toBeUndefined();
      expect(second.body.errors).toBeUndefined();
      firstMemory = first.body.data?.startAgentSession.memoryId;
      secondMemory = second.body.data?.startAgentSession.memoryId;
      secondBefore = await db.memory.findUniqueOrThrow({ where: { id: secondMemory } });
      nodeId = (await db.node.create({ data: { memoryId: secondMemory!, loc: 'untouched', name: 'Untouched', content: 'Still plaintext' } })).id;
      if (mode === 'mixed') await db.app.update({ where: { id: appId }, data: { identifyUserMethod: 'SECRET' } });
    }
    const sessionsBefore = await db.session.count();
    const firstField = mode === 'promotion'
      ? 'first: linkMemoryToUser(memoryId: $firstMemory, externalUserId: "single-first") { id }'
      : 'first: startAgentSession(agentId: $agent, externalUserId: "single-first") { id }';
    const secondField = mode === 'session'
      ? 'second: startAgentSession(agentId: $agent, externalUserId: "single-second") { id }'
      : 'second: linkMemoryToUser(memoryId: $secondMemory, externalUserId: "single-second") { id }';
    const declarations = mode === 'session' ? '$agent: ID!'
      : mode === 'promotion' ? '$firstMemory: ID!, $secondMemory: ID!'
      : '$agent: ID!, $secondMemory: ID!';
    const result = await request('mutation(' + declarations + ') { ' + firstField + ' ' + secondField + ' }',
      { agent: agentId, firstMemory, secondMemory, key }, key);
    expect(result.body.errors?.[0]).toMatchObject({ path: ['second'], extensions: { code: 'BAD_UNLOCK_INPUT' } });
    // GraphQL commits fields serially: the authorized first operation stands;
    // the second creates no user/session and leaves its target untouched.
    expect(await db.user.count({ where: { externalId: 'single-first' } })).toBe(1);
    expect(await db.user.count({ where: { externalId: 'single-second' } })).toBe(0);
    expect(await db.session.count()).toBe(sessionsBefore + (mode === 'promotion' ? 0 : 1));
    if (secondMemory) {
      expect(await db.memory.findUniqueOrThrow({ where: { id: secondMemory } })).toEqual(secondBefore);
      expect(await db.node.findUniqueOrThrow({ where: { id: nodeId } })).toMatchObject({ content: 'Still plaintext' });
      expect(sessionKeyCache.getByMemoryId(secondMemory)).toBeNull();
    }
    if (mode === 'promotion') expect(await db.memory.findUniqueOrThrow({ where: { id: firstMemory } })).toMatchObject({ isEncrypted: true });
  });

  it('a non-consuming field does not claim the staged header key', async () => {
    const result = await request('mutation($agent: ID!) { unused: __typename next: startAgentSession(agentId: $agent, externalUserId: "after-unused") { id } }', { agent: agentId }, key);
    expect(result.body.errors).toBeUndefined();
    expect(result.body.data?.next.id).toEqual(expect.any(String));
  });

  it('a signed-in non-App user sending the header is refused even on a query', async () => {
    const user = await db.user.create({ data: { handle: 'header-only-user', roles: ['READER'] } });
    const { rawKey } = await mintUserApiKey(db, { userId: user.id, label: null, createdBy: user.id, issuedVia: 'test' });
    const result = await request('query { __typename }', {}, key, rawKey);
    expect(result.body.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    expect(JSON.stringify(result.body)).not.toContain(key);
  });

});

/** #2108: cache setup/inspection is in-process; every operation below uses mounted HTTP. */
async function anonymousWithHistory() {
  await db.app.update({ where: { id: appId }, data: { identifyUserMethod: 'USER_ID' } });
  const started = await request(startQuery, { agent: agentId });
  expect(started.body.errors).toBeUndefined();
  const memoryId: string = started.body.data?.startAgentSession.memoryId;
  expect(memoryId).toEqual(expect.any(String)); // actual operation, not validation/no-op
  const node = await db.node.create({ data: { memoryId, loc: 'isolation', name: 'Isolation', content: 'Live sentinel', abstract: 'Live abstract', data: { sentinel: 'live' } } });
  const revision = await db.nodeRevision.create({ data: { memoryId, nodeId: node.id, loc: node.loc, name: node.name, content: 'Historical sentinel', abstract: 'Historical abstract', data: { sentinel: 'historical' } } });
  return { memoryId, node, revision };
}
async function provisioningSnapshot() {
  const rows = {
    users: await db.user.findMany({ orderBy: { id: 'asc' } }),
    memories: await db.memory.findMany({ orderBy: { id: 'asc' } }),
    sessions: await db.session.findMany({ orderBy: { id: 'asc' } }),
    nodes: await db.node.findMany({ orderBy: { id: 'asc' } }),
    revisions: await db.nodeRevision.findMany({ orderBy: { id: 'asc' } }),
  };
  // Full-row equality without dumping verifier/ciphertext material on a mutant failure.
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}
async function expectPromotionKey(fixture: Awaited<ReturnType<typeof anonymousWithHistory>>) {
  const memory = await db.memory.findUniqueOrThrow({ where: { id: fixture.memoryId } });
  expect(memory).toMatchObject({ isEncrypted: true, class: 'private', anonymousExpiresAt: null });
  expect(memory.userId).toEqual(expect.any(String));
  expect(verifyDataKey(memory.keyVerifier!, parseDataKey(key))).toBe(true);
  expect(verifyDataKey(memory.keyVerifier!, parseDataKey(wrongKey))).toBe(false);
  const live = await db.node.findUniqueOrThrow({ where: { id: fixture.node.id } });
  const historical = await db.nodeRevision.findUniqueOrThrow({ where: { id: fixture.revision.id } });
  expect(live.content).not.toBe('Live sentinel');
  expect(historical.content).not.toBe('Historical sentinel');
  expect(decryptNodeFieldsWithKey(live, parseDataKey(key))).toMatchObject({ content: 'Live sentinel', abstract: 'Live abstract', data: { sentinel: 'live' } });
  expect(decryptNodeFieldsWithKey(historical, parseDataKey(key))).toMatchObject({ content: 'Historical sentinel', abstract: 'Historical abstract', data: { sentinel: 'historical' } });
}
async function mountedMcp(supplied: string) {
  const endpoint = url.replace(/\/graphql$/, '/mcp');
  let session: string | null = null;
  const headers = () => ({ authorization: 'Bearer ' + token, 'content-type': 'application/json', accept: 'application/json, text/event-stream', [header]: supplied, ...(session ? { 'mcp-session-id': session } : {}) });
  const post = async (body: unknown) => fetch(endpoint, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  const decode = async (response: Response) => {
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text.includes(supplied)).toBe(false); // never print key material on failure
    return JSON.parse(text.startsWith('event:') || text.startsWith('data:')
      ? text.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('') : text);
  };
  try {
    const initialized = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'isolation2108', version: '1' } } });
    session = initialized.headers.get('mcp-session-id');
    const hello = await decode(initialized);
    expect(session).toEqual(expect.any(String));
    expect(hello).toMatchObject({ id: 1, result: { protocolVersion: '2025-03-26' } });
    const notification = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(notification.status).toBe(202);
    await notification.text();
    const listed = await decode(await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }));
    expect(listed.error).toBeUndefined();
    const names: string[] = listed.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain('hadron_find_nodes'); // mounted protocol really executed
    // Negative tool-name inventory only: no MCP consumer is executed or invented here.
    expect(names).not.toContain('hadron_start_agent_session');
    expect(names).not.toContain('hadron_link_memory_to_user');
  } finally {
    if (session) {
      const closed = await fetch(endpoint, { method: 'DELETE', headers: headers() });
      expect(closed.status).toBe(200);
      await closed.text();
    }
  }
}

describe('#2108 request-operation key versus ambient cache and mounted MCP', () => {
  it.each([false, true])('uses supplied A with unrelated cache and same-memory B=%s without changing holders', async sameMemory => {
    const fixture = await anonymousWithHistory();
    const unrelated = await anonymousWithHistory();
    sessionKeyCache.set('unrelated-holder', unrelated.memoryId, parseDataKey(wrongKey));
    // Deliberately synthetic: production setters verify encrypted holdings. Retention of this
    // impossible warm plaintext holder is observed behavior, not a new custody contract.
    if (sameMemory) sessionKeyCache.set('stale-holder', fixture.memoryId, parseDataKey(wrongKey));
    const result = await request(linkQuery, { memory: fixture.memoryId, user: 'cache-promotion' }, key);
    expect(result.body.errors).toBeUndefined();
    expect(result.body.data?.linkMemoryToUser.id).toBe(fixture.memoryId);
    await expectPromotionKey(fixture);
    expect(sessionKeyCache.refCount(fixture.memoryId)).toBe(sameMemory ? 1 : 0);
    expect(sessionKeyCache.getByMemoryId(fixture.memoryId)?.raw.equals(parseDataKey(wrongKey).raw) ?? false).toBe(sameMemory);
    expect(sessionKeyCache.refCount(unrelated.memoryId)).toBe(1);
    expect(sessionKeyCache.getByMemoryId(unrelated.memoryId)?.raw.equals(parseDataKey(wrongKey).raw)).toBe(true);
    sessionKeyCache.evict('stale-holder');
    expect(sessionKeyCache.getByMemoryId(fixture.memoryId) === null).toBe(true);
  });

  it('no-header promotion stays plaintext despite a same-memory warm key', async () => {
    const fixture = await anonymousWithHistory();
    const unrelated = await anonymousWithHistory();
    const before = await db.memory.findUniqueOrThrow({ where: { id: fixture.memoryId } });
    sessionKeyCache.set('stale-holder', fixture.memoryId, parseDataKey(wrongKey));
    sessionKeyCache.set('unrelated-holder', unrelated.memoryId, parseDataKey(wrongKey));
    const result = await request(linkQuery, { memory: fixture.memoryId, user: 'plain-cache-promotion' });
    expect(result.body.errors).toBeUndefined();
    const after = await db.memory.findUniqueOrThrow({ where: { id: fixture.memoryId } });
    expect(after.isEncrypted).toBe(false);
    expect(after.keyVerifier === null).toBe(true);
    expect(after.class).toBe('app');
    expect(after.anonymousExpiresAt).toBeNull();
    expect(after.urn).not.toBe(before.urn);
    expect(await db.user.count({ where: { externalAppId: appId, externalId: 'plain-cache-promotion' } })).toBe(1);
    expect(await db.node.findUniqueOrThrow({ where: { id: fixture.node.id } })).toEqual(fixture.node);
    expect(await db.nodeRevision.findUniqueOrThrow({ where: { id: fixture.revision.id } })).toEqual(fixture.revision);
    for (const id of [fixture.memoryId, unrelated.memoryId]) {
      expect(sessionKeyCache.refCount(id)).toBe(1);
      expect(sessionKeyCache.getByMemoryId(id)?.raw.equals(parseDataKey(wrongKey).raw)).toBe(true);
    }
  });

  it('mounted MCP header neither provisions nor supplies a later no-header GraphQL operation', async () => {
    const fixture = await anonymousWithHistory();
    const before = await provisioningSnapshot();
    const cached = vi.spyOn(sessionKeyCache, 'set');
    try {
      await mountedMcp(wrongKey);
      expect(await provisioningSnapshot()).toEqual(before);
      expect(cached).not.toHaveBeenCalled();
      expect(sessionKeyCache.getByMemoryId(fixture.memoryId) === null).toBe(true);
    } finally { cached.mockRestore(); }
    await db.app.update({ where: { id: appId }, data: { identifyUserMethod: 'SECRET' } });
    const secretBefore = await provisioningSnapshot();
    const secret = await request(startQuery, { agent: agentId, user: 'after-mcp' });
    expect(secret.body.errors?.[0]?.extensions?.code).toBe('BAD_UNLOCK_INPUT');
    expect(await provisioningSnapshot()).toEqual(secretBefore);
    await db.app.update({ where: { id: appId }, data: { identifyUserMethod: 'USER_ID' } });
    const linked = await request(linkQuery, { memory: fixture.memoryId, user: 'after-mcp-plain' });
    expect(linked.body.errors).toBeUndefined();
    expect(linked.body.data?.linkMemoryToUser).toMatchObject({ id: fixture.memoryId, isEncrypted: false });
    expect((await db.memory.findUniqueOrThrow({ where: { id: fixture.memoryId } })).keyVerifier === null).toBe(true);
    expect(await db.node.findUniqueOrThrow({ where: { id: fixture.node.id } })).toEqual(fixture.node);
  });

  it('concurrent mounted MCP B and GraphQL A keep the promotion verifier and history on A', async () => {
    const fixture = await anonymousWithHistory();
    const [_, promoted] = await Promise.all([
      mountedMcp(wrongKey),
      request(linkQuery, { memory: fixture.memoryId, user: 'concurrent-mcp' }, key),
    ]);
    expect(promoted.body.errors).toBeUndefined();
    expect(promoted.body.data?.linkMemoryToUser.id).toBe(fixture.memoryId);
    await expectPromotionKey(fixture);
    expect(sessionKeyCache.getByMemoryId(fixture.memoryId) === null).toBe(true);
    const fresh = await anonymousWithHistory();
    const plain = await request(linkQuery, { memory: fresh.memoryId, user: 'after-concurrent' });
    expect(plain.body.errors).toBeUndefined();
    expect(plain.body.data?.linkMemoryToUser).toMatchObject({ id: fresh.memoryId, isEncrypted: false });
  });

  it.each(['', 'malformed'])('invalid present operation header refuses atomically, then a fresh canonical request succeeds (%s)', async supplied => {
    const fixture = await anonymousWithHistory();
    const before = await provisioningSnapshot();
    const refused = await request(linkQuery, { memory: fixture.memoryId, user: 'invalid-isolation' }, supplied);
    expect(refused.body.errors?.[0]?.extensions?.code).toBe('BAD_UNLOCK_INPUT');
    expect(await provisioningSnapshot()).toEqual(before);
    const accepted = await request(linkQuery, { memory: fixture.memoryId, user: 'valid-isolation' }, key);
    expect(accepted.body.errors).toBeUndefined();
    await expectPromotionKey(fixture);
  });
});
