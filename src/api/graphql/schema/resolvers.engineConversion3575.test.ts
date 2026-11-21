/**
 * #3575 (rulings 0225, 0227, 0228): the conversion result for an unauthenticated chat-engine envelope.
 *
 * encryptMemory continues past it (healthy rows and the blocked root's own node fields still convert, in bounded
 * commits) and then reports ENCRYPTION_INCOMPLETE; anonymous promotion refuses WHOLE with nothing committed. The error is
 * content-free and carries the blocked chat-root NODE ids (distinct, ascending, at most 100) beside an exact count.
 *
 * The error shape is asserted through a real ApolloServer (so formatError runs), separately from the direct resolver
 * checks that inject faults.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { generateDataKey, type EncryptionKey } from '../../../lib/crypto.js';
import { isAuthenticatedDataEnvelope } from '../../../lib/nodeCrypto.js';
import { withTestOperationKey } from '../../../test/operationKey.js';
import { formatGraphQLError } from '../formatError.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const server = new ApolloServer<Context>({ typeDefs, resolvers, formatError: formatGraphQLError });
type Answer = { data: unknown; error: { message: string; extensions: Record<string, unknown> } | null };
async function ask(contextValue: Context, query: string, variables: Record<string, unknown> = {}): Promise<Answer> {
  const res = await server.executeOperation({ query, variables }, { contextValue });
  if (res.body.kind !== 'single') throw new Error('unexpected incremental response');
  const { data, errors } = res.body.singleResult;
  const e = errors?.[0];
  const { stacktrace: _drop, ...extensions } = (e?.extensions ?? {}) as Record<string, unknown>;
  return { data: data ? Object.values(data)[0] ?? null : null, error: e ? { message: e.message, extensions } : null };
}
const ENCRYPT = `mutation($m: ID!, $k: String) { encryptMemory(memoryRef: $m, dataKey: $k) { id isEncrypted } }`;

let orgId: string, userId: string, agentId: string, ctx: Context, memoryId: string;
const stored = (id: string) => db.chatRootEngineState.findUniqueOrThrow({ where: { chatRootNodeId: id } });
const keyText = (k: EncryptionKey) => k.raw.toString('base64');
const TAMPERED = { __enc: 'tampered-envelope' };

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'conv3575', urn: `conv3575-${generateId()}` } });
  orgId = org.id;
  userId = (await db.user.create({ data: { id: generateId(), handle: `conv3575-${generateId()}` } })).id;
  agentId = (await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'conv', urn: `conv3575:${generateId()}` } })).id;
  ctx = { db, userId, roles: ['ADMIN'], portalHumanUserId: userId } as Context;
});

/** A private memory (the only encryptable class) holding `healthy` plain and `blocked` unauthenticated chat roots. */
async function privateMemory(counts: { healthy?: number; blocked?: number; tombstoned?: number } = {}) {
  const memory = await db.memory.create({ data: { id: generateId(), organizationId: orgId, urn: `conv3575:${generateId()}`, name: 'conv', class: 'private', userId, createdBy: userId, userMemoryOfAgentId: agentId } });
  memoryId = memory.id;
  const mk = async (tag: string, state: unknown, extra: Record<string, unknown> = {}) => {
    const node = await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: `chats:${tag}`, name: tag, nodeType: 'record', createdBy: userId, content: `SYNTHETIC-CONTENT-${tag}`, data: { scope: 'private', title: tag }, ...extra } });
    await db.chatRootEngineState.create({ data: { chatRootNodeId: node.id, state: state as never } });
    return node;
  };
  const healthy = [], blocked = [], tombstoned = [];
  for (let i = 0; i < (counts.healthy ?? 0); i++) healthy.push(await mk(`h${i}`, { conversationName: 'intake', stageName: 'first' }));
  for (let i = 0; i < (counts.blocked ?? 0); i++) blocked.push(await mk(`b${i}`, TAMPERED));
  for (let i = 0; i < (counts.tombstoned ?? 0); i++) tombstoned.push(await mk(`t${i}`, TAMPERED, { deletedAt: new Date() }));
  return { memory, healthy, blocked, tombstoned };
}

