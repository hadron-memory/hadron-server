/**
 * #4038 (Know Yourself S5, #3850): completion/routing rules are evaluated in every chat home an Agent is reached
 * through (shared App memory, App-key session memory, per-user memory), under the install-and-licence check, and a
 * condition reads the SPEAKING member's own facts (#910). cor:cht:030:02, cor:acl:010:01, cor:acl:010:04 (C1).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '../../../generated/prisma/index.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { serveEveryAgent } from '../../../test/servedBootPrompt.js';
import { generateId } from '../../../lib/id.js';
import { deriveEdgeLoc } from '../../../lib/edgeLoc.js';
import { ensureAgentSubscription } from '../../../controller/operations/ensureAgentSubscription.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as any;
let orgId: string, adminId: string, aliceId: string, bobId: string, agentId: string, systemId: string, appId: string;
const as = (userId: string): Context => ({ db, roles: ['READER'], userId });

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'Rules everywhere', urn: 'rules3850.test' } });
  orgId = org.id;
  const mk = async (n: string, role: 'ADMIN' | 'CONTRIBUTOR') => {
    const u = await db.user.create({ data: { handle: `rules3850-${n}` } });
    await db.orgMember.create({ data: { organizationId: org.id, userId: u.id, role } });
    return u.id;
  };
  adminId = await mk('admin', 'ADMIN'); aliceId = await mk('alice', 'CONTRIBUTOR'); bobId = await mk('bob', 'CONTRIBUTOR');
  const agent = await M.createAgent({}, { orgId, name: 'Rules agent', visibility: 'ORGANIZATION' }, { db, roles: ['ADMIN'], userId: adminId });
  agentId = agent.id; systemId = agent.systemMemoryId;
  const app = await db.app.create({ data: { name: 'Rules app', urn: `${org.urn}:app`, organizationId: org.id } });
  appId = app.id;
  await db.appAgent.create({ data: { appId, agentId } });
  for (const u of [aliceId, bobId]) await db.appMember.create({ data: { appId, userId: u, role: 'member' } });
  const ids: Record<string, string> = {};
  for (const [loc, data, content] of [
    ['config', { agentExtractionSpec: [{ field: 'memory.region' }] }, null],
    ['conversations', {}, null],
    ['conversations:intake', { stageOrder: ['scope'], isSetup: false, extractionSpec: [{ field: 'industry' }] }, null],
    ['conversations:intake:scope', { promptRef: 'prompts:intake:scope' }, null],
    ['conversations:done', { stageOrder: ['end'], isSetup: false }, null],
    ['conversations:done:end', { promptRef: 'prompts:intake:scope' }, null],
    ['prompts', {}, null], ['prompts:intake', {}, null], ['prompts:intake:scope', {}, 'RULES STAGE'],
  ] as const) {
    ids[loc] = (await db.node.create({ data: { memoryId: systemId, loc, name: loc.split(':').pop()!, nodeType: 'system', data: data as never, content } })).id;
  }
  await db.edge.create({ data: {
    memoryId: systemId, loc: deriveEdgeLoc('conversations:intake:scope', 'route', 'conversations:done'), name: 'route',
    sourceId: ids['conversations:intake:scope'], targetId: ids['conversations:done'],
    data: { timing: 'on_complete', behavior: 'transition' },
    condition: { '==': [{ var: 'memory.industry' }, 'farming'] },
  } as never });
  await serveEveryAgent(db);
});

const startShared = (userId: string) => M.startChat({}, { agentId, scope: 'shared', conversationName: 'intake' }, as(userId));
const complete = (ctx: Context, chatId: string, data?: Record<string, unknown>) =>
  M.processChatResponse({}, { chatId, toolResponse: { message: 'ok', goal_reached: true, ...(data ? { data } : {}), onTrack: true } }, ctx);
const uninstall = () => db.appAgent.delete({ where: { appId_agentId: { appId, agentId } } });

// C1 (Vera, #103559): a non-manager member's turn after uninstall reads nothing from the Agent's system memory. Alice is an
// org CONTRIBUTOR, not a manager, so cor:dmo:050:13 does not excuse a read. Every `db.node` read method and `db.edge.findMany`
// is spied; the only exempt call is the memory-wide-field list, which stays live by ruling Q10 (chatScript.ts) and is
// matched by its exact where shape.
async function observeDefinitionReads<T>(run: () => Promise<T>) {
  const defNodes = new Set((await db.node.findMany({ where: { memoryId: systemId }, select: { id: true } })).map((n) => n.id));
  const nodeSpies = (['findFirst', 'findMany', 'findUnique', 'findUniqueOrThrow', 'findFirstOrThrow'] as const).map((m) => vi.spyOn(db.node, m));
  const edgeSpy = vi.spyOn(db.edge, 'findMany');
  const isQ10FieldList = (where: any) => where?.OR?.length === 2
    && where.OR.some((c: any) => c.loc === 'config') && where.OR.some((c: any) => c.loc?.startsWith === 'conversations:');
  try {
    const value = await run();
    const nodeReads = nodeSpies.flatMap((sp) => sp.mock.calls).filter(([a]) => {
      const where = (a as any)?.where;
      if (isQ10FieldList(where)) return false;
      const memory = where?.memoryId ?? where?.loc_memoryId?.memoryId;
      return memory === systemId || memory?.equals === systemId || memory?.in?.includes(systemId);
    });
    const edgeReads = edgeSpy.mock.calls.filter(([a]) => defNodes.has((a as any)?.where?.sourceId));
    return { value, reads: [...nodeReads, ...edgeReads] };
  } finally { for (const sp of [...nodeSpies, edgeSpy]) sp.mockRestore(); }
}

describe('#4038 shared chat', () => {
  it('a flagged completion fires the rule in a shared chat', async () => {
    const chat = await startShared(aliceId);
    const result = await complete(as(aliceId), chat.chatId, { industry: 'farming' });
    expect(result.conversationHandoff).toBe('done');
  });

  it('after the App uninstalls the Agent a shared turn fires no rule and reads no definition (edge or node), on send and response', async () => {
    const chat = await startShared(aliceId);
    await uninstall();
    const sent = await observeDefinitionReads(() => M.sendChatMessage({}, { chatId: chat.chatId, userMessage: 'after uninstall' }, as(aliceId)));
    expect(sent.value.systemMessage).toBe('');
    expect(sent.reads).toEqual([]);
    const done = await observeDefinitionReads(() => complete(as(aliceId), chat.chatId, { industry: 'farming' }));
    expect(done.value.conversationHandoff).toBeNull();
    expect(done.reads).toEqual([]);
  });

  it("member A's condition does not see member B's bucket", async () => {
    const chat = await startShared(aliceId);
    await M.processChatResponse({}, { chatId: chat.chatId, toolResponse: { message: 'ok', data: { industry: 'farming' }, next_stage: 'scope', onTrack: true } }, as(aliceId));
    // Bob speaks in the same shared chat: Alice's `industry` is not his, so the condition is false for him.
    expect((await complete(as(bobId), chat.chatId)).conversationHandoff).toBeNull();
    // Alice's own turn reads her own bucket.
    expect((await complete(as(aliceId), chat.chatId)).conversationHandoff).toBe('done');
  });
});

// A pure App key starts the chat in its session's memory but cannot address a chat by loc (chatLocFilter matches
// nothing without a user), so the turn that carries the rules is the memory's own user responding.
describe('#4038 App-key session memory', () => {
  async function sessionHome(memoryClass: 'personal') {
    const memory = await db.memory.create({ data: {
      name: 'session home', urn: `rules3850.test:session-${generateId()}`, ownerUserId: aliceId, class: memoryClass,
      userId: aliceId, appId, userMemoryOfAgentId: agentId, createdBy: aliceId,
    } as never });
    await ensureAgentSubscription(db, aliceId, agentId);
    const session = await db.session.create({ data: { id: generateId(), appId, agentId, userId: aliceId, memoryId: memory.id } as never });
    const keyCtx = { db, roles: ['READER'], appId, sessionId: session.id } as unknown as Context;
    return { memory, keyCtx };
  }

  it.each(['personal'] as const)('a chat in a %s session memory evaluates rules for a pure App key', async (cls) => {
    const { memory, keyCtx } = await sessionHome(cls);
    const chat = await M.startChat({}, { agentId, conversationName: 'intake' }, keyCtx);
    expect((await db.node.findUnique({ where: { loc_memoryId: { loc: chat.chatId, memoryId: memory.id } } }))?.id).toBeTruthy();
    // A pure key has no person: `industry` is not memory-wide, so use an always-true view by dropping the condition.
    await db.edge.updateMany({ where: { memoryId: systemId, loc: { contains: 'route' } }, data: { condition: Prisma.DbNull } });
    expect((await complete(as(aliceId), chat.chatId)).conversationHandoff).toBe('done');
  });

  it.each(['personal'] as const)('C1: after uninstall a %s session chat evaluates no rules and reads no definition, on send and response', async (cls) => {
    const { keyCtx } = await sessionHome(cls);
    const chat = await M.startChat({}, { agentId, conversationName: 'intake' }, keyCtx);
    await db.edge.updateMany({ where: { memoryId: systemId, loc: { contains: 'route' } }, data: { condition: Prisma.DbNull } });
    await uninstall();
    const sent = await observeDefinitionReads(() => M.sendChatMessage({}, { chatId: chat.chatId, userMessage: 'after uninstall' }, as(aliceId)));
    expect(sent.value.systemMessage).toBe('');
    expect(sent.reads).toEqual([]);
    const done = await observeDefinitionReads(() => complete(as(aliceId), chat.chatId));
    expect(done.value.conversationHandoff).toBeNull();
    expect(done.reads).toEqual([]);
  });
});
