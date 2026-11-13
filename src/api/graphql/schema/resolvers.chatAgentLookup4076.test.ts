/**
 * #4076: sendChatMessage and processChatResponse resolve a chat home's Agent through ONE lookup
 * (resolve, deleted = none -> licence -> read), with a documented legacy order (createdAt, id).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, chatNodeByLocOrThrow } from '../../../test/helpers.js';
import { serveEveryAgent } from '../../../test/servedBootPrompt.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as any;
let userId: string, orgId: string, appId: string, agentId: string, systemId: string;
const ctx = (): Context => ({ db, userId, roles: ['READER'] });

/** Seed an Agent system memory whose conversation `flow` has stages [step, <own>] and a prompt naming the Agent. */
async function seedScript(sysId: string, label: string, own: string) {
  for (const row of [
    { loc: 'conversations', data: {} },
    { loc: 'conversations:flow', data: { stageOrder: ['step', own], isSetup: false } },
    { loc: 'conversations:flow:step', data: { promptRef: 'prompts:step' } },
    { loc: `conversations:flow:${own}`, data: { promptRef: 'prompts:step' } },
    { loc: 'prompts', data: {} },
    { loc: 'prompts:step', content: `STAGE OF ${label}`, data: {} },
  ]) await db.node.create({ data: { memoryId: sysId, name: row.loc, nodeType: 'system', ...row } });
}

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'Lookup', urn: 'lookup4076.test' } });
  orgId = org.id;
  const user = await db.user.create({ data: { handle: 'lookup4076-manager' } });
  userId = user.id;
  await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId, name: 'Agent A', visibility: 'ORGANIZATION' }, ctx());
  agentId = agent.id; systemId = agent.systemMemoryId;
  const app = await db.app.create({ data: { name: 'Lookup app', urn: `${org.urn}:chat`, organizationId: org.id } });
  appId = app.id;
  await db.appAgent.create({ data: { appId, agentId } });
  await db.appMember.create({ data: { appId, userId, role: 'member' } });
  await seedScript(systemId, 'A', 'onlyA');
  await serveEveryAgent(db);
});

async function start(scope: 'private' | 'shared' = 'private') {
  return M.startChat({}, { agentId, scope, conversationName: 'flow' }, ctx());
}

/** Turn the started chat's memory into a legacy one: no home pointers, agents linked by read-write items. */
async function makeLegacy(chatId: string, linked: string[]) {
  const root = await chatNodeByLocOrThrow(db, chatId);
  await db.memory.update({ where: { id: root.memoryId }, data: {
    class: 'knowledge', userId: null, organizationId: null, ownerUserId: userId, visibility: 'ORGANIZATION',
    appId: null, userMemoryOfAgentId: null, sharedMemoryOfAgentId: null,
  } });
  for (const id of linked) await db.agentMemoryItem.create({ data: { agentId: id, memoryId: root.memoryId, role: 'read-write' } });
}

describe('#4076 legacy order parity', () => {
  it('two linked legacy Agents resolve the same one (oldest createdAt) on send and on response', async () => {
    // B is inserted after A but dated EARLIER: an unordered lookup returns A, the documented order returns B.
    const b = await M.createAgent({}, { orgId, name: 'Agent B', visibility: 'ORGANIZATION' }, ctx());
    await seedScript(b.systemMemoryId, 'B', 'onlyB');
    await db.agent.update({ where: { id: b.id }, data: { createdAt: new Date('2000-01-01T00:00:00Z') } });
    await serveEveryAgent(db);
    const started = await start();
    await makeLegacy(started.chatId, [agentId, b.id]);

    const sent = await M.sendChatMessage({}, { chatId: started.chatId, userMessage: 'hi' }, ctx());
    expect(sent.systemMessage).toContain('STAGE OF B');

    const viaB = await M.processChatResponse({}, { chatId: started.chatId, toolResponse: { message: 'ok', next_stage: 'onlyB' } }, ctx());
    expect(viaB.rejectedNextStage ?? null).toBeNull();
    const viaA = await M.processChatResponse({}, { chatId: started.chatId, toolResponse: { message: 'ok', next_stage: 'onlyA' } }, ctx());
    expect(viaA.rejectedNextStage).toBe('onlyA');
  });
});

describe('#4076 soft-deleted Agent resolves to none on both paths', () => {
  it.each(['private', 'shared'] as const)('%s chat: response takes the no-Agent path for a deleted Agent', async (scope) => {
    const started = await start(scope);
    await db.agent.update({ where: { id: agentId }, data: { deletedAt: new Date() } });
    // With an Agent, `step` is the current stage and is accepted; with none the stage list is unreadable and the name is refused (#4077).
    const response = await M.processChatResponse({}, { chatId: started.chatId, toolResponse: { message: 'done', next_stage: 'step' } }, ctx());
    expect(response.rejectedNextStage).toBe('step');
    expect(response.conversationHandoff ?? null).toBeNull();
  });

  it('shared chat: send serves the existing empty no-Agent result for a deleted Agent', async () => {
    const started = await start('shared');
    await db.agent.update({ where: { id: agentId }, data: { deletedAt: new Date() } });
    const sent = await M.sendChatMessage({}, { chatId: started.chatId, userMessage: 'x' }, ctx());
    expect(sent.systemMessage).toBe('');
    expect(sent.tools).toBeNull();
  });
});