describe('#3575 encryptMemory continues past an unauthenticated engine envelope, then reports (ruling 0225)', () => {
  it('through a real server: the fixed message and exactly the gated extensions, content-free', async () => {
    const { blocked, tombstoned } = await privateMemory({ healthy: 2, blocked: 2, tombstoned: 1 });
    const key = generateDataKey();
    const a = await ask(ctx, ENCRYPT, { m: memoryId, k: keyText(key) });
    expect(a.data).toBeNull();
    expect(a.error?.message).toBe('Encryption conversion is incomplete.');
    const ids = [...blocked, ...tombstoned].map(n => n.id).sort();
    expect(a.error?.extensions).toMatchObject({
      code: 'ENCRYPTION_INCOMPLETE', memoryId, operation: 'ENCRYPT_MEMORY', phase: 'CHAT_ENGINE_STATE', reason: 'UNAUTHENTICATED_ENVELOPE',
      blockedEngineStateCount: 3, blockedEngineStateRootIds: ids, progressCommitted: true, retryable: false,
    });
    // exactly this field set: nothing else rides the error (no names, ciphertext, paths, key material, driver text)
    expect(Object.keys(a.error!.extensions).filter(k => k !== 'requestId').sort()).toEqual([
      'blockedEngineStateCount', 'blockedEngineStateRootIds', 'code', 'memoryId', 'operation', 'phase', 'progressCommitted', 'reason', 'retryable']);
    const wire = JSON.stringify(a.error);
    for (const secret of ['tampered-envelope', 'SYNTHETIC-CONTENT', 'chats:b0', 'chats:h0', 'intake', keyText(key)]) expect(wire).not.toContain(secret);
  });

  it('converts healthy engine rows and the blocked root\'s own node fields; the blocked row is preserved byte for byte', async () => {
    const { healthy, blocked } = await privateMemory({ healthy: 2, blocked: 1 });
    const key = generateDataKey();
    const before = await stored(blocked[0]!.id);
    await expect(resolvers.Mutation.encryptMemory({}, { memoryRef: memoryId, dataKey: keyText(key) }, ctx)).rejects.toMatchObject({ extensions: { code: 'ENCRYPTION_INCOMPLETE' } });
    for (const h of healthy) expect(isAuthenticatedDataEnvelope((await stored(h.id)).state, key)).toBe(true);
    expect(await stored(blocked[0]!.id)).toEqual(before); // never rewrapped, cleared, repaired or reseeded
    const root = await db.node.findUniqueOrThrow({ where: { id: blocked[0]!.id } });
    expect(root.content).not.toContain('SYNTHETIC-CONTENT'); // the blocked root's healthy fields converted anyway
    expect(await db.chatRootEngineState.count()).toBe(3);
  });

  it('never returns Memory success while a blocked row remains; completion waits', async () => {
    await privateMemory({ blocked: 1 });
    const key = generateDataKey();
    const a = await ask(ctx, ENCRYPT, { m: memoryId, k: keyText(key) });
    expect(a.error?.extensions.code).toBe('ENCRYPTION_INCOMPLETE');
    expect(a.data).toBeNull();
  });

  it('a same-key retry is idempotent and repeats the refusal: nothing is double wrapped, progressCommitted is false', async () => {
    const { healthy, blocked } = await privateMemory({ healthy: 1, blocked: 1 });
    const key = generateDataKey();
    await ask(ctx, ENCRYPT, { m: memoryId, k: keyText(key) });
    const afterFirst = { h: await stored(healthy[0]!.id), b: await stored(blocked[0]!.id) };
    const second = await ask(ctx, ENCRYPT, { m: memoryId, k: keyText(key) });
    expect(second.error?.extensions).toMatchObject({ code: 'ENCRYPTION_INCOMPLETE', blockedEngineStateCount: 1, blockedEngineStateRootIds: [blocked[0]!.id], progressCommitted: false, retryable: false });
    expect({ h: await stored(healthy[0]!.id), b: await stored(blocked[0]!.id) }).toEqual(afterFirst);
  });

  it('wrong-key verification keeps its precedence: a different key fails its own way, never as incomplete', async () => {
    const { blocked } = await privateMemory({ blocked: 1 });
    await ask(ctx, ENCRYPT, { m: memoryId, k: keyText(generateDataKey()) });
    const before = await stored(blocked[0]!.id);
    const wrong = await ask(ctx, ENCRYPT, { m: memoryId, k: keyText(generateDataKey()) });
    expect(wrong.error).not.toBeNull();
    expect(wrong.error?.extensions.code).not.toBe('ENCRYPTION_INCOMPLETE');
    expect(wrong.error?.extensions).not.toHaveProperty('blockedEngineStateRootIds');
    expect(await stored(blocked[0]!.id)).toEqual(before);
  });

  it('reports at most 100 root ids, distinct and ascending, with the exact count beside them', async () => {
    const { blocked } = await privateMemory({ blocked: 105 });
    const a = await ask(ctx, ENCRYPT, { m: memoryId, k: keyText(generateDataKey()) });
    const ids = a.error?.extensions.blockedEngineStateRootIds as string[];
    expect(a.error?.extensions.blockedEngineStateCount).toBe(105);
    expect(ids).toHaveLength(100);
    expect(ids).toEqual([...blocked.map(n => n.id)].sort().slice(0, 100));
    expect(new Set(ids).size).toBe(100);
  }, 120_000);

  it('a root moved out of the memory is not scanned and its state is untouched', async () => {
    const { blocked } = await privateMemory({ blocked: 1 });
    const other = await db.memory.create({ data: { id: generateId(), organizationId: orgId, urn: `conv3575:${generateId()}`, name: 'other', class: 'private', userId, createdBy: userId, userMemoryOfAgentId: agentId } });
    const moved = await db.node.create({ data: { id: generateId(), memoryId: other.id, loc: 'chats:moved', name: 'moved', nodeType: 'record', createdBy: userId, data: {} } });
    await db.chatRootEngineState.create({ data: { chatRootNodeId: moved.id, state: TAMPERED } });
    const a = await ask(ctx, ENCRYPT, { m: memoryId, k: keyText(generateDataKey()) });
    expect(a.error?.extensions).toMatchObject({ blockedEngineStateCount: 1, blockedEngineStateRootIds: [blocked[0]!.id] });
    expect((await stored(moved.id)).state).toEqual(TAMPERED);
  });

  it('a caller without authority gets the existing refusal and no ids (authority and concealment come first)', async () => {
    await privateMemory({ blocked: 1 });
    const outsider = await db.user.create({ data: { id: generateId(), handle: `conv3575-out-${generateId()}` } });
    const a = await ask({ db, userId: outsider.id, roles: [] } as Context, ENCRYPT, { m: memoryId, k: keyText(generateDataKey()) });
    expect(a.error).not.toBeNull();
    expect(a.error?.extensions.code).not.toBe('ENCRYPTION_INCOMPLETE');
    expect(JSON.stringify(a.error)).not.toContain('blockedEngineState');
    expect((await db.memory.findUniqueOrThrow({ where: { id: memoryId } })).isEncrypted).toBe(false);
  });

  it('direct fault injection is a different thing: a database failure in the helper is thrown, never classified as blocked', async () => {
    const { encryptChatEngineStateWithKey } = await import('../../../lib/chatRootEngineState.js');
    const failing = { chatRootEngineState: { findUnique: async () => { throw new Error('injected engine read failure'); } } };
    await expect(encryptChatEngineStateWithKey(failing as never, generateId(), generateDataKey())).rejects.toThrow('injected engine read failure');
    const failingWrite = { chatRootEngineState: { findUnique: async () => ({ state: { conversationName: 'x' } }), update: async () => { throw new Error('injected engine write failure'); } } };
    await expect(encryptChatEngineStateWithKey(failingWrite as never, generateId(), generateDataKey())).rejects.toThrow('injected engine write failure');
  });
});

