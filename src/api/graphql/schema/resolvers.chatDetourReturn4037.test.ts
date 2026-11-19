/** #4037 S4: stage targets, detour push and return, and the completion fallback, through processChatResponse on a real DB. */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '../../../generated/prisma/index.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, chatNodeByLocOrThrow } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { serveEveryAgent } from '../../../test/servedBootPrompt.js';
import { deriveEdgeLoc } from '../../../lib/edgeLoc.js';
import * as chatRoot from '../../../lib/chatRoot.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));
const other = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
afterAll(() => other.$disconnect());
let userId: string, agentId: string, systemId: string, ids: Record<string, string>;
const ctx = (client = db): Context => ({ db: client, roles: ['READER'], userId });
const start = (conversationName = 'recent') => resolvers.Mutation.startChat({}, { agentId, conversationName }, ctx());
const respond = (chatId: string, fields: Record<string, unknown> = {}, client = db) => resolvers.Mutation.processChatResponse({}, { chatId, toolResponse: { message: 'reply', onTrack: true, ...fields } }, ctx(client));
async function state(chatId: string) {
  const root = await chatNodeByLocOrThrow(db, chatId);
  return (await db.chatRootEngineState.findUniqueOrThrow({ where: { chatRootNodeId: root.id } })).state as Record<string, any>;
}
const trail = (e: Record<string, any>) => e.routeHistory.map((r: any) => `${r.action} ${r.conversationUrn.replace('conversations:', '')}${r.trigger && r.action !== 'COMPLETED' ? ` (${r.trigger.type})` : ''}`);
async function edge(from: string, to: string, data: Record<string, unknown>, priority = 0) {
  await db.edge.create({ data: { memoryId: systemId, loc: deriveEdgeLoc(from, 'route', to), name: 'route', sourceId: ids[from], targetId: ids[to], priority, data: data as object }, });
}
beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'Detour4037', urn: 'detour4037.example' } });
  const user = await db.user.create({ data: { githubId: 40371, githubUsername: 'detour4037', roles: ['ADMIN'] } }); userId = user.id;
  await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'ADMIN' } });
  const agent = await resolvers.Mutation.createAgent({}, { orgRef: org.id, name: 'Detour fixture', visibility: 'ORGANIZATION' }, { ...ctx(), roles: ['ADMIN'] });
  agentId = agent.id; systemId = agent.systemMemoryId!; ids = {};
  for (const [loc, data] of [
    ['config', {}], ['conversations', {}],
    ['conversations:recent', { stageOrder: ['s1', 's2'] }], ['conversations:recent:s1', {}], ['conversations:recent:s2', {}],
    ['conversations:anger', { stageOrder: ['hot'] }], ['conversations:anger:hot', {}],
    ['conversations:deep', { stageOrder: ['d1'] }], ['conversations:deep:d1', {}],
    ['conversations:home', { stageOrder: ['welcome'], isFallback: true }], ['conversations:home:welcome', {}],
  ] as const) {
    const node = await db.node.upsert({ where: { loc_memoryId: { loc, memoryId: systemId } }, update: { data }, create: { memoryId: systemId, loc, name: loc.split(':').pop()!, nodeType: 'system', data } }); ids[loc] = node.id;
  }
  await serveEveryAgent(db);
});

