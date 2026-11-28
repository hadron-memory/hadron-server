/**
 * #744 — structured storage (memory schema, `properties`, `where`/`sortProperty`, the
 * `hadron_validate` audit) on an ENCRYPTED memory, through the real doors.
 *
 * `Memory.schema` and `Node.properties` are plaintext at rest; only `abstract`/`content`/`data`
 * are ciphertext (cor:dmo:020:05). So configuring a schema, querying and auditing need no key,
 * while a node WRITE is session-gated (it round-trips the encrypted fields) and refuses
 * `SESSION_EXPIRED` without a cached key (cor:sec:040, cor:sec:040:01).
 *
 * Each acceptance item has an authorized control (a live session / key) and a keyless control.
 * Test-only: no product code is changed here.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { generateId } from '../../../lib/id.js';
import { generateDataKey } from '../../../lib/crypto.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';
import { withTestOperationKey } from '../../../test/operationKey.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import type { AuthContext } from '../../../middleware/auth.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const schema = {
  objectTypes: {
    competitor: {
      fields: {
        name: { type: 'text', required: true },
        rank: { type: 'number' },
      },
    },
  },
};

let org: { id: string };
let agent: { id: string };
let app: { id: string };
let sessionId: string;
let memoryId: string;
let userId: string;

function appCtx(overrides: Partial<Context> = {}): Context {
  return { db, appId: app.id, roles: [], organizationId: org.id, ...overrides };
}
/** The session owner holding the cached key. */
const keyed = (): Context => appCtx({ userId, sessionId });
/** The same owner with no active session: the key is not in play. */
const keyless = (): Context => appCtx({ userId });

const M = resolvers.Mutation as any;
const updateMemory = (c: Context, s: unknown = schema) => M.updateMemory(null, { ref: memoryId, schema: s }, c);
const createNode = (c: Context, input: Record<string, unknown>) =>
  M.createNode({}, { input: { memoryRef: memoryId, ...input } }, c);
const updateNode = (c: Context, input: Record<string, unknown>) =>
  M.updateNode({}, { input: { memoryRef: memoryId, ...input } }, c);
const updateNodeProperties = (c: Context, nodeRef: string, properties: unknown) =>
  M.updateNodeProperties({}, { nodeRef, properties }, c);
const findNodes = (c: Context, args: Record<string, unknown>) =>
  (resolvers.Query as any).findNodes(null, { filter: { memoryRefs: [memoryId] }, ...args }, c);
const locsOf = (res: any): string[] => res.hits.map((h: any) => h.node.loc);
const auth = (): AuthContext => ({ userId, roles: [], clientId: `user:${userId}` });

/** End the session: the key is evicted, and `keyless()` is what is left. */
async function evictKey(): Promise<void> {
  await resolvers.Mutation.endAgentSession({}, { sessionId }, appCtx());
  expect(sessionKeyCache.getByMemoryId(memoryId)).toBeNull();
}

beforeEach(async () => {
  await cleanDb(db);
  sessionKeyCache.clear();
  org = await db.organization.create({ data: { id: generateId(), name: 'es-org', urn: 'es-org' } });
  agent = await db.agent.create({
    data: { id: generateId(), organizationId: org.id, urn: 'es-org:juno', name: 'juno', type: 'CHATBOT', surfaces: ['api'] },
  });
  app = await db.app.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      name: 'SECRET App',
      urn: 'es-org:secret-app',
      createUserPermission: 'IMPLICIT',
      identifyUserMethod: 'SECRET',
    },
  });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });

  const key = generateDataKey().raw.toString('base64');
  const session = await withTestOperationKey(key, app.id, () =>
    resolvers.Mutation.startAgentSession({}, { agentRef: agent.id, externalUserId: 'es-1' }, appCtx()),
  );
  sessionId = session.id;
  memoryId = session.memoryId!;
  const row = await db.session.findUniqueOrThrow({ where: { id: sessionId }, select: { userId: true } });
  userId = row.userId!;

  const mem = await db.memory.findUniqueOrThrow({ where: { id: memoryId } });
  expect(mem.isEncrypted).toBe(true);
  expect(sessionKeyCache.getByMemoryId(memoryId)).not.toBeNull();
});

describe('#744 item 1 — updateMemory(schema:) needs no key', () => {
  it('keyless: the schema write succeeds and round-trips (plaintext column)', async () => {
    await evictKey();
    const res = await updateMemory(keyless());
    expect(res.schema).toEqual(schema);
    const row = await db.memory.findUniqueOrThrow({ where: { id: memoryId } });
    expect(row.schema).toEqual(schema);
  });

  it('keyed control: the same write succeeds with a live session', async () => {
    const res = await updateMemory(keyed());
    expect(res.schema).toEqual(schema);
  });

  it('keyless: a malformed schema is still refused BAD_USER_INPUT (validation is not skipped)', async () => {
    await evictKey();
    await expect(updateMemory(keyless(), { objectTypes: { c: { fields: { x: { type: 'nonsense' } } } } })).rejects.toMatchObject({
      extensions: { code: 'BAD_USER_INPUT' },
    });
  });
});