describe('#3575 anonymous promotion refuses whole on an unauthenticated engine envelope (ruling 0227)', () => {
  async function anonymousMemory(blockedCount: number) {
    const app = await db.app.create({ data: { id: generateId(), name: 'promo3575', urn: `promo3575:${generateId()}`, organizationId: orgId, identifyUserMethod: 'SECRET', createUserPermission: 'IMPLICIT' } });
    await db.appAgent.create({ data: { appId: app.id, agentId } });
    const memory = await db.memory.create({ data: { id: generateId(), organizationId: orgId, appId: app.id, userMemoryOfAgentId: agentId, userId: null, createdBy: null, class: 'app', anonymousExpiresAt: new Date(Date.now() + 86_400_000), urn: `conv3575:anon-${generateId()}`, name: 'anon' } });
    const healthy = await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'chats:healthy', name: 'healthy', nodeType: 'record', content: 'SYNTHETIC-PROMO-CONTENT', data: {} } });
    await db.chatRootEngineState.create({ data: { chatRootNodeId: healthy.id, state: { conversationName: 'intake', stageName: 'first' } } });
    const blocked = [];
    for (let i = 0; i < blockedCount; i++) {
      const n = await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: `chats:bad${i}`, name: 'bad', nodeType: 'record', content: 'SYNTHETIC-BAD-CONTENT', data: {} } });
      await db.chatRootEngineState.create({ data: { chatRootNodeId: n.id, state: TAMPERED } });
      blocked.push(n);
    }
    return { app, memory, healthy, blocked };
  }
  const promote = (appId: string, memId: string, key: EncryptionKey) =>
    withTestOperationKey(keyText(key), appId, () => ask({ db, appId, roles: [] } as Context,
      `mutation($m: ID!) { linkMemoryToUser(memoryRef: $m, externalUserId: "promo-3575") { id isEncrypted } }`, { m: memId }));

  it('refuses with ENCRYPTION_INCOMPLETE and progressCommitted:false, exact count and ids, and commits nothing', async () => {
    const { app, memory, healthy, blocked } = await anonymousMemory(2);
    const before = {
      memory: await db.memory.findUniqueOrThrow({ where: { id: memory.id } }),
      nodes: await db.node.findMany({ where: { memoryId: memory.id }, orderBy: { id: 'asc' } }),
      rows: await db.chatRootEngineState.findMany({ orderBy: { chatRootNodeId: 'asc' } }),
      aliases: await db.urnAlias.count(),
    };
    const a = await promote(app.id, memory.id, generateDataKey());
    expect(a.error?.message).toBe('Encryption conversion is incomplete.');
    expect(a.error?.extensions).toMatchObject({
      code: 'ENCRYPTION_INCOMPLETE', memoryId: memory.id, operation: 'PROMOTE_ANONYMOUS_MEMORY', phase: 'CHAT_ENGINE_STATE',
      reason: 'UNAUTHENTICATED_ENVELOPE', blockedEngineStateCount: 2, blockedEngineStateRootIds: blocked.map(n => n.id).sort(),
      progressCommitted: false, retryable: false,
    });
    // nothing committed: the row, identity, alias, expiry, every node and every engine row are as they were
    expect(await db.memory.findUniqueOrThrow({ where: { id: memory.id } })).toEqual(before.memory);
    expect(await db.node.findMany({ where: { memoryId: memory.id }, orderBy: { id: 'asc' } })).toEqual(before.nodes);
    expect(await db.chatRootEngineState.findMany({ orderBy: { chatRootNodeId: 'asc' } })).toEqual(before.rows);
    expect(await db.urnAlias.count()).toBe(before.aliases);
    expect((await stored(healthy.id)).state).toEqual({ conversationName: 'intake', stageName: 'first' }); // not converted: rolled back
  });

  it('is content-free on the wire', async () => {
    const { app, memory } = await anonymousMemory(1);
    const key = generateDataKey();
    const a = await promote(app.id, memory.id, key);
    const wire = JSON.stringify(a.error);
    for (const secret of ['tampered-envelope', 'SYNTHETIC-PROMO-CONTENT', 'SYNTHETIC-BAD-CONTENT', 'chats:bad0', 'intake', keyText(key)]) expect(wire).not.toContain(secret);
  });

  it('a promotion with no blocked row still converts every engine row (the healthy path is unchanged)', async () => {
    const { app, memory, healthy } = await anonymousMemory(0);
    const key = generateDataKey();
    const a = await promote(app.id, memory.id, key);
    expect(a.error).toBeNull();
    expect(isAuthenticatedDataEnvelope((await stored(healthy.id)).state, key)).toBe(true);
    expect((await db.memory.findUniqueOrThrow({ where: { id: memory.id } })).isEncrypted).toBe(true);
  });
});

