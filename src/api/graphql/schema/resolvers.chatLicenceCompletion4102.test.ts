/**
 * #4102 F8: pin that a completion after an install/licence loss is ENGINE-ONLY — the turn still records
 * `completedConversations` and a COMPLETED route-history entry, while no definition is read, no edge is
 * evaluated and nothing moves.
 *
 * BUILT, NOT RULED (the gate's wording, from the spec FIT): cor:acl:010:01 forbids reading the Agent's
 * definition after a loss, and recording the chatbot's own goal-reached turn reads none, so the access law
 * allows it; every move K2 could trigger (on-complete rules, the detour return, the Q8/Q8a fallback move)
 * needs the script, and none may run. cor:cht:030:02 does not consider a licence loss — "recorded as done,
 * nothing moves" is the code's behaviour, consistent with both specs, and Holger has not ruled on it. If a
 * completion after a loss should record nothing, that is a ruling, not a test change.
 *
 * Neighbours: the no-definition-read/no-edge assertions per loss mode and home class live in
 * resolvers.chatHomeLicence4043.test.ts (its matrix), and the licensed completion-recording contract
 * (once with its first time, COMPLETED on every completion) in resolvers.chatCompletion4036.test.ts.
 * This file pins their intersection: the recording itself survives the licence loss.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, chatNodeByLocOrThrow } from '../../../test/helpers.js';
import { serveEveryAgent } from '../../../test/servedBootPrompt.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as any;
let userId: string, appId: string, agentId: string, systemId: string, foreignOrgId: string;
const ctx = (): Context => ({ db, userId, roles: ['READER'] });

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'Licence completion', urn: 'chat4102.test' } });
  const user = await db.user.create({ data: { handle: 'chat4102-manager' } });
  userId = user.id;
  await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Chat agent', visibility: 'ORGANIZATION' }, ctx());
  agentId = agent.id; systemId = agent.systemMemoryId;
  const app = await db.app.create({ data: { name: 'Chat app', urn: `${org.urn}:chat`, organizationId: org.id } });
  appId = app.id;
  await db.appAgent.create({ data: { appId, agentId } });
  await db.appMember.create({ data: { appId, userId, role: 'member' } });
  for (const row of [
    { loc: 'conversations', data: {} },
    { loc: 'conversations:flow', data: { stageOrder: ['step', 'other'], isSetup: false } },
    { loc: 'conversations:flow:step', data: { promptRef: 'prompts:step' } },
    { loc: 'conversations:flow:other', data: { promptRef: 'prompts:step' } },
    { loc: 'prompts', data: {} },
    { loc: 'prompts:step', content: 'LICENSED STAGE', data: {} },
    { loc: 'conversations:next', data: { stageOrder: ['next'] } },
    { loc: 'conversations:next:next', data: { promptRef: 'prompts:step' } },
  ]) await db.node.create({ data: { memoryId: systemId, name: row.loc, nodeType: 'system', ...row } });
  const stage = await db.node.findUniqueOrThrow({ where: { loc_memoryId: { memoryId: systemId, loc: 'conversations:flow:step' } } });
  const target = await db.node.findUniqueOrThrow({ where: { loc_memoryId: { memoryId: systemId, loc: 'conversations:next' } } });
  // An on_complete rule that WOULD move the chat on completion — after a licence loss it must not fire.
  await db.edge.create({ data: { memoryId: systemId, sourceId: stage.id, targetId: target.id, loc: 'complete', name: 'complete', data: { timing: 'on_complete' } } });
  await serveEveryAgent(db);
});

/** Make a foreign App the only installed home; the caller still manages the Agent's owning org. */
async function foreignHome() {
  await db.appAgent.delete({ where: { appId_agentId: { appId, agentId } } });
  const org = await db.organization.create({ data: { name: 'Foreign', urn: 'foreign4102.test' } });
  foreignOrgId = org.id;
  await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'CONTRIBUTOR' } });
  const app = await db.app.create({ data: { organizationId: org.id, name: 'Foreign app', urn: `${org.urn}:app` } });
  appId = app.id;
  await db.appMember.create({ data: { appId, userId, role: 'member' } });
  await db.appAgent.create({ data: { appId, agentId } });
  await db.agentOrgGrant.create({ data: { orgId: org.id, agentId, activatedAt: new Date() } });
}

type Loss = 'uninstall' | 'revoked';
async function loseLicence(loss: Loss) {
  if (loss === 'uninstall') {
    await db.appAgent.delete({ where: { appId_agentId: { appId, agentId } } });
  } else {
    await db.agentOrgGrant.update({ where: { orgId_agentId: { orgId: foreignOrgId, agentId } }, data: { revokedAt: new Date() } });
  }
}

async function start(pinned = false) {
  if (pinned) {
    const rev = await M.createRevision({}, { agentId }, ctx());
    await M.publishRevision({}, { agentId, revisionLoc: rev.revisionLoc }, ctx());
  }
  return M.startChat({}, { agentId, scope: 'private', conversationName: 'flow' }, ctx());
}

