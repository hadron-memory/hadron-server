/** #4046: App-reached chat homes must not serve an uninstalled/unlicensed Agent's definition. */
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


/** Whole rows, including counters and existing data, must survive a refused start. */
async function state() {
  return JSON.stringify(await Promise.all([
    db.memory.findMany({ orderBy: { id: 'asc' } }),
    db.node.findMany({ orderBy: { id: 'asc' } }),
    db.agentSubscription.findMany({ orderBy: [{ userId: 'asc' }, { agentId: 'asc' }] }),
    db.servedPrompt.findMany({ orderBy: { id: 'asc' } }),
  ]));
}
async function refusedStart() {
  const before = await state();
  const seen = await observeDefinitionReads(async () => {
    let error: any;
    try { await start(); } catch (e) { error = e; }
    expect(error?.extensions?.code ?? error?.code).toBe('AGENT_NOT_FOUND');
  });
  expect(seen.systemReads).toEqual([]);
  expect(seen.edgeReads).toBe(0);
  expect(await state()).toBe(before);
}
for (const home of ['personal', 'knowledge'] as const) {
  for (const loss of ['uninstall', 'revoked', 'expired', 'inactive'] as const) {
    it(`retained ${home} refuses ${loss} before reads/writes, even for Agent manager`, async () => {
      await foreignHome();
      const started = await start();
      const root = await chatNodeByLocOrThrow(db, started.chatId);
      if (home === 'knowledge') await db.memory.update({ where: { id: root.memoryId }, data: { class: 'knowledge', userId: null, visibility: 'ORGANIZATION' } });
      await loseLicence(loss);
      await refusedStart();
    });
  }
}
it('pinned retained home refuses before loading the published revision', async () => {
  await foreignHome();
  await start();
  await db.node.create({ data: { memoryId: systemId, loc: 'revisions:test', name: 'snapshot', nodeType: 'data', data: { snapshot: { nodes: [] } } } });
  await db.agent.update({ where: { id: agentId }, data: { publishedRevisionLoc: 'revisions:test' } });
  await loseLicence('uninstall');
  await refusedStart();
});
for (const kind of ['READER', 'CONTRIBUTOR', 'PUBLIC'] as const) {
  it(`cold no-App ${kind} non-manager refuses before provisioning or reads`, async () => {
    await db.appAgent.delete({ where: { appId_agentId: { appId, agentId } } });
    if (kind === 'PUBLIC') {
      await db.orgMember.deleteMany({ where: { userId } });
      await db.agent.update({ where: { id: agentId }, data: { visibility: 'PUBLIC' } });
    } else await db.orgMember.updateMany({ where: { userId }, data: { role: kind } });
    await refusedStart();
  });
}
it('retained no-App non-manager refuses before definition reads', async () => {
  const started = await start();
  const root = await chatNodeByLocOrThrow(db, started.chatId);
  await db.memory.update({ where: { id: root.memoryId }, data: { appId: null } });
  await db.orgMember.updateMany({ where: { userId }, data: { role: 'READER' } });
  await refusedStart();
});
it('live licensed retained personal home still serves the real prompt', async () => {
  const first = await start();
  const seen = await observeDefinitionReads(() => start());
  expect(seen.value.systemMessage).toContain('LICENSED STAGE');
  expect(seen.systemReads.length).toBeGreaterThan(0);
  const a = await chatNodeByLocOrThrow(db, first.chatId);
  const b = await chatNodeByLocOrThrow(db, seen.value.chatId);
  expect(a.memoryId).toBe(b.memoryId);
});
it('no-App manager can still create and reuse a direct home', async () => {
  await db.appAgent.delete({ where: { appId_agentId: { appId, agentId } } });
  const a = await start();
  const b = await start();
  const root = await chatNodeByLocOrThrow(db, a.chatId);
  expect((await db.memory.findUniqueOrThrow({ where: { id: root.memoryId } })).appId).toBeNull();
  expect(b.systemMessage).toContain('LICENSED STAGE');
});
it('licensed non-manager App start remains admitted', async () => {
  await db.orgMember.updateMany({ where: { userId }, data: { role: 'READER' } });
  expect((await start()).systemMessage).toContain('LICENSED STAGE');
});

for (const route of ['app', 'manager'] as const) {
  it(`rechecks ${route} admission at the locked write after authority changes`, async () => {
    if (route === 'manager') {
      await db.appAgent.delete({ where: { appId_agentId: { appId, agentId } } });
      await db.agent.update({ where: { id: agentId }, data: { visibility: 'PUBLIC' } });
    }
    await start();
    const before = await state();
    const transaction = db.$transaction.bind(db) as (...args: any[]) => Promise<any>;
    let changed = false;
    const spy = vi.spyOn(db, '$transaction').mockImplementation((async (...args: any[]) => {
      if (!changed) {
        changed = true;
        if (route === 'app') await db.appAgent.delete({ where: { appId_agentId: { appId, agentId } } });
        else await db.orgMember.updateMany({ where: { userId }, data: { role: 'READER' } });
      }
      return transaction(...args);
    }) as any);
    try {
      await expect(M.startChat({}, { agentId, conversationName: 'flow' }, ctx())).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND' });
      expect(changed).toBe(true); // The test reaches the locked write, not just the early guard.
      expect(await state()).toBe(before);
    } finally { spy.mockRestore(); }
  });
}

it('retained App-less home admits the user-owned Agent owner', async () => {
  const first = await start();
  const root = await chatNodeByLocOrThrow(db, first.chatId);
  await db.memory.update({ where: { id: root.memoryId }, data: { appId: null } });
  await db.agent.update({ where: { id: agentId }, data: { organizationId: null, ownerUserId: userId } });
  await db.memory.update({ where: { id: systemId }, data: { organizationId: null, ownerUserId: userId } });
  expect((await start()).systemMessage).toContain('LICENSED STAGE');
});
it('live platform admin can use a retained App-less home; a stale platform claim cannot', async () => {
  const first = await start();
  const root = await chatNodeByLocOrThrow(db, first.chatId);
  await db.memory.update({ where: { id: root.memoryId }, data: { appId: null } });
  await db.orgMember.updateMany({ where: { userId }, data: { role: 'READER' } });
  const platformCtx = { ...ctx(), roles: ['ADMIN'] } as Context;
  await expect(M.startChat({}, { agentId, conversationName: 'flow' }, platformCtx)).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND' });
  await db.user.update({ where: { id: userId }, data: { roles: ['ADMIN'] } });
  expect((await M.startChat({}, { agentId, conversationName: 'flow' }, platformCtx)).systemMessage).toContain('LICENSED STAGE');
});