describe('#3575 the helper classifies; it does not throw for an unauthenticated envelope', () => {
  it('encryptChatEngineStateWithKey: unchanged / converted / blocked', async () => {
    const { encryptChatEngineStateWithKey } = await import('../../../lib/chatRootEngineState.js');
    const { healthy, blocked } = await privateMemory({ healthy: 1, blocked: 1 });
    const key = generateDataKey();
    expect(await db.$transaction(tx => encryptChatEngineStateWithKey(tx, healthy[0]!.id, key))).toBe('converted');
    expect(await db.$transaction(tx => encryptChatEngineStateWithKey(tx, healthy[0]!.id, key))).toBe('unchanged');
    expect(await db.$transaction(tx => encryptChatEngineStateWithKey(tx, blocked[0]!.id, key))).toBe('blocked');
    expect((await stored(blocked[0]!.id)).state).toEqual(TAMPERED);
    const none = await db.node.create({ data: { id: generateId(), memoryId, loc: 'chats:none', name: 'none', nodeType: 'record', data: {} } });
    expect(await db.$transaction(tx => encryptChatEngineStateWithKey(tx, none.id, key))).toBe('unchanged'); // absent stays absent
    expect(await db.chatRootEngineState.count({ where: { chatRootNodeId: none.id } })).toBe(0);
  });
});

