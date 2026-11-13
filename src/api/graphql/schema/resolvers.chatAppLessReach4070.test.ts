/** #4070: an App-less chat home's response must re-check the CURRENT caller's reach to the Agent (the shared
 * canChatWithAgent), before any system definition/config/rule read. Lost reach = a successful response with the turn
 * recorded and no Agent-derived routing: no error, no rollback (cor:acl:010:01, cor:cht:020:01). */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, chatNodeByLocOrThrow } from '../../../test/helpers.js';
import { serveEveryAgent } from '../../../test/servedBootPrompt.js';
import { resolvers, type Context } from './resolvers.js';
import { chatHomeAgentIfLicensed } from '../../../lib/chatHomeAgent.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as any;
let managerId: string, consumerId: string, appId: string, agentId: string, systemId: string, licOrgId: string;
const managerCtx = (): Context => ({ db, userId: managerId, roles: ['READER'] });
const consumerCtx = (): Context => ({ db, userId: consumerId, roles: ['READER'] });

beforeEach(async () => {
  await cleanDb(db);
  const agentOrg = await db.organization.create({ data: { name: 'Agent org', urn: 'reach4070.agent' } });
  managerId = (await db.user.create({ data: { handle: 'reach4070-manager' } })).id;
  consumerId = (await db.user.create({ data: { handle: 'reach4070-consumer' } })).id;
  await db.orgMember.create({ data: { organizationId: agentOrg.id, userId: managerId, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: agentOrg.id, name: 'Reach agent', visibility: 'ORGANIZATION' }, managerCtx());
  agentId = agent.id; systemId = agent.systemMemoryId;
  // The licensed App L lives in an org neither user belongs to as a consumer; the consumer has NO org membership at all.
  const licOrg = await db.organization.create({ data: { name: 'Licensed org', urn: 'reach4070.lic' } });
  licOrgId = licOrg.id;
  const app = await db.app.create({ data: { organizationId: licOrg.id, name: 'App L', urn: `${licOrg.urn}:l` } });
  appId = app.id;
  await db.appAgent.create({ data: { appId, agentId } });
  await db.agentOrgGrant.create({ data: { orgId: licOrg.id, agentId, activatedAt: new Date() } });
  await db.appMember.create({ data: { appId, userId: consumerId, role: 'member' } });
  await db.appMember.create({ data: { appId, userId: managerId, role: 'member' } });
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

/** A retained App-less home: started through licensed App L, then detached from it (an historical home). */
async function retainedHome(who: Context) {
  const started = await M.startChat({}, { agentId, scope: 'private', conversationName: 'flow' }, who);
  const root = await chatNodeByLocOrThrow(db, started.chatId);
  await db.memory.update({ where: { id: root.memoryId }, data: { appId: null } });
  return { chatId: started.chatId, memoryId: root.memoryId, rootId: root.id };
}

type Loss = 'uninstall' | 'revoked' | 'expired' | 'inactive';
async function loseReach(loss: Loss) {
  if (loss === 'uninstall') await db.appAgent.delete({ where: { appId_agentId: { appId, agentId } } });
  else await db.agentOrgGrant.update({ where: { orgId_agentId: { orgId: licOrgId, agentId } }, data: {
    ...(loss === 'revoked' ? { revokedAt: new Date() } : {}),
    ...(loss === 'expired' ? { expiresAt: new Date('2000-01-01T00:00:00Z') } : {}),
    ...(loss === 'inactive' ? { activatedAt: null } : {}),
  } });
}

/** Observe system-memory Node reads and edge reads without replacing results. */
async function observe<T>(run: () => Promise<T>) {
  const spies = [
    vi.spyOn(db.node, 'findFirst'), vi.spyOn(db.node, 'findMany'), vi.spyOn(db.node, 'findUnique'),
    vi.spyOn(db.node, 'findUniqueOrThrow'), vi.spyOn(db.node, 'findFirstOrThrow'),
  ];
  const edges = vi.spyOn(db.edge, 'findMany');
  try {
    const value = await run();
    const systemReads = spies.flatMap(s => s.mock.calls).filter(([args]) => {
      const where = (args as any)?.where;
      const memory = where?.memoryId ?? where?.loc_memoryId?.memoryId;
      return memory === systemId || memory?.equals === systemId || memory?.in?.includes(systemId);
    });
    return { value, systemReads, edgeReads: edges.mock.calls.length };
  } finally { for (const s of [...spies, edges]) s.mockRestore(); }
}

const respond = (ctx: Context, chatId: string, next_stage: string | null = null) =>
  M.processChatResponse({}, { chatId, toolResponse: { message: 'done', next_stage } }, ctx);
const messages = (memoryId: string, chatId: string) =>
  db.node.count({ where: { memoryId, loc: { startsWith: `${chatId}:messages:` } } });
const routeHistory = async (rootId: string) =>
  ((await db.chatRootEngineState.findUniqueOrThrow({ where: { chatRootNodeId: rootId } })).state as any).routeHistory ?? [];

describe('#4070 lost reach on an App-less home (no org membership)', () => {
  for (const loss of ['uninstall', 'revoked', 'expired', 'inactive'] as const) {
    it(`L: after ${loss} the response records the turn, routes nothing, reads no definition`, async () => {
      const home = await retainedHome(consumerCtx());
      await loseReach(loss);
      const msgs = await messages(home.memoryId, home.chatId);
      const history = await routeHistory(home.rootId);
      const seen = await observe<any>(() => respond(consumerCtx(), home.chatId));
      expect(seen.value).toMatchObject({ displayMessage: 'done', stageTransitioned: false, newStageName: null, conversationHandoff: null, chatEnded: false });
      expect(await messages(home.memoryId, home.chatId), 'the assistant turn stays recorded exactly once').toBe(msgs + 1);
      expect(await routeHistory(home.rootId), 'no edge-derived route entry').toEqual(history);
      expect(seen.systemReads, 'no system definition/config/rule read after lost reach').toEqual([]);
      expect(seen.edgeReads).toBe(0);
    });
  }

  it('O1: the reported own-org variant (an unlicensed install in the caller\'s own org) is the same', async () => {
    const own = await db.organization.create({ data: { name: 'Own org', urn: 'reach4070.own' } });
    await db.orgMember.create({ data: { organizationId: own.id, userId: consumerId, role: 'CONTRIBUTOR' } });
    const ownApp = await db.app.create({ data: { organizationId: own.id, name: 'Own app', urn: `${own.urn}:x` } });
    await db.appAgent.create({ data: { appId: ownApp.id, agentId } });
    const home = await retainedHome(consumerCtx());
    await loseReach('revoked');
    const seen = await observe<any>(() => respond(consumerCtx(), home.chatId));
    expect(seen.value.conversationHandoff).toBeNull();
    expect(seen.systemReads).toEqual([]);
    expect(seen.edgeReads).toBe(0);
  });

  it('D1: a soft-deleted Agent on an App-less home routes nothing and reads no definition', async () => {
    const home = await retainedHome(managerCtx());
    await db.agent.update({ where: { id: agentId }, data: { deletedAt: new Date() } });
    const msgs = await messages(home.memoryId, home.chatId);
    const seen = await observe<any>(() => respond(managerCtx(), home.chatId));
    expect(seen.value.conversationHandoff).toBeNull();
    expect(await messages(home.memoryId, home.chatId)).toBe(msgs + 1);
    expect(seen.systemReads).toEqual([]);
    expect(seen.edgeReads).toBe(0);
  });

  it('E1: lost reach with an explicit next_stage reads no definition and does not throw', async () => {
    const home = await retainedHome(consumerCtx());
    await loseReach('revoked');
    const seen = await observe<any>(() => respond(consumerCtx(), home.chatId, 'step'));
    expect(seen.value.conversationHandoff).toBeNull();
    expect(seen.systemReads).toEqual([]);
    expect(seen.edgeReads).toBe(0);
  });
});

describe('#4070 pinned revision', () => {
  it('lost reach on a chat pinned to a revision reads not even the revision node (the gate precedes loadChatScript)', async () => {
    const home = await retainedHome(consumerCtx());
    const root = await db.node.findUniqueOrThrow({ where: { id: home.rootId } });
    await db.node.update({ where: { id: home.rootId }, data: { data: { ...(root.data as object), startedWithRevision: 'revisions:r1' } } });
    await loseReach('revoked');
    const seen = await observe<any>(() => respond(consumerCtx(), home.chatId));
    expect(seen.value.conversationHandoff).toBeNull();
    expect(seen.systemReads).toEqual([]);
  });
});

describe('#4070 controls', () => {
  it('P1: a consumer who still has licensed reach fires the on-complete rule (observers see real reads)', async () => {
    const home = await retainedHome(consumerCtx());
    const seen = await observe<any>(() => respond(consumerCtx(), home.chatId));
    expect(seen.value.conversationHandoff).toBe('next');
    expect(seen.systemReads.length).toBeGreaterThan(0);
    expect(seen.edgeReads).toBeGreaterThan(0);
  });

  it('P2: the Agent org ADMIN (not an App member of any usable carrier) keeps reach after the licence is gone', async () => {
    const home = await retainedHome(managerCtx());
    await loseReach('uninstall');
    const seen = await observe<any>(() => respond(managerCtx(), home.chatId));
    expect(seen.value.conversationHandoff).toBe('next');
    expect(seen.systemReads.length).toBeGreaterThan(0);
  });
});

describe('#4070 review follow-ups', () => {
  it('S1: send on a lost-reach App-less home refuses AGENT_NOT_FOUND BEFORE it reads the pinned revision (Baloo P2_1)', async () => {
    const rev = await M.createRevision({}, { agentId }, managerCtx());
    await M.publishRevision({}, { agentId, revisionLoc: rev.revisionLoc }, managerCtx());
    const home = await retainedHome(consumerCtx());
    const root = await db.node.findUniqueOrThrow({ where: { id: home.rootId } });
    expect((root.data as any).startedWithRevision, 'the chat must be pinned for this pin to mean anything').toBe(rev.revisionLoc);
    await loseReach('revoked');
    const spy = vi.spyOn(db.node, 'findFirst');
    try {
      await expect(M.sendChatMessage({}, { chatId: home.chatId, userMessage: 'after loss' }, consumerCtx())).rejects.toThrow(/not found|AGENT_NOT_FOUND/i);
      const reads = spy.mock.calls.filter(([a]) => (a as any)?.where?.memoryId === systemId);
      expect(reads, 'no protected system read before the refusal').toEqual([]);
    } finally { spy.mockRestore(); }
  });

  it('H1: the helper judges reach through the db handle it was given, not caller.db (Gizelle P2)', async () => {
    const home = await retainedHome(consumerCtx());
    const memory = await db.memory.findUniqueOrThrow({ where: { id: home.memoryId } });
    const agentRow = await db.agent.findUniqueOrThrow({ where: { id: agentId } });
    const hostile = new Proxy(db, { get: (t, k) => k === 'agent' ? { findUnique: () => { throw new Error('caller.db was read'); } } : (t as any)[k] });
    const out = await chatHomeAgentIfLicensed(db, memory, agentRow, { ...consumerCtx(), db: hostile as any });
    expect(out?.id).toBe(agentId);
  });
});
