/** #4036 S3: completion is explicit, engine-only, and routing edits compare the locked origin. */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '../../../generated/prisma/index.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, chatNodeByLocOrThrow } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { generateId } from '../../../lib/id.js';
import { serveEveryAgent } from '../../../test/servedBootPrompt.js';
import { deriveEdgeLoc } from '../../../lib/edgeLoc.js';
import { generateDataKey } from '../../../lib/crypto.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';
import { encryptChatEngineStateWithKey } from '../../../lib/chatRootEngineState.js';
import { updateChatRootData } from '../../../lib/chatRoot.js';
import { getMemoryEncryptionInfo } from '../../../lib/nodeCrypto.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));
const other = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
afterAll(() => other.$disconnect());
afterEach(() => sessionKeyCache.clear());
let userId: string, agentId: string, systemId: string, ids: Record<string, string>;
const ctx = (client = db): Context => ({ db: client, roles: ['READER'], userId });
const start = () => resolvers.Mutation.startChat({}, { agentId, conversationName: 'main' }, ctx());
const respond = (chatId: string, fields: Record<string, unknown> = {}, client = db) => resolvers.Mutation.processChatResponse({}, { chatId, toolResponse: { message: 'reply', onTrack: true, ...fields } }, ctx(client));
async function state(chatId: string) {
  const root = await chatNodeByLocOrThrow(db, chatId);
  const row = await db.chatRootEngineState.findUniqueOrThrow({ where: { chatRootNodeId: root.id } });
  return { root, engine: row.state as Record<string, any> };
}
async function rule(timing = 'on_complete', condition?: any) {
  await db.edge.create({ data: { memoryId: systemId, loc: deriveEdgeLoc('conversations:main:one', 'route', 'conversations:target'), name: 'route', sourceId: ids['conversations:main:one'], targetId: ids['conversations:target'], data: { timing, behavior: 'transition' }, ...(condition ? { condition } : {}) } });
}
beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'Completion4036', urn: 'completion4036.example' } });
  const user = await db.user.create({ data: { githubId: 40361, githubUsername: 'completion4036', roles: ['ADMIN'] } }); userId = user.id;
  await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'ADMIN' } });
  const agent = await resolvers.Mutation.createAgent({}, { orgId: org.id, name: 'Completion fixture', visibility: 'ORGANIZATION' }, { ...ctx(), roles: ['ADMIN'] });
  agentId = agent.id; systemId = agent.systemMemoryId!; ids = {};
  for (const [loc, data] of [
    ['config', {}], ['conversations', {}],
    ['conversations:main', { stageOrder: ['one', 'two'] }], ['conversations:main:one', {}], ['conversations:main:two', {}],
    ['conversations:target', { stageOrder: ['arrive'] }], ['conversations:target:arrive', {}],
    ['conversations:rerouted', { stageOrder: ['fresh'] }], ['conversations:rerouted:fresh', {}],
  ] as const) {
    const node = await db.node.upsert({ where: { loc_memoryId: { loc, memoryId: systemId } }, update: { data }, create: { memoryId: systemId, loc, name: loc.split(':').pop()!, nodeType: 'system', data } }); ids[loc] = node.id;
  }
  await serveEveryAgent(db);
});

