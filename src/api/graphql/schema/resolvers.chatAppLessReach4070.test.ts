/** #4070: an App-less chat home's response must re-check the CURRENT caller's reach to the Agent (the shared
 * canChatWithAgent), before any system definition/config/rule read. Lost reach = a successful response with the turn
 * recorded and no Agent-derived routing: no error, no rollback (cor:acl:010:01, cor:cht:020:01). */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, chatNodeByLocOrThrow } from '../../../test/helpers.js';
import { serveEveryAgent } from '../../../test/servedBootPrompt.js';
import { resolvers, type Context } from './resolvers.js';
import { chatHomeAgentIfReachable } from '../../../lib/chatHomeAgent.js';
import { detachAppOwnerMemories } from '../../../controller/operations/detachAppOwnerMemories.js';
import { observeClient } from '../../../test/chatReadObserver.js';

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

/** A home started through licensed App L, then detached from it. Two detach shapes (#4105, Gizelle P3 on #4093):
 *  - `'legacy'` (default): `appId` cleared and the Agent pointer (`userMemoryOfAgentId`) KEPT. That is the retained pre-#4095 shape
 *    these pins are about: an App-less home that still names its Agent, so only the reach check stands between the caller and
 *    the Agent's definition. Production no longer produces it (the real path clears the pointer too, below), but rows written
 *    before that path exist, so the pins keep it. NOT equivalent to the production detach; the D-pins below cover that one.
 *  - `'production'`: `detachAppOwnerMemories`, which clears BOTH `appId` and the pointer, as deleting or replacing an App does.
 * `{ keepApp: true }` leaves the home App-bearing, still attached to App L. */
async function retainedHome(who: Context, { keepApp = false, detach = 'legacy' }: { keepApp?: boolean; detach?: 'legacy' | 'production' } = {}) {
  const started = await M.startChat({}, { agentId, scope: 'private', conversationName: 'flow' }, who);
  const root = await chatNodeByLocOrThrow(db, started.chatId);
  if (!keepApp) {
    if (detach === 'production') await db.$transaction(tx => detachAppOwnerMemories(tx, [appId]));
    else await db.memory.update({ where: { id: root.memoryId }, data: { appId: null } });
  }
  return { chatId: started.chatId, memoryId: root.memoryId, rootId: root.id };
}

type Loss = 'uninstall' | 'revoked' | 'expired' | 'inactive';
async function errorOf(run: () => Promise<unknown>) {
  try { await run(); return null; } catch (error: any) { return { message: error.message, code: error.code }; }
}
async function loseReach(loss: Loss) {
  if (loss === 'uninstall') await db.appAgent.delete({ where: { appId_agentId: { appId, agentId } } });
  else await db.agentOrgGrant.update({ where: { orgId_agentId: { orgId: licOrgId, agentId } }, data: {
    ...(loss === 'revoked' ? { revokedAt: new Date() } : {}),
    ...(loss === 'expired' ? { expiresAt: new Date('2000-01-01T00:00:00Z') } : {}),
    ...(loss === 'inactive' ? { activatedAt: null } : {}),
  } });
}

/** Observe the system memory's Node/Edge reads without replacing results, through the shared observer (#4105): it follows
 * transaction clients and raw queries and matches the protected ids anywhere in a call's arguments (AND/OR included). */
async function observe<T>(ctxOf: () => Context, run: (ctx: Context) => Promise<T>) {
  const protectedIds = [systemId, ...(await db.node.findMany({ where: { memoryId: systemId }, select: { id: true } })).map(n => n.id)];
  const reads: string[] = [];
  const value = await run({ ...ctxOf(), db: observeClient(db, protectedIds, reads) });
  return { value, systemReads: reads, edgeReads: reads.filter(r => r.startsWith('edge.')).length };
}

const respond = (ctx: Context, chatId: string, next_stage: string | null = null, data?: Record<string, unknown>) =>
  // #4036: the on-complete rule fires only on an explicit completion, so a null next_stage carries goal_reached.
  M.processChatResponse({}, { chatId, toolResponse: { message: 'done', next_stage, ...(data ? { data } : {}), ...(next_stage === null ? { goal_reached: true } : {}) } }, ctx);
const homeData = async (memoryId: string) =>
  (await db.node.findFirst({ where: { memoryId, loc: 'data', deletedAt: null } }))?.data as Record<string, unknown> | undefined;
const messages = (memoryId: string, chatId: string) =>
  db.node.count({ where: { memoryId, loc: { startsWith: `${chatId}:messages:` } } });
const routeHistory = async (rootId: string) =>
  ((await db.chatRootEngineState.findUniqueOrThrow({ where: { chatRootNodeId: rootId } })).state as any).routeHistory ?? [];