/** Observe memory-scoped Node/edge reads from the Agent's definition, without replacing results (as #4043's). */
async function observeDefinitionReads<T>(run: () => Promise<T>) {
  const definitionNodeIds = new Set((await db.node.findMany({ where: { memoryId: systemId }, select: { id: true } })).map((n) => n.id));
  const first = vi.spyOn(db.node, 'findFirst');
  const many = vi.spyOn(db.node, 'findMany');
  const unique = vi.spyOn(db.node, 'findUnique');
  const uniqueOrThrow = vi.spyOn(db.node, 'findUniqueOrThrow');
  const firstOrThrow = vi.spyOn(db.node, 'findFirstOrThrow');
  const edges = vi.spyOn(db.edge, 'findMany');
  try {
    const value = await run();
    const systemReads = [...first.mock.calls, ...many.mock.calls, ...unique.mock.calls,
      ...uniqueOrThrow.mock.calls, ...firstOrThrow.mock.calls].filter(([args]) => {
      const where = (args as any)?.where;
      const memory = where?.memoryId ?? where?.loc_memoryId?.memoryId;
      return memory === systemId || memory?.equals === systemId || memory?.in?.includes(systemId);
    });
    const edgeReads = edges.mock.calls.filter(([args]) => {
      const source = (args as any)?.where?.sourceId;
      return typeof source === 'string' ? definitionNodeIds.has(source) : false;
    }).length;
    return { value, systemReads, edgeReads };
  } finally {
    for (const spy of [first, many, unique, uniqueOrThrow, firstOrThrow, edges]) spy.mockRestore();
  }
}

describe('#4102 F8 completion after an install/licence loss is engine-only (built, not ruled)', () => {
  it('uninstalled Agent, pinned chat: the completion is recorded, no definition is read, nothing moves', async () => {
    await foreignHome();
    const started = await start(true);
    await loseLicence('uninstall');
    const seen = await observeDefinitionReads<any>(() =>
      M.processChatResponse({}, { chatId: started.chatId, toolResponse: { message: 'done', next_stage: null, goal_reached: true } }, ctx()));
    expect(seen.value).toMatchObject({
      conversationCompleted: 'flow', conversationHandoff: null, stageTransitioned: false,
      newStageName: null, detourReturned: false, routingSkipped: false,
    });
    expect(seen.systemReads).toEqual([]);
    expect(seen.edgeReads).toBe(0);
    const root = await chatNodeByLocOrThrow(db, started.chatId);
    const engine = (await db.chatRootEngineState.findUniqueOrThrow({ where: { chatRootNodeId: root.id } })).state as any;
    expect(engine.completedConversations).toEqual([{ conversation: 'flow', completedAt: expect.any(String) }]);
    expect(engine.routeHistory.at(-1)).toMatchObject({
      action: 'COMPLETED', conversationUrn: 'conversations:flow', nodeUrn: 'conversations:flow:step', trigger: { type: 'GOAL_REACHED' },
    });
    expect(engine).toMatchObject({ conversationName: 'flow', stageName: 'step' });
  });

  it('revoked grant, knowledge home, unpinned chat: same engine-only completion', async () => {
    await foreignHome();
    const started = await start();
    const root = await chatNodeByLocOrThrow(db, started.chatId);
    await db.memory.update({ where: { id: root.memoryId }, data: { class: 'knowledge', userId: null, organizationId: null, ownerUserId: userId, visibility: 'ORGANIZATION' } });
    await loseLicence('revoked');
    const seen = await observeDefinitionReads<any>(() =>
      M.processChatResponse({}, { chatId: started.chatId, toolResponse: { message: 'done', next_stage: null, goal_reached: true } }, ctx()));
    expect(seen.value).toMatchObject({ conversationCompleted: 'flow', conversationHandoff: null, stageTransitioned: false });
    expect(seen.systemReads).toEqual([]);
    expect(seen.edgeReads).toBe(0);
    const engine = (await db.chatRootEngineState.findUniqueOrThrow({ where: { chatRootNodeId: root.id } })).state as any;
    expect(engine.completedConversations).toEqual([{ conversation: 'flow', completedAt: expect.any(String) }]);
    expect(engine.routeHistory.at(-1)).toMatchObject({ action: 'COMPLETED', trigger: { type: 'GOAL_REACHED' } });
    expect(engine).toMatchObject({ conversationName: 'flow', stageName: 'step' });
  });

  // The licensed control: the same turn fires the on_complete edge AND records the completion. The 4043
  // file pins the handoff/read side of this control; this adds the recording, so the loss above is seen
  // removing only the definition-driven parts, not the engine-only ones.
  it('licensed control: the same completion also reads the definition and fires its on_complete edge', async () => {
    await foreignHome();
    const started = await start();
    const seen = await observeDefinitionReads<any>(() =>
      M.processChatResponse({}, { chatId: started.chatId, toolResponse: { message: 'done', next_stage: null, goal_reached: true } }, ctx()));
    expect(seen.value).toMatchObject({ conversationCompleted: 'flow', conversationHandoff: 'next' });
    expect(seen.systemReads.length).toBeGreaterThan(0);
    expect(seen.edgeReads).toBeGreaterThan(0);
    const root = await chatNodeByLocOrThrow(db, started.chatId);
    const engine = (await db.chatRootEngineState.findUniqueOrThrow({ where: { chatRootNodeId: root.id } })).state as any;
    expect(engine.completedConversations).toEqual([{ conversation: 'flow', completedAt: expect.any(String) }]);
  });
});