describe('#4036 completion by explicit goal_reached', () => {
  it.each([undefined, false, 'true', 1])('does not fire on_complete with non-true flag %s and no next stage', async flag => {
    await rule(); const chat = await start();
    const result = await respond(chat.chatId, { goal_reached: flag });
    expect(result.conversationHandoff).toBeNull();
    expect((await state(chat.chatId)).engine.conversationName).toBe('main');
  });
  it('regression: always fires without a flag or next_stage', async () => {
    await rule('always'); const chat = await start();
    expect((await respond(chat.chatId)).conversationHandoff).toBe('target');
  });
  it('records completion once with its first time, emits COMPLETED every time, and stays put without a rule', async () => {
    const chat = await start();
    const first = await respond(chat.chatId, { goal_reached: true });
    expect(first).toMatchObject({ conversationCompleted: 'main', chatEnded: false, detourReturned: false, routingSkipped: false });
    const before = (await state(chat.chatId)).engine.completedConversations;
    expect(before).toEqual([{ conversation: 'main', completedAt: expect.any(String) }]);
    await respond(chat.chatId, { goal_reached: true });
    const { root, engine } = await state(chat.chatId);
    expect(engine.completedConversations).toEqual(before);
    expect(engine.routeHistory.filter((r: any) => r.action === 'COMPLETED')).toHaveLength(2);
    expect(engine.routeHistory.at(-1)).toMatchObject({ conversationUrn: 'conversations:main', nodeUrn: 'conversations:main:one', trigger: { type: 'GOAL_REACHED' } });
    expect(root.data).not.toHaveProperty('completedConversations');
    const rows = await resolvers.Query.myChats({}, { agentRef: agentId }, ctx());
    expect(rows.find(r => r.loc === chat.chatId)).toMatchObject({ completedConversations: ['main'], conversationName: 'main' });
  });
  it('flag wins over next_stage and evaluates completion rules', async () => {
    await rule(); const chat = await start();
    expect(await respond(chat.chatId, { goal_reached: true, next_stage: 'two' })).toMatchObject({ conversationCompleted: 'main', conversationHandoff: 'target', newStageName: 'arrive' });
    expect((await state(chat.chatId)).engine.stageName).toBe('arrive');
  });
  it.each([false, true])('reports failed-condition partial turn, extraction=%s, with no routing writes', async extraction => {
    await rule('on_complete', { unknown_operator: [] }); const chat = await start();
    const error = await respond(chat.chatId, { goal_reached: true, ...(extraction ? { data: { fact: 'saved' } } : {}) }).catch((e: unknown) => e);
    expect(error.extensions).toMatchObject({ code: 'EDGE_CONDITION_FAILED', partialTurn: {
      persisted: ['ASSISTANT_MESSAGE', 'MESSAGE_COUNTER', ...(extraction ? ['EXTRACTION'] : [])],
      refused: [{ component: 'STAGE_PROGRESSION', code: 'EDGE_CONDITION_FAILED' }], notRun: [],
    } });
    const { root, engine } = await state(chat.chatId);
    expect(engine.conversationName).toBe('main'); expect(engine.completedConversations ?? []).toEqual([]);
    expect(engine.routeHistory.some((r: any) => r.action === 'COMPLETED')).toBe(false);
    expect(await db.chatRootCounter.findUniqueOrThrow({ where: { chatRootNodeId: root.id } })).toMatchObject({ messageCount: 1 });
    if (extraction) expect((await db.node.findFirstOrThrow({ where: { memoryId: root.memoryId, loc: 'data' } })).data).toMatchObject({ fact: 'saved' });
  });
  it('does not report EXTRACTION as persisted when an equal extraction wrote nothing', async () => {
    const chat = await start(); await respond(chat.chatId, { data: { fact: 'saved' } });
    const { root } = await state(chat.chatId);
    const prior = await db.node.findFirstOrThrow({ where: { memoryId: root.memoryId, loc: 'data' } });
    await rule('on_complete', { unknown_operator: [] });
    const error = await respond(chat.chatId, { goal_reached: true, data: { fact: 'saved' } }).catch((e: unknown) => e);
    expect(error.extensions.partialTurn.persisted).toEqual(['ASSISTANT_MESSAGE', 'MESSAGE_COUNTER']);
    expect((await db.node.findUniqueOrThrow({ where: { id: prior.id } })).updatedAt).toEqual(prior.updatedAt);
  });
  it('does not expose completed names on encrypted chat rows', async () => {
    const chat = await start(); await respond(chat.chatId, { goal_reached: true });
    const { root } = await state(chat.chatId);
    const key = generateDataKey();
    await db.$transaction(tx => encryptChatEngineStateWithKey(tx, root.id, key));
    sessionKeyCache.set(generateId(), root.memoryId, key);
    await db.memory.update({ where: { id: root.memoryId }, data: { isEncrypted: true } });
    const rows = await resolvers.Query.myChats({}, { agentRef: agentId }, ctx());
    expect(rows.find(r => r.loc === chat.chatId)).toMatchObject({ completedConversations: [] });
  });
  it('two connections: a committed reroute after origin capture wins over all routing edits; bookkeeping still applies', async () => {
    await rule(); const chat = await start(); const { root } = await state(chat.chatId);
    let release!: () => void, observed!: () => void;
    const held = new Promise<void>(r => { release = r; }); const entered = new Promise<void>(r => { observed = r; });
    let intercepted = 0;
    const client = db.$extends({ query: { edge: { async findMany({ args, query }) {
      const rows = await query(args);
      if (args.where?.sourceId === ids['conversations:main:one']) { intercepted++; observed(); await held; }
      return rows;
    } } } }) as unknown as typeof db;
    const pending = respond(chat.chatId, { goal_reached: true, onTrack: false, offTrackReason: 'late' }, client);
    try {
      await Promise.race([entered, new Promise((_, reject) => setTimeout(() => reject(new Error('origin observation timeout')), 5000))]);
      expect(intercepted).toBe(1);
      await updateChatRootData(other, { id: root.id, loc: root.loc, memoryId: root.memoryId }, await getMemoryEncryptionInfo(other, root.memoryId), fresh => ({ ...fresh, conversationName: 'rerouted', stageName: 'fresh' }));
      expect((await state(chat.chatId)).engine.conversationName).toBe('rerouted');
    } finally { release(); }
    expect(await pending).toMatchObject({ routingSkipped: true, conversationCompleted: null, conversationHandoff: null, stageTransitioned: false });
    const after = await state(chat.chatId);
    expect(after.engine).toMatchObject({ conversationName: 'rerouted', stageName: 'fresh', lastOffTrackReason: 'late' });
    expect(after.engine.completedConversations ?? []).toEqual([]);
    expect((await db.chatRootCounter.findUniqueOrThrow({ where: { chatRootNodeId: root.id } })).lastMessageAt).toBeTruthy();
  });
});