describe('#4037 detour and return', () => {
  it('pin 2: detour from s2, anger completes, chat is back at recent:s2 with the spec route', async () => {
    await edge('conversations:recent:s2', 'conversations:anger', { timing: 'always', behavior: 'detour' });
    const chat = await start(); await respond(chat.chatId, { next_stage: 's2' });
    expect(await respond(chat.chatId)).toMatchObject({ conversationHandoff: 'anger', detourReturned: false });
    const done = await respond(chat.chatId, { goal_reached: true });
    expect(done).toMatchObject({ detourReturned: true, stageTransitioned: true, conversationCompleted: 'anger', conversationHandoff: 'recent', newStageName: 's2' });
    const e = await state(chat.chatId);
    expect(e).toMatchObject({ conversationName: 'recent', stageName: 's2' });
    expect(e.goalStack.at(-1)).toMatchObject({ status: 'COMPLETED', detourTo: 'conversations:anger', conversationUrn: 'conversations:recent', nodeUrn: 'conversations:recent:s2' });
    expect(trail(e).slice(-5)).toEqual(['EXIT recent', 'ENTER anger (DETOUR_EDGE)', 'COMPLETED anger', 'EXIT anger', 'ENTER recent (DETOUR_RETURN)']);
  });
  it('pin 3: nested detours return one level at a time', async () => {
    await edge('conversations:recent:s1', 'conversations:anger', { timing: 'always', behavior: 'detour' });
    await edge('conversations:anger:hot', 'conversations:deep', { timing: 'always', behavior: 'detour' });
    const chat = await start(); await respond(chat.chatId); await respond(chat.chatId);
    expect(await state(chat.chatId)).toMatchObject({ conversationName: 'deep' });
    await db.edge.deleteMany({ where: { memoryId: systemId, sourceId: ids['conversations:anger:hot'] } }); // else Q3: the rule beats the return
    await respond(chat.chatId, { goal_reached: true });
    expect(await state(chat.chatId)).toMatchObject({ conversationName: 'anger', stageName: 'hot' });
    await respond(chat.chatId, { goal_reached: true });
    const e = await state(chat.chatId);
    expect(e).toMatchObject({ conversationName: 'recent', stageName: 's1' });
    expect(e.goalStack.filter((g: any) => g.detourTo).map((g: any) => g.status)).toEqual(['COMPLETED', 'COMPLETED']);
  });
  it('pin 7: a completion inside a detour reached by a plain transition still returns', async () => {
    await edge('conversations:recent:s1', 'conversations:anger', { timing: 'always', behavior: 'detour' });
    await edge('conversations:anger:hot', 'conversations:deep', { timing: 'always', behavior: 'transition' });
    const chat = await start(); await respond(chat.chatId); await respond(chat.chatId);
    expect(await state(chat.chatId)).toMatchObject({ conversationName: 'deep' });
    expect(await respond(chat.chatId, { goal_reached: true })).toMatchObject({ detourReturned: true, conversationHandoff: 'recent' });
    expect(await state(chat.chatId)).toMatchObject({ conversationName: 'recent', stageName: 's1' });
  });
  it('the seed goal is never returned to: a chat with only it and a fallback goes to the fallback', async () => {
    const chat = await start();
    expect(await respond(chat.chatId, { goal_reached: true })).toMatchObject({ detourReturned: false, conversationHandoff: 'home', conversationCompleted: 'recent', newStageName: 'welcome', stageTransitioned: true });
    expect(trail(await state(chat.chatId)).slice(-3)).toEqual(['COMPLETED recent', 'EXIT recent', expect.stringMatching(/^ENTER home/)]);
  });
  it('pin 6: with no fallback conversation the chat stays put', async () => {
    await db.node.update({ where: { id: ids['conversations:home'] }, data: { data: { stageOrder: ['welcome'] } } });
    const chat = await start();
    expect(await respond(chat.chatId, { goal_reached: true })).toMatchObject({ stageTransitioned: false, conversationHandoff: null, conversationCompleted: 'recent' });
    expect(await state(chat.chatId)).toMatchObject({ conversationName: 'recent', stageName: 's1' });
  });
  it('pin 1: a stage-target rule moves to the stage and a later rule does not fire', async () => {
    await edge('conversations:recent:s1', 'conversations:recent:s2', { timing: 'always' }, 1);
    await edge('conversations:recent:s1', 'conversations:anger', { timing: 'always' }, 2);
    const chat = await start();
    expect(await respond(chat.chatId)).toMatchObject({ newStageName: 's2', conversationHandoff: null });
    expect(await state(chat.chatId)).toMatchObject({ conversationName: 'recent', stageName: 's2' });
  });
  it('#4256: a serialized second completion lawfully takes the still-active detour rule again', async () => {
    await edge('conversations:recent:s1', 'conversations:anger', { timing: 'always', behavior: 'detour' });
    const chat = await start(); await respond(chat.chatId);
    const returned = await respond(chat.chatId, { goal_reached: true });
    const repeated = await respond(chat.chatId, { goal_reached: true }, other as never);
    expect(returned).toMatchObject({ detourReturned: true });
    expect(repeated).toMatchObject({ detourReturned: false, conversationHandoff: 'anger' });
    expect(repeated.routingSkipped).not.toBe(true);
    const e = await state(chat.chatId);
    expect(e).toMatchObject({ conversationName: 'anger', stageName: 'hot' });
    expect(e.routeHistory.filter((r: any) => r.trigger?.type === 'DETOUR_RETURN')).toHaveLength(1);
    expect(e.routeHistory.at(-1)).toMatchObject({ action: 'ENTER', trigger: { type: 'DETOUR_EDGE' } });
    expect(e.goalStack.filter((g: any) => g.detourTo && g.status === 'COMPLETED')).toHaveLength(1);
    expect(e.goalStack.filter((g: any) => g.detourTo && g.status === 'ACTIVE')).toHaveLength(1);
  });
  // #4446: the barrier guard must fire BEFORE Vitest's own test timeout (default 5000 ms), or a stuck barrier reads as a bare
  // timeout instead of naming itself. The test timeout is derived from the guard, so the guard always wins.
  const BARRIER_GUARD_MS = 5000;
  const D6_TEST_TIMEOUT_MS = BARRIER_GUARD_MS * 3;
  it('D6: overlapping completions on separate connections return the detour once', async () => {
    await edge('conversations:recent:s1', 'conversations:anger', { timing: 'always', behavior: 'detour' });
    const chat = await start(); await respond(chat.chatId);
    const append = chatRoot.appendChatMessage;
    const snapshots: Array<{ client: unknown; conversationName: unknown; stageName: unknown }> = [];
    let release!: () => void;
    let rejectBarrier!: (error: Error) => void;
    const bothSnapshots = new Promise<void>((resolve, reject) => { release = resolve; rejectBarrier = reject; });
    const timer = setTimeout(() => rejectBarrier(new Error('Both completion snapshots did not reach the barrier')), BARRIER_GUARD_MS);
    // Real message inserts commit on both connections before either caller can
    // route. This forces the same pre-return origin without mocking DB state.
    const spy = vi.spyOn(chatRoot, 'appendChatMessage').mockImplementation(async (...args) => {
      const result = await append(...args);
      snapshots.push({ client: args[0], conversationName: result.chatData.conversationName, stageName: result.chatData.stageName });
      if (snapshots.length === 2) release();
      await bothSnapshots;
      return result;
    });
    const turns = [respond(chat.chatId, { goal_reached: true }), respond(chat.chatId, { goal_reached: true }, other as never)];
    try {
      const completions = await Promise.all(turns);
      expect(snapshots.map(({ conversationName, stageName }) => ({ conversationName, stageName }))).toEqual([
        { conversationName: 'anger', stageName: 'hot' }, { conversationName: 'anger', stageName: 'hot' },
      ]);
      expect(new Set(snapshots.map((snapshot) => snapshot.client)).size).toBe(2);
      const e = await state(chat.chatId);
      expect(e.routeHistory.filter((r: any) => r.trigger?.type === 'DETOUR_RETURN')).toHaveLength(1);
      expect(e.goalStack.filter((g: any) => g.detourTo && g.status === 'COMPLETED')).toHaveLength(1);
      expect(completions.filter((r) => r.detourReturned)).toHaveLength(1);
      expect(completions.filter((r) => r.routingSkipped)).toHaveLength(1);
      expect(e).toMatchObject({ conversationName: 'recent', stageName: 's1' });
      expect(e.goalStack.filter((g: any) => g.detourTo && g.status === 'ACTIVE')).toHaveLength(0);
    } finally {
      clearTimeout(timer);
      release();
      await Promise.allSettled(turns);
      spy.mockRestore();
    }
  }, D6_TEST_TIMEOUT_MS);
});
