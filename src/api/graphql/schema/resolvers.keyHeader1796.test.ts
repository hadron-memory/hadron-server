/** #1796 first slice: secrets travel beside the operation, never in its arguments. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
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
  it('confines the temporary secret arguments and deprecates both migrating operations', () => {
    const found: string[] = [];
    const deprecated: string[] = [];
    for (const definition of parse(typeDefs).definitions) {
      if (definition.kind !== Kind.OBJECT_TYPE_DEFINITION && definition.kind !== Kind.OBJECT_TYPE_EXTENSION) continue;
      if (!['Query', 'Mutation'].includes(definition.name.value)) continue;
      for (const field of definition.fields ?? []) for (const arg of field.arguments ?? []) {
        if (['dataKey', 'passphrase'].includes(arg.name.value) || arg.directives?.some(d => /keyMaterial/i.test(d.name.value))) {
          const name = definition.name.value + '.' + field.name.value + '.' + arg.name.value;
          found.push(name);
          if (arg.directives?.some(d => d.name.value === 'deprecated' && d.arguments?.some(a => a.name.value === 'reason' && a.value.kind === Kind.STRING && a.value.value.includes(header)))) deprecated.push(name);
        }
      }
    }
    expect(found.sort()).toEqual(['Mutation.encryptMemory.dataKey', 'Mutation.encryptMemory.passphrase', 'Mutation.linkMemoryToUser.dataKey', 'Mutation.startAgentSession.dataKey']);
    expect(deprecated.sort()).toEqual(['Mutation.linkMemoryToUser.dataKey', 'Mutation.startAgentSession.dataKey']);
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

  it('retains legacy session key supply during the named migration window', async () => {
    const query = 'mutation($id: ID!, $key: String) { startAgentSession(agentId: $id, externalUserId: "legacy-session", dataKey: $key) { id memoryId } }';
    const result = await request(query, { id: agentId, key });
    expect(result.body.errors).toBeUndefined();
    const memory = await db.memory.findUniqueOrThrow({ where: { id: result.body.data?.startAgentSession.memoryId } });
    expect(verifyDataKey(memory.keyVerifier!, parseDataKey(key))).toBe(true);
  });

  it('accepts matching supplies on session creation', async () => {
    const query = 'mutation($id: ID!, $key: String) { startAgentSession(agentId: $id, externalUserId: "matching", dataKey: $key) { id memoryId } }';
    const result = await request(query, { id: agentId, key }, key);
    expect(result.body.errors).toBeUndefined();
    const memory = await db.memory.findUniqueOrThrow({ where: { id: result.body.data?.startAgentSession.memoryId } });
    expect(verifyDataKey(memory.keyVerifier!, parseDataKey(key))).toBe(true);
  });

  it.each(['session', 'promotion'])('refuses differing supplies before %s writes', async operation => {
    let memoryId: string | undefined;
    if (operation === 'promotion') {
      await db.app.update({ where: { id: appId }, data: { identifyUserMethod: 'USER_ID' } });
      const anonymous = await request(startQuery, { agent: agentId });
      expect(anonymous.body.errors).toBeUndefined();
      memoryId = anonymous.body.data?.startAgentSession.memoryId;
    }
    const snapshot = async () => ({
      users: await db.user.findMany({ orderBy: { id: 'asc' } }),
      memories: await db.memory.findMany({ orderBy: { id: 'asc' } }),
      sessions: await db.session.findMany({ orderBy: { id: 'asc' } }),
    });
    const before = await snapshot();
    const query = operation === 'session'
      ? 'mutation($id: ID!, $key: String) { startAgentSession(agentId: $id, externalUserId: "mismatch", dataKey: $key) { id } }'
      : 'mutation($id: ID!, $key: String) { linkMemoryToUser(memoryId: $id, externalUserId: "mismatch", dataKey: $key) { id } }';
    const result = await request(query, { id: memoryId ?? agentId, key: wrongKey }, key);
    expect(result.body.errors?.[0]?.extensions?.code).toBe('BAD_UNLOCK_INPUT');
    expect(JSON.stringify(result.body)).not.toContain(key);
    expect(JSON.stringify(result.body)).not.toContain(wrongKey);
    expect(await snapshot()).toEqual(before);
    expect(sessionKeyCache.getByMemoryId(memoryId ?? '')).toBeNull();
  });

  it.each(['plaintext', 'legacy-key', 'matching'])('keeps promotion callers working in transition: %s', async mode => {
    await db.app.update({ where: { id: appId }, data: { identifyUserMethod: 'USER_ID' } });
    const anonymous = await request(startQuery, { agent: agentId });
    expect(anonymous.body.errors).toBeUndefined();
    const memoryId = anonymous.body.data?.startAgentSession.memoryId;
    const query = 'mutation($id: ID!, $key: String) { linkMemoryToUser(memoryId: $id, externalUserId: "legacy-promotion", dataKey: $key) { id isEncrypted class } }';
    const result = await request(query, { id: memoryId, key: mode === 'plaintext' ? null : key }, mode === 'matching' ? key : undefined);
    expect(result.body.errors).toBeUndefined();
    expect(result.body.data?.linkMemoryToUser.isEncrypted).toBe(mode !== 'plaintext');
    if (mode !== 'plaintext') {
      const memory = await db.memory.findUniqueOrThrow({ where: { id: memoryId } });
      expect(verifyDataKey(memory.keyVerifier!, parseDataKey(key))).toBe(true);
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
      ? 'second: startAgentSession(agentId: $agent, externalUserId: "single-second", dataKey: $key) { id }'
      : 'second: linkMemoryToUser(memoryId: $secondMemory, externalUserId: "single-second", dataKey: $key) { id }';
    const declarations = mode === 'session' ? '$agent: ID!, $key: String'
      : mode === 'promotion' ? '$firstMemory: ID!, $secondMemory: ID!, $key: String'
      : '$agent: ID!, $secondMemory: ID!, $key: String';
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

  it('legacy-only fields still carry independent keys without a request header', async () => {
    const query = 'mutation($agent: ID!, $a: String!, $b: String!) { first: startAgentSession(agentId: $agent, externalUserId: "legacy-first", dataKey: $a) { memoryId } second: startAgentSession(agentId: $agent, externalUserId: "legacy-second", dataKey: $b) { memoryId } }';
    const result = await request(query, { agent: agentId, a: key, b: wrongKey });
    expect(result.body.errors).toBeUndefined();
    for (const [field, supplied] of [['first', key], ['second', wrongKey]] as const) {
      const memory = await db.memory.findUniqueOrThrow({ where: { id: result.body.data?.[field].memoryId } });
      expect(verifyDataKey(memory.keyVerifier!, parseDataKey(supplied))).toBe(true);
    }
  });

  it('a non-consuming field does not claim the staged header key', async () => {
    const result = await request('mutation($agent: ID!) { unused: __typename next: startAgentSession(agentId: $agent, externalUserId: "after-unused") { id } }', { agent: agentId }, key);
    expect(result.body.errors).toBeUndefined();
    expect(result.body.data?.next.id).toEqual(expect.any(String));
  });

  it('empty legacy dataKey means absent alone and refuses beside a header', async () => {
    const sessionQuery = 'mutation($id: ID!) { startAgentSession(agentId: $id, externalUserId: "empty-session", dataKey: "") { id } }';
    const refused = await request(sessionQuery, { id: agentId }, key);
    expect(refused.body.errors?.[0]?.extensions?.code).toBe('BAD_UNLOCK_INPUT');
    expect(await db.user.count({ where: { externalId: 'empty-session' } })).toBe(0);
    await db.app.update({ where: { id: appId }, data: { identifyUserMethod: 'USER_ID' } });
    const anonymous = await request(startQuery, { agent: agentId });
    const memoryId = anonymous.body.data?.startAgentSession.memoryId;
    const before = await db.memory.findUniqueOrThrow({ where: { id: memoryId } });
    const query = 'mutation($id: ID!) { linkMemoryToUser(memoryId: $id, externalUserId: "empty-promotion", dataKey: "") { isEncrypted } }';
    const refusedPromotion = await request(query, { id: memoryId }, key);
    expect(refusedPromotion.body.errors?.[0]?.extensions?.code).toBe('BAD_UNLOCK_INPUT');
    expect(await db.memory.findUniqueOrThrow({ where: { id: memoryId } })).toEqual(before);
    expect(await db.user.count({ where: { externalId: 'empty-promotion' } })).toBe(0);
    const plaintext = await request(query, { id: memoryId });
    expect(plaintext.body.errors).toBeUndefined();
    expect(plaintext.body.data?.linkMemoryToUser.isEncrypted).toBe(false);
  });

  it('a signed-in non-App user sending the header is refused even on a query', async () => {
    const user = await db.user.create({ data: { handle: 'header-only-user', roles: ['READER'] } });
    const { rawKey } = await mintUserApiKey(db, { userId: user.id, label: null, createdBy: user.id, issuedVia: 'test' });
    const result = await request('query { __typename }', {}, key, rawKey);
    expect(result.body.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    expect(JSON.stringify(result.body)).not.toContain(key);
  });

});