describe('#3575 the error builder owns the id policy (ruling 0228)', () => {
  it('sorts ascending, de-duplicates and caps at 100; the count is the exact distinct total, or null when the scan did not finish', async () => {
    const { engineStateIncomplete } = await import('../../../lib/chatRootEngineState.js');
    const pool = Array.from({ length: 130 }, (_, i) => `node-${String(i).padStart(4, '0')}`);
    const shuffled = [...pool].reverse().concat(pool.slice(0, 20)); // reversed, with 20 duplicates
    const done = engineStateIncomplete({ memoryId: 'm', operation: 'ENCRYPT_MEMORY', blockedRootIds: shuffled, scanFinished: true, progressCommitted: false });
    expect(done.extensions.blockedEngineStateRootIds).toEqual(pool.slice(0, 100));
    expect(done.extensions.blockedEngineStateCount).toBe(130);
    const unfinished = engineStateIncomplete({ memoryId: 'm', operation: 'ENCRYPT_MEMORY', blockedRootIds: shuffled, scanFinished: false, progressCommitted: true });
    expect(unfinished.extensions.blockedEngineStateCount).toBeNull();
    expect(unfinished.extensions.progressCommitted).toBe(true);
    expect(done.message).toBe('Encryption conversion is incomplete.');
  });
});

