/** #4043: App-reached chat homes must not serve an uninstalled/unlicensed Agent's definition. */
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
  const org = await db.organization.create({ data: { name: 'Chat licence', urn: 'chat4043.test' } });
  const user = await db.user.create({ data: { handle: 'chat4043-manager' } });
  userId = user.id;
  await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Chat agent', visibility: 'ORGANIZATION' }, ctx());
  agentId = agent.id; systemId = agent.systemMemoryId;
  const app = await db.app.create({ data: {
    name: 'Chat app', urn: `${org.urn}:chat`, organizationId: org.id,
  } });
  appId = app.id;
  await db.appAgent.create({ data: { appId, agentId } });
  await db.appMember.create({ data: { appId, userId, role: 'member' } });
  for (const row of [
    { loc: 'conversations', data: {} },
    { loc: 'conversations:flow', data: { stageOrder: ['step'], isSetup: false } },
    { loc: 'conversations:flow:step', data: { promptRef: 'prompts:step' } },
    { loc: 'prompts', data: {} },
    { loc: 'prompts:step', content: 'LICENSED STAGE', data: {} },
    { loc: 'conversations:next', data: { stageOrder: ['next'] } },
    { loc: 'conversations:next:next', data: { promptRef: 'prompts:step' } },
    { loc: 'config', data: { privateConfig: 'LICENSED CONFIG' } },
  ]) await db.node.create({ data: { memoryId: systemId, name: row.loc, nodeType: 'system', ...row } });
  const stage = await db.node.findUniqueOrThrow({ where: { loc_memoryId: { memoryId: systemId, loc: 'conversations:flow:step' } } });
  const target = await db.node.findUniqueOrThrow({ where: { loc_memoryId: { memoryId: systemId, loc: 'conversations:next' } } });
  await db.edge.create({ data: { memoryId: systemId, sourceId: stage.id, targetId: target.id, loc: 'complete', name: 'complete', data: { timing: 'on_complete' } } });
  await serveEveryAgent(db);
});

/** Make a foreign App the only installed home; the caller still manages the Agent's owning org. */
async function foreignHome() {
  await db.appAgent.delete({ where: { appId_agentId: { appId, agentId } } });
  const org = await db.organization.create({ data: { name: 'Foreign', urn: 'foreign4043.test' } });
  foreignOrgId = org.id;
  await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'CONTRIBUTOR' } });
  const app = await db.app.create({ data: { organizationId: org.id, name: 'Foreign app', urn: `${org.urn}:app` } });
  appId = app.id;
  await db.appMember.create({ data: { appId, userId, role: 'member' } });
  await db.appAgent.create({ data: { appId, agentId } });
  await db.agentOrgGrant.create({ data: { orgId: org.id, agentId, activatedAt: new Date() } });
}

type Loss = 'uninstall' | 'revoked' | 'expired' | 'inactive';
async function loseLicence(loss: Loss) {
  if (loss === 'uninstall') {
    await db.appAgent.delete({ where: { appId_agentId: { appId, agentId } } });
  } else {
    await db.agentOrgGrant.update({ where: { orgId_agentId: { orgId: foreignOrgId, agentId } }, data: {
      ...(loss === 'revoked' ? { revokedAt: new Date() } : {}),
      ...(loss === 'expired' ? { expiresAt: new Date('2000-01-01T00:00:00Z') } : {}),
      ...(loss === 'inactive' ? { activatedAt: null } : {}),
    } });
  }
}

async function start(scope: 'private' | 'shared' = 'private') {
  const started = await M.startChat({}, { agentId, scope, conversationName: 'flow' }, ctx());
  expect(started.systemMessage).toContain('LICENSED STAGE');
  return started;
}

/** Observe directly memory-scoped Node reads and edge reads without replacing results.
 * The licensed control verifies this observer against both actual retrieval paths;
 * it is not a universal raw-SQL or transaction-client query recorder.
 */
async function observeDefinitionReads<T>(run: () => Promise<T>) {
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
    return { value, systemReads, edgeReads: edges.mock.calls.length };
  } finally {
    for (const spy of [first, many, unique, uniqueOrThrow, firstOrThrow, edges]) spy.mockRestore();
  }
}

for (const home of ['personal', 'knowledge'] as const) {
  for (const loss of ['uninstall', 'revoked', 'expired', 'inactive'] as const) {
    describe(`#4043 ${home} home after ${loss}`, () => {
      it('send gives empty prompt/no tools and reads no definition, even for the Agent manager', async () => {
        await foreignHome();
        const started = await start();
        const root = await chatNodeByLocOrThrow(db, started.chatId);
        if (home === 'knowledge') await db.memory.update({ where: { id: root.memoryId }, data: { class: 'knowledge', userId: null, organizationId: null, ownerUserId: userId, visibility: 'ORGANIZATION' } });
        await loseLicence(loss);
        const seen = await observeDefinitionReads<any>(() => M.sendChatMessage({}, { chatId: started.chatId, userMessage: 'after loss' }, ctx()));
        expect(seen.value.systemMessage, 'an unlicensed Agent definition must not re-enter an App-reached chat').toBe('');
        expect(seen.value.tools).toBeNull();
        expect(seen.systemReads).toEqual([]);
      });

      it('response evaluates no on-complete edges or system config, even for the Agent manager', async () => {
        await foreignHome();
        const started = await start();
        const root = await chatNodeByLocOrThrow(db, started.chatId);
        if (home === 'knowledge') await db.memory.update({ where: { id: root.memoryId }, data: { class: 'knowledge', userId: null, organizationId: null, ownerUserId: userId, visibility: 'ORGANIZATION' } });
        await loseLicence(loss);
        const seen = await observeDefinitionReads<any>(() => M.processChatResponse({}, { chatId: started.chatId, toolResponse: { message: 'done', next_stage: null } }, ctx()));
        expect(seen.value.conversationHandoff, 'an unlicensed Agent must not evaluate on-complete edges').toBeNull();
        expect(seen.systemReads).toEqual([]);
        expect(seen.edgeReads).toBe(0);
      });
    });
  }
}