describe('#744 items 2-3 — in-session writes are enforced and `properties` is plaintext at rest', () => {
  beforeEach(async () => {
    await updateMemory(keyed());
  });

  it('a conforming write succeeds; properties read back plaintext while content/data are ciphertext', async () => {
    const node = await createNode(keyed(), {
      loc: 'c.ok',
      name: 'OK',
      objectType: 'competitor',
      properties: { name: 'Letta', rank: 2 },
      content: 'secret body',
      data: { secret: 'value' },
    });
    const raw = await db.node.findUniqueOrThrow({ where: { id: node.id } });
    expect(raw.properties).toEqual({ name: 'Letta', rank: 2 });
    expect(raw.objectType).toBe('competitor');
    expect(raw.content?.startsWith('enc:v1:')).toBe(true);
    // `data` is stored as an encrypted envelope, never the structure that was written.
    expect(Object.keys(raw.data as object)).toEqual(['__enc']);
    expect(JSON.stringify(raw.data)).not.toContain('secret');
  });

  it('a missing required field is BAD_USER_INPUT and nothing is written', async () => {
    await expect(createNode(keyed(), { loc: 'c.bad', name: 'Bad', objectType: 'competitor', properties: { rank: 1 } })).rejects.toMatchObject({
      extensions: { code: 'BAD_USER_INPUT' },
    });
    expect(await db.node.count({ where: { memoryId, loc: 'c.bad' } })).toBe(0);
  });

  it('a wrong type is BAD_USER_INPUT on create, updateNode and updateNodeProperties', async () => {
    await expect(createNode(keyed(), { loc: 'c.t', name: 'T', objectType: 'competitor', properties: { name: 'x', rank: 'high' } })).rejects.toMatchObject({
      extensions: { code: 'BAD_USER_INPUT' },
    });
    const node = await createNode(keyed(), { loc: 'c.u', name: 'U', objectType: 'competitor', properties: { name: 'x' } });
    await expect(updateNode(keyed(), { loc: 'c.u', properties: { name: 'x', rank: 'high' } })).rejects.toMatchObject({
      extensions: { code: 'BAD_USER_INPUT' },
    });
    await expect(updateNodeProperties(keyed(), node.id, { rank: 'high' })).rejects.toMatchObject({
      extensions: { code: 'BAD_USER_INPUT' },
    });
    const raw = await db.node.findUniqueOrThrow({ where: { id: node.id } });
    expect(raw.properties).toEqual({ name: 'x' });
  });

  it('an undeclared collection is BAD_USER_INPUT', async () => {
    await expect(createNode(keyed(), { loc: 'c.g', name: 'G', objectType: 'gadget', properties: {} })).rejects.toMatchObject({
      extensions: { code: 'BAD_USER_INPUT' },
    });
  });
});

describe('#744 item 4 — a node write with no key is SESSION_EXPIRED and changes no row', () => {
  it('createNode, updateNode and updateNodeProperties each refuse; the row is untouched', async () => {
    await updateMemory(keyed());
    const node = await createNode(keyed(), { loc: 'c.k', name: 'K', objectType: 'competitor', properties: { name: 'before' } });
    const before = await db.node.findUniqueOrThrow({ where: { id: node.id } });
    const countBefore = await db.node.count({ where: { memoryId } });
    await evictKey();

    await expect(createNode(keyless(), { loc: 'c.new', name: 'New', objectType: 'competitor', properties: { name: 'n' } })).rejects.toMatchObject({ extensions: { code: 'SESSION_EXPIRED' } });
    await expect(updateNode(keyless(), { loc: 'c.k', properties: { name: 'after' } })).rejects.toMatchObject({ extensions: { code: 'SESSION_EXPIRED' } });
    await expect(updateNodeProperties(keyless(), node.id, { name: 'after' })).rejects.toMatchObject({ extensions: { code: 'SESSION_EXPIRED' } });

    const after = await db.node.findUniqueOrThrow({ where: { id: node.id } });
    expect(after.properties).toEqual({ name: 'before' });
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(after.content).toEqual(before.content);
    expect(after.data).toEqual(before.data);
    expect(await db.node.count({ where: { memoryId } })).toBe(countBefore);
  });

  it('a LIVE session whose cached key is gone is also SESSION_EXPIRED (the missing key, not the missing session, is the cause)', async () => {
    await updateMemory(keyed());
    const node = await createNode(keyed(), { loc: 'c.live', name: 'Live', objectType: 'competitor', properties: { name: 'before' } });
    sessionKeyCache.clear();
    const session = await db.session.findUniqueOrThrow({ where: { id: sessionId }, select: { endedAt: true } });
    expect(session.endedAt).toBeNull();
    await expect(createNode(keyed(), { loc: 'c.live2', name: 'L2', objectType: 'competitor', properties: { name: 'n' } })).rejects.toMatchObject({ extensions: { code: 'SESSION_EXPIRED' } });
    await expect(updateNode(keyed(), { loc: 'c.live', properties: { name: 'after' } })).rejects.toMatchObject({ extensions: { code: 'SESSION_EXPIRED' } });
    await expect(updateNodeProperties(keyed(), node.id, { name: 'after' })).rejects.toMatchObject({ extensions: { code: 'SESSION_EXPIRED' } });
    const raw = await db.node.findUniqueOrThrow({ where: { id: node.id } });
    expect(raw.properties).toEqual({ name: 'before' });
  });

  it('keyed control: the same three writes succeed with a live session', async () => {
    await updateMemory(keyed());
    const node = await createNode(keyed(), { loc: 'c.k2', name: 'K2', objectType: 'competitor', properties: { name: 'a' } });
    await updateNode(keyed(), { loc: 'c.k2', properties: { name: 'b' } });
    const res = await updateNodeProperties(keyed(), node.id, { rank: 3 });
    expect(res.properties).toEqual({ name: 'b', rank: 3 });
  });
});