describe('#4070 lost reach on an App-less home (no org membership)', () => {
  // #4105: the valid-extraction leg of the acceptance, retained as real data assertions: a lost-reach turn still merges what the
  // model extracted (the new key joins, the stored key stays untouched), records the turn once, routes nothing, reads no definition.
  for (const loss of ['uninstall', 'revoked', 'expired', 'inactive'] as const) {
    it(`X: after ${loss} a valid extraction merges into the home's data and keeps what was there`, async () => {
      const home = await retainedHome(consumerCtx());
      await db.node.create({ data: { memoryId: home.memoryId, loc: 'data', name: 'data', nodeType: 'data', data: { kept: 'old' } } });
      await loseReach(loss);
      const msgs = await messages(home.memoryId, home.chatId);
      const history = await routeHistory(home.rootId);
      const seen = await observe<any>(consumerCtx, ctx => respond(ctx, home.chatId, null, { qaValue: 'new' }));
      expect(await homeData(home.memoryId)).toEqual({ kept: 'old', qaValue: 'new' });
      expect(await messages(home.memoryId, home.chatId)).toBe(msgs + 1);
      expect((await routeHistory(home.rootId)).slice(history.length).map((e: any) => e.action)).toEqual(['COMPLETED']);
      expect(seen.value).toMatchObject({ displayMessage: 'done', conversationHandoff: null, stageTransitioned: false });
      expect(seen.systemReads).toEqual([]);
      expect(seen.edgeReads).toBe(0);
    });
  }

  for (const loss of ['uninstall', 'revoked', 'expired', 'inactive'] as const) {
    it(`L: after ${loss} the response records the turn, routes nothing, reads no definition`, async () => {
      const home = await retainedHome(consumerCtx());
      await loseReach(loss);
      const msgs = await messages(home.memoryId, home.chatId);
      const history = await routeHistory(home.rootId);
      const seen = await observe<any>(consumerCtx, ctx => respond(ctx, home.chatId));
      expect(seen.value).toMatchObject({ displayMessage: 'done', stageTransitioned: false, newStageName: null, conversationHandoff: null, chatEnded: false });
      expect(await messages(home.memoryId, home.chatId), 'the assistant turn stays recorded exactly once').toBe(msgs + 1);
      // The model's own completion flag records COMPLETED/GOAL_REACHED (input-driven, #4036); no Agent-edge entry is added.
      const added = (await routeHistory(home.rootId)).slice(history.length);
      expect(added.map((e: any) => [e.action, e.trigger?.type]), 'only the input-driven completion entry, no edge-derived route entry').toEqual([['COMPLETED', 'GOAL_REACHED']]);
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
    const seen = await observe<any>(consumerCtx, ctx => respond(ctx, home.chatId));
    expect(seen.value.conversationHandoff).toBeNull();
    expect(seen.systemReads).toEqual([]);
    expect(seen.edgeReads).toBe(0);
  });

  it('D1: a soft-deleted Agent on an App-less home routes nothing and reads no definition', async () => {
    const home = await retainedHome(managerCtx());
    await db.agent.update({ where: { id: agentId }, data: { deletedAt: new Date() } });
    const msgs = await messages(home.memoryId, home.chatId);
    const seen = await observe<any>(managerCtx, ctx => respond(ctx, home.chatId));
    expect(seen.value.conversationHandoff).toBeNull();
    expect(await messages(home.memoryId, home.chatId)).toBe(msgs + 1);
    expect(seen.systemReads).toEqual([]);
    expect(seen.edgeReads).toBe(0);
  });

  it('E1: lost reach with an explicit next_stage reads no definition and does not throw', async () => {
    const home = await retainedHome(consumerCtx());
    await loseReach('revoked');
    const seen = await observe<any>(consumerCtx, ctx => respond(ctx, home.chatId, 'step'));
    expect(seen.value.conversationHandoff).toBeNull();
    expect(seen.systemReads).toEqual([]);
    expect(seen.edgeReads).toBe(0);
  });
});

describe('#4105 the knowledge-home shape', () => {
  it('K: a standalone knowledge home whose manager was demoted still merges a valid extraction, records once, routes nothing, reads no definition', async () => {
    // An Agent-org ADMIN who is a member of no App starts a lawful standalone (class knowledge, App-less) home.
    const loneId = (await db.user.create({ data: { handle: 'reach4105-lone-admin' } })).id;
    const agentOrgId = (await db.agent.findUniqueOrThrow({ where: { id: agentId } })).organizationId!;
    await db.orgMember.create({ data: { organizationId: agentOrgId, userId: loneId, role: 'ADMIN' } });
    const loneCtx = (): Context => ({ db, userId: loneId, roles: ['READER'] });
    const started = await M.startChat({}, { agentId, scope: 'private', conversationName: 'flow' }, loneCtx());
    const root = await chatNodeByLocOrThrow(db, started.chatId);
    const memory = await db.memory.findUniqueOrThrow({ where: { id: root.memoryId } });
    expect([memory.class, memory.appId], 'the knowledge-home shape').toEqual(['knowledge', null]);
    await db.node.create({ data: { memoryId: memory.id, loc: 'data', name: 'data', nodeType: 'data', data: { kept: 'old' } } });
    await db.orgMember.update({ where: { organizationId_userId: { organizationId: agentOrgId, userId: loneId } }, data: { role: 'READER' } });
    const msgs = await messages(memory.id, started.chatId);
    const history = await routeHistory(root.id);
    const seen = await observe<any>(loneCtx, ctx => respond(ctx, started.chatId, null, { qaValue: 'new' }));
    expect(await homeData(memory.id)).toEqual({ kept: 'old', qaValue: 'new' });
    expect(await messages(memory.id, started.chatId)).toBe(msgs + 1);
    expect((await routeHistory(root.id)).slice(history.length).map((e: any) => e.action)).toEqual(['COMPLETED']);
    expect(seen.value).toMatchObject({ displayMessage: 'done', conversationHandoff: null, stageTransitioned: false });
    expect(seen.systemReads).toEqual([]);
    expect(seen.edgeReads).toBe(0);
  });
});

describe('#4105 the production detach path', () => {
  for (const who of ['manager', 'consumer'] as const) {
    it(`D: after detachAppOwnerMemories (pointer cleared) the ${who}'s response records the turn, routes nothing and reads no definition`, async () => {
      const ctxOf = who === 'manager' ? managerCtx : consumerCtx;
      const home = await retainedHome(ctxOf(), { detach: 'production' });
      const memory = await db.memory.findUniqueOrThrow({ where: { id: home.memoryId } });
      expect([memory.appId, memory.userMemoryOfAgentId], 'the real path clears both scope columns').toEqual([null, null]);
      const msgs = await messages(home.memoryId, home.chatId);
      const seen = await observe<any>(ctxOf, ctx => respond(ctx, home.chatId));
      expect(seen.value).toMatchObject({ displayMessage: 'done', conversationHandoff: null, stageTransitioned: false });
      expect(await messages(home.memoryId, home.chatId)).toBe(msgs + 1);
      expect(seen.systemReads).toEqual([]);
      expect(seen.edgeReads).toBe(0);
    });
  }
});

describe('#4070 pinned revision', () => {
  it('lost reach on a chat pinned to a revision reads not even the revision node (the gate precedes loadChatScript)', async () => {
    const home = await retainedHome(consumerCtx());
    const root = await db.node.findUniqueOrThrow({ where: { id: home.rootId } });
    await db.node.update({ where: { id: home.rootId }, data: { data: { ...(root.data as object), startedWithRevision: 'revisions:r1' } } });
    await loseReach('revoked');
    const seen = await observe<any>(consumerCtx, ctx => respond(ctx, home.chatId));
    expect(seen.value.conversationHandoff).toBeNull();
    expect(seen.systemReads).toEqual([]);
  });
});

describe('#4070 controls', () => {
  it('P1: a consumer in the licensed App home fires the on-complete rule (observers see real reads)', async () => {
    // #4112: an unrelated licensed carrier no longer authorizes an App-less home; keep this positive control App-bearing.
    const home = await retainedHome(consumerCtx(), { keepApp: true });
    const seen = await observe<any>(consumerCtx, ctx => respond(ctx, home.chatId));
    expect(seen.value.conversationHandoff).toBe('next');
    expect(seen.systemReads.length).toBeGreaterThan(0);
    expect(seen.edgeReads).toBeGreaterThan(0);
  });

  it('P2: the Agent org ADMIN (not an App member of any usable carrier) keeps reach after the licence is gone', async () => {
    const home = await retainedHome(managerCtx());
    await loseReach('uninstall');
    const seen = await observe<any>(managerCtx, ctx => respond(ctx, home.chatId));
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
    const seen = await observe<any>(consumerCtx, ctx => errorOf(() => M.sendChatMessage({}, { chatId: home.chatId, userMessage: 'after loss' }, ctx)));
    expect(seen.value).toMatchObject({ code: 'AGENT_NOT_FOUND' });
    expect(seen.systemReads, 'no protected system read before the refusal').toEqual([]);
  });

  it('S1c: positive control for S1: with reach intact the same observer sees the pinned-revision read, so S1 cannot pass vacuously', async () => {
    const rev = await M.createRevision({}, { agentId }, managerCtx());
    await M.publishRevision({}, { agentId, revisionLoc: rev.revisionLoc }, managerCtx());
    const home = await retainedHome(managerCtx());
    const root = await db.node.findUniqueOrThrow({ where: { id: home.rootId } });
    expect((root.data as any).startedWithRevision).toBe(rev.revisionLoc);
    const seen = await observe<any>(managerCtx, ctx => M.sendChatMessage({}, { chatId: home.chatId, userMessage: 'still reachable' }, ctx));
    expect(seen.value.messageHistory.at(-1)).toMatchObject({ content: 'still reachable' });
    expect(seen.systemReads.length, 'the observer sees the pinned revision / definition reads').toBeGreaterThan(0);
  });

  it('H1: the helper judges manager reach through the db handle it was given, not caller.db (Gizelle P2)', async () => {
    const home = await retainedHome(managerCtx());
    const memory = await db.memory.findUniqueOrThrow({ where: { id: home.memoryId } });
    const agentRow = await db.agent.findUniqueOrThrow({ where: { id: agentId } });
    const hostile = new Proxy(db, { get: (_t, k) => { throw new Error('caller.db was read: ' + String(k)); } });
    const hostileCaller = { ...managerCtx(), db: hostile as any }; // (a Context still satisfies the narrow caller type)
    const out = await chatHomeAgentIfReachable(db, memory, agentRow, hostileCaller);
    expect(out?.id).toBe(agentId);
    await db.$transaction(async tx => {
      const ctx = { ...managerCtx(), db: hostile as any };
      expect((await chatHomeAgentIfReachable(tx, memory, agentRow, ctx))?.id).toBe(agentId);
      await tx.orgMember.update({where:{organizationId_userId:{organizationId:agentRow.organizationId!,userId:managerId}},data:{role:'READER'}});
      expect(await chatHomeAgentIfReachable(tx, memory, agentRow, ctx)).toBeNull();
    });
  });

  it('H2: the helper needs only the principal fields (no db, no Context): a caller with nothing but userId and roles judges the same', async () => {
    const home = await retainedHome(managerCtx());
    const memory = await db.memory.findUniqueOrThrow({ where: { id: home.memoryId } });
    const agentRow = await db.agent.findUniqueOrThrow({ where: { id: agentId } });
    expect((await chatHomeAgentIfReachable(db, memory, agentRow, { userId: managerId, roles: ['READER'] }))?.id).toBe(agentId);
    expect(await chatHomeAgentIfReachable(db, memory, agentRow, { userId: consumerId, roles: ['READER'] })).toBeNull();
  });

  it('B1: branch equivalence: an App-bearing home with a live licence admits the Agent with or without the caller, and loses it identically', async () => {
    const home = await retainedHome(consumerCtx(), { keepApp: true });
    const memory = await db.memory.findUniqueOrThrow({ where: { id: home.memoryId } });
    expect(memory.appId).toBe(appId);
    const agentRow = await db.agent.findUniqueOrThrow({ where: { id: agentId } });
    const caller = { userId: consumerId, roles: ['READER'] };
    expect((await chatHomeAgentIfReachable(db, memory, agentRow))?.id).toBe(agentId);
    expect((await chatHomeAgentIfReachable(db, memory, agentRow, caller))?.id).toBe(agentId);
    await loseReach('revoked');
    expect(await chatHomeAgentIfReachable(db, memory, agentRow)).toBeNull();
    expect(await chatHomeAgentIfReachable(db, memory, agentRow, caller)).toBeNull();
    // The caller never widens an App-bearing home: not even the Agent's own manager is admitted once the licence is gone (#4043).
    expect(await chatHomeAgentIfReachable(db, memory, agentRow, { userId: managerId, roles: ['READER'] })).toBeNull();
  });

  it('C1: another user answering on someone else\'s App-less home reads nothing and routes nothing', async () => {
    const home = await retainedHome(managerCtx());
    const msgs = await messages(home.memoryId, home.chatId);
    const history = await routeHistory(home.rootId);
    const seen = await observe<any>(consumerCtx, ctx => errorOf(() => respond(ctx, home.chatId)));
    expect(seen.systemReads).toEqual([]);
    expect(seen.edgeReads).toBe(0);
    expect(await messages(home.memoryId, home.chatId), 'the stranger\'s turn is not recorded into the owner\'s chat').toBe(msgs);
    expect(await routeHistory(home.rootId)).toEqual(history);
  });
});