describe('#4043 controls', () => {
  it('the licensed personal home still serves prompts/tools and fires its on-complete edge', async () => {
    await foreignHome();
    const started = await start();
    const sent = await observeDefinitionReads<any>(() => M.sendChatMessage({}, { chatId: started.chatId, userMessage: 'licensed' }, ctx()));
    expect(sent.value.systemMessage).toContain('LICENSED STAGE');
    expect(sent.value.tools).not.toBeNull();
    expect(sent.systemReads.length).toBeGreaterThan(0);
    const response = await observeDefinitionReads<any>(() => M.processChatResponse({}, { chatId: started.chatId, toolResponse: { message: 'done', next_stage: null } }, ctx()));
    expect(response.value.conversationHandoff).toBe('next');
    expect(response.systemReads.length).toBeGreaterThan(0);
    expect(response.edgeReads).toBeGreaterThan(0);
  });

  it('the database refuses an app-class chat home without appId', async () => {
    const started = await start('shared');
    const root = await chatNodeByLocOrThrow(db, started.chatId);
    await expect(db.memory.update({ where: { id: root.memoryId }, data: { appId: null } })).rejects.toThrow('chk_memory_class_app_id');
    expect((await db.memory.findUniqueOrThrow({ where: { id: root.memoryId } })).appId).toBe(appId);
  });

  it('an App-less personal home remains unchanged after its old App loses the install', async () => {
    const started = await start();
    const root = await chatNodeByLocOrThrow(db, started.chatId);
    await db.memory.update({ where: { id: root.memoryId }, data: { appId: null } });
    await loseLicence('uninstall');
    const sent = await M.sendChatMessage({}, { chatId: started.chatId, userMessage: 'standalone' }, ctx());
    expect(sent.systemMessage).toContain('LICENSED STAGE');
    expect(sent.tools).not.toBeNull();
    const response = await M.processChatResponse({}, { chatId: started.chatId, toolResponse: { message: 'done', next_stage: null } }, ctx());
    expect(response.conversationHandoff).toBe('next');
  });

  it('retained shared chat keeps its existing empty-prompt uninstall behavior', async () => {
    const started = await start('shared');
    await loseLicence('uninstall');
    const sent = await M.sendChatMessage({}, { chatId: started.chatId, userMessage: 'shared history' }, ctx());
    expect(sent.systemMessage).toBe('');
    expect(sent.tools).toBeNull();
  });

  it('shared chat retains its empty result for a soft-deleted Agent', async () => {
    const started = await start('shared');
    await db.agent.update({ where: { id: agentId }, data: { deletedAt: new Date() } });
    const sent = await M.sendChatMessage({}, { chatId: started.chatId, userMessage: 'shared history' }, ctx());
    expect(sent.systemMessage).toBe('');
    expect(sent.tools).toBeNull();
  });

  it.each([true, false])('shared response preserves its non-evaluating on-complete path (installed=%s)', async (installed) => {
    const started = await start('shared');
    const root = await chatNodeByLocOrThrow(db, started.chatId);
    if (!installed) await loseLicence('uninstall');
    const install = await db.appAgent.findUnique({ where: { appId_agentId: { appId, agentId } } });
    expect(install !== null).toBe(installed);
    const state = await db.chatRootEngineState.findUniqueOrThrow({ where: { chatRootNodeId: root.id } });
    expect(state.state).toMatchObject({ conversationName: 'flow', stageName: 'step' });
    const messages = () => db.node.count({ where: { memoryId: root.memoryId, loc: { startsWith: `${started.chatId}:messages:` } } });
    const before = await messages();
    const response = await observeDefinitionReads<any>(() => M.processChatResponse({}, { chatId: started.chatId, toolResponse: { message: 'done', next_stage: null } }, ctx()));
    expect(await messages()).toBe(before + 1); // A no-op/already-complete return cannot satisfy this control.
    expect(response.value.conversationHandoff).toBeNull();
    expect(response.systemReads).toEqual([]);
    expect(response.edgeReads).toBe(0);
  });

  it('private start selects a licensed App rather than the earlier retained unlicensed install', async () => {
    await foreignHome();
    await loseLicence('revoked');
    const org = await db.organization.create({ data: { name: 'Licensed', urn: 'licensed4043.test' } });
    await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'CONTRIBUTOR' } });
    const live = await db.app.create({ data: { organizationId: org.id, name: 'Live', urn: `${org.urn}:app` } });
    await db.appAgent.create({ data: { appId: live.id, agentId } });
    await db.appMember.create({ data: { appId: live.id, userId, role: 'member' } });
    await db.agentOrgGrant.create({ data: { orgId: org.id, agentId, activatedAt: new Date() } });
    const started = await start();
    const root = await chatNodeByLocOrThrow(db, started.chatId);
    expect((await db.memory.findUniqueOrThrow({ where: { id: root.memoryId } })).appId).toBe(live.id);
  });
});