describe('#744 items 5 and 7 — findNodes where/sortProperty without a key', () => {
  beforeEach(async () => {
    await updateMemory(keyed());
    await createNode(keyed(), { loc: 'c.a', name: 'A', objectType: 'competitor', properties: { name: 'alpha', rank: 9 }, data: { tools: ['web_search'] } });
    await createNode(keyed(), { loc: 'c.b', name: 'B', objectType: 'competitor', properties: { name: 'beta', rank: 10 }, data: { tools: ['other'] } });
    await createNode(keyed(), { loc: 'c.c', name: 'C', objectType: 'competitor', properties: { name: 'alpha', rank: 2 } });
  });

  const where = { path: ['name'], eq: 'alpha' };
  const sort = { path: ['rank'], as: 'number', direction: 'desc' };

  it('keyless: where over properties matches', async () => {
    await evictKey();
    expect((await locsOf(await findNodes(keyless(), { filter: { memoryRefs: [memoryId], where } }))).sort()).toEqual(['c.a', 'c.c']);
  });

  it('keyless: sortProperty over properties orders numerically', async () => {
    await evictKey();
    expect(locsOf(await findNodes(keyless(), { sortProperty: sort }))).toEqual(['c.b', 'c.a', 'c.c']);
  });

  it('keyed control: the same where and sort give the same answers', async () => {
    expect((await locsOf(await findNodes(keyed(), { filter: { memoryRefs: [memoryId], where } }))).sort()).toEqual(['c.a', 'c.c']);
    expect(locsOf(await findNodes(keyed(), { sortProperty: sort }))).toEqual(['c.b', 'c.a', 'c.c']);
  });

  it('where over field data matches nothing on the encrypted memory (data is ciphertext at rest), keyed or not', async () => {
    const dataWhere = { field: 'data', path: ['tools'], contains: 'web_search' };
    const filter = { memoryRefs: [memoryId], where: dataWhere };
    // Keyed first, while the key is live: the predicate runs in SQL on the stored ciphertext,
    // so a key does not change the answer.
    expect(locsOf(await findNodes(keyed(), { filter }))).toEqual([]);
    await evictKey();
    expect(locsOf(await findNodes(keyless(), { filter }))).toEqual([]);
  });

  it('positive control: the same data predicate matches on a PLAINTEXT memory', async () => {
    const admin = await db.user.create({ data: { githubId: 7441, githubUsername: 'es-admin', roles: ['ADMIN'] } });
    await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
    const adminCtx = { db, roles: ['ADMIN'], userId: admin.id } as Context;
    const plain = await M.createMemory({}, { orgRef: org.id, name: 'es-plain' }, adminCtx);
    await db.node.create({
      data: { id: generateId(), memoryId: plain.id, loc: 'p.a', name: 'PA', data: { tools: ['web_search'] } } as never,
    });
    const res = await (resolvers.Query as any).findNodes(
      null,
      { filter: { memoryRefs: [plain.id], where: { field: 'data', path: ['tools'], contains: 'web_search' } } },
      adminCtx,
    );
    expect(locsOf(res)).toEqual(['p.a']);
  });
});

describe('#744 item 6 — hadron_validate without a key', () => {
  it('reports a directly inserted non-conforming row and not the conforming one', async () => {
    await updateMemory(keyed());
    await createNode(keyed(), { loc: 'c.fine', name: 'Fine', objectType: 'competitor', properties: { name: 'ok' } });
    // Simulates a legacy row written outside the write seam, before the schema existed.
    await db.node.create({
      data: { id: generateId(), memoryId, loc: 'c.broken', name: 'Broken', objectType: 'competitor', properties: {} } as never,
    });
    const urn = (await db.memory.findUniqueOrThrow({ where: { id: memoryId } })).urn;
    await evictKey();

    const text = await createTestableMcpServer(auth()).callToolText('hadron_validate', { memoryUrn: urn });
    expect(text).toContain('[schema]');
    expect(text).toContain('c.broken');
    expect(text).not.toContain('c.fine');
  });
});
