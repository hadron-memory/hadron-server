/** #4046: App-reached chat homes must not serve an uninstalled/unlicensed Agent's definition. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { generateId } from '../../../lib/id.js';
import { lockAuthorityAnchors } from '../../../lib/auth/authorityAnchors.js';
import { waitForLockWaitersOfType } from '../../../test/lockWait.js';
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
async function observeDefinitionReads<T>(run: () => Promise<T>, beforeTransaction?: () => Promise<void>) {
  const first = vi.spyOn(db.node, 'findFirst');
  const many = vi.spyOn(db.node, 'findMany');
  const unique = vi.spyOn(db.node, 'findUnique');
  const uniqueOrThrow = vi.spyOn(db.node, 'findUniqueOrThrow');
  const firstOrThrow = vi.spyOn(db.node, 'findFirstOrThrow');
  const edges = vi.spyOn(db.edge, 'findMany');
  const transactionReads: any[] = [];
  let transactionEdges = 0;
  const transaction = db.$transaction.bind(db) as (...args: any[]) => Promise<any>;
  const wrap = (client: any) => new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'node' || prop === 'edge') return new Proxy(target[prop], {
        get(model, method, modelReceiver) {
          const value = Reflect.get(model, method, modelReceiver);
          if (typeof value !== 'function') return value;
          return (...args: any[]) => {
            if (prop === 'node' && ['findFirst', 'findMany', 'findUnique', 'findUniqueOrThrow', 'findFirstOrThrow'].includes(String(method))) transactionReads.push([args[0]]);
            if (prop === 'edge' && method === 'findMany') transactionEdges++;
            return value.apply(model, args);
          };
        },
      });
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const transactions = vi.spyOn(db, '$transaction').mockImplementation((async (first: any, ...rest: any[]) => {
    await beforeTransaction?.();
    return typeof first === 'function' ? transaction((tx: any) => first(wrap(tx)), ...rest) : transaction(first, ...rest);
  }) as any);
  try {
    const value = await run();
    const systemReads = [...first.mock.calls, ...many.mock.calls, ...unique.mock.calls,
      ...uniqueOrThrow.mock.calls, ...firstOrThrow.mock.calls, ...transactionReads].filter(([args]) => {
      const where = (args as any)?.where;
      const memory = where?.memoryId ?? where?.loc_memoryId?.memoryId;
      return memory === systemId || memory?.equals === systemId || memory?.in?.includes(systemId);
    });
    return { value, systemReads, edgeReads: edges.mock.calls.length + transactionEdges };
  } finally {
    transactions.mockRestore();
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

for (const route of ['app', 'manager'] as const) {
  it(`cold ${route} refusal at the locked write leaves no provisioned memory or parent`, async () => {
    if (route === 'manager') {
      await db.appAgent.delete({ where: { appId_agentId: { appId, agentId } } });
      await db.agent.update({ where: { id: agentId }, data: { visibility: 'PUBLIC' } });
    }
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
      expect(changed).toBe(true);
      expect(await state()).toBe(before);
    } finally { spy.mockRestore(); }
  });
}

it('cold AppMember outside the Agent org starts in that live licensed App', async () => {
  await db.orgMember.deleteMany({ where: { userId } });
  const started = await start();
  const root = await chatNodeByLocOrThrow(db, started.chatId);
  expect((await db.memory.findUniqueOrThrow({ where: { id: root.memoryId } })).appId).toBe(appId);
});
it('an org READER without App membership is not an App participant', async () => {
  await db.orgMember.updateMany({ where: { userId }, data: { role: 'READER' } });
  await db.appMember.deleteMany({ where: { userId } });
  await refusedStart();
});
it('an org CONTRIBUTOR without an AppMember row uses the licensed org App', async () => {
  await db.orgMember.updateMany({ where: { userId }, data: { role: 'CONTRIBUTOR' } });
  await db.appMember.deleteMany({ where: { userId } });
  const started = await start();
  const root = await chatNodeByLocOrThrow(db, started.chatId);
  expect((await db.memory.findUniqueOrThrow({ where: { id: root.memoryId } })).appId).toBe(appId);
});

it.each(['private', 'shared'] as const)('cold and warm %s starts use the real licensed home App', async scope => {
  const first = await start(scope);
  const second = await start(scope);
  const a = await chatNodeByLocOrThrow(db, first.chatId);
  const b = await chatNodeByLocOrThrow(db, second.chatId);
  expect(a.memoryId).toBe(b.memoryId);
  expect((await db.memory.findUniqueOrThrow({ where: { id: a.memoryId } })).appId).toBe(appId);
});
it('a bound App-key session starts only in its licensed home', async () => {
  const first = await start();
  const root = await chatNodeByLocOrThrow(db, first.chatId);
  const session = await db.session.create({ data: { id: generateId(), appId, agentId, userId, memoryId: root.memoryId, tool: 'vitest' } });
  const keyCtx: Context = { db, appId, sessionId: session.id, roles: [] };
  expect((await M.startChat({}, { agentId, conversationName: 'flow' }, keyCtx)).systemMessage).toContain('LICENSED STAGE');
  await db.memory.update({ where: { id: root.memoryId }, data: { appId: null } });
  const before = await state();
  const seen = await observeDefinitionReads(async () => {
    try { await M.startChat({}, { agentId, conversationName: 'flow' }, keyCtx); return null; }
    catch (error) { return error; }
  });
  expect(seen.value).toBeTruthy();
  expect(seen.systemReads).toEqual([]);
  expect(await state()).toBe(before);
});
it('two cold shared starts recover a real pairing collision inside the outer transaction', async () => {
  const starts = await Promise.all([start('shared'), start('shared')]);
  const roots = await Promise.all(starts.map(s => chatNodeByLocOrThrow(db, s.chatId)));
  expect(roots[0].id).not.toBe(roots[1].id);
  expect(roots[0].memoryId).toBe(roots[1].memoryId);
  expect(await db.memory.count({ where: { appId, sharedMemoryOfAgentId: agentId } })).toBe(1);
});

it('shared admission stays on the selected App if the located home moves before App derivation', async () => {
  const initial = await start('shared');
  const root = await chatNodeByLocOrThrow(db, initial.chatId);
  const app = await db.app.findUniqueOrThrow({ where: { id: appId } });
  const other = await db.app.create({ data: { name: 'Other installed App', urn: `${app.urn}-other`, organizationId: app.organizationId } });
  await db.appAgent.create({ data: { appId: other.id, agentId } });
  const find = db.memory.findUnique.bind(db.memory);
  let changed = false;
  let expectedState: string | undefined;
  const spy = vi.spyOn(db.memory, 'findUnique').mockImplementation((async (args: any) => {
    if (!changed && args.where?.id === root.memoryId && args.select?.appId === true) {
      changed = true;
      await db.memory.update({ where: { id: root.memoryId }, data: { appId: other.id } });
      await db.appAgent.delete({ where: { appId_agentId: { appId, agentId } } });
      expectedState = await state();
    }
    return find(args);
  }) as any);
  try {
    const seen = await observeDefinitionReads(async () => {
      try { await M.startChat({}, { agentId, scope: 'shared', conversationName: 'flow' }, ctx()); return null; }
      catch (error) { return error as any; }
    });
    expect(changed).toBe(true);
    expect(seen.value?.code).toBe('AGENT_NOT_FOUND');
    expect(seen.systemReads).toEqual([]);
    expect(await state()).toBe(expectedState);
  } finally { spy.mockRestore(); }
});

/** The only uncommitted revoker holds this named authority domain in our private test database. */
async function assertHeldRefusal(anchor: { kind: 'app' | 'org' | 'user'; id: string }, revoke: (tx: any) => Promise<unknown>, scope: 'private' | 'shared' = 'private') {
  const before = await state();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let held!: () => void;
  const ready = new Promise<void>(resolve => { held = resolve; });
  const holder = db.$transaction(async tx => {
    await lockAuthorityAnchors(tx, [anchor], 'exclusive');
    await revoke(tx);
    held();
    await gate;
  }, { timeout: 20_000 });
  await ready;
  let completed = false;
  const request = observeDefinitionReads(async () => {
    try { await M.startChat({}, { agentId, scope, conversationName: 'flow' }, ctx()); return null; }
    catch (error) { return error as any; }
  }).then(result => { completed = true; return result; });
  try {
    await waitForLockWaitersOfType(db, 'advisory', 1);
    expect(completed).toBe(false);
    expect(await state()).toBe(before);
  } finally { release(); await holder; await request; }
  const result = await request;
  expect(result.value).toBeTruthy();
  expect(result.systemReads).toEqual([]);
  expect(await state()).toBe(before);
}
async function retainedForeignHomeWithoutParticipation() {
  await foreignHome();
  await start();
  await db.appMember.deleteMany({ where: { appId, userId } });
  await db.orgMember.deleteMany({ where: { organizationId: foreignOrgId, userId } });
}
it('a home-only App anchor fences uninstall even when the Agent manager has no App participation', async () => {
  await retainedForeignHomeWithoutParticipation();
  await assertHeldRefusal({ kind: 'app', id: appId }, tx => tx.appAgent.delete({ where: { appId_agentId: { appId, agentId } } }));
}, 15_000);
it('a home-only App org anchor fences tenant deletion independently of the Agent org', async () => {
  await retainedForeignHomeWithoutParticipation();
  await assertHeldRefusal({ kind: 'org', id: foreignOrgId }, tx => tx.organization.update({ where: { id: foreignOrgId }, data: { deletedAt: new Date() } }));
}, 15_000);
it('a home-only user-App owner anchor fences owner licence revocation independently of the caller', async () => {
  const agent = await db.agent.findUniqueOrThrow({ where: { id: agentId } });
  const owner = await db.user.create({ data: { handle: 'home4046-owner' } });
  await db.orgMember.create({ data: { organizationId: agent.organizationId!, userId: owner.id, role: 'READER' } });
  await db.agentSubscription.create({ data: { userId: owner.id, agentId, activatedAt: new Date('2020-01-01') } });
  const app = await db.app.create({ data: { ownerUserId: owner.id, name: 'Owner licence', urn: '@home4046-owner:app' } });
  await db.appAgent.delete({ where: { appId_agentId: { appId, agentId } } });
  appId = app.id;
  await db.appAgent.create({ data: { appId, agentId } });
  await db.appMember.create({ data: { appId, userId, role: 'member' } });
  await start();
  await db.appMember.delete({ where: { appId_userId: { appId, userId } } });
  await assertHeldRefusal({ kind: 'user', id: owner.id }, tx => tx.orgMember.update({ where: { organizationId_userId: { organizationId: agent.organizationId!, userId: owner.id } }, data: { deletedAt: new Date() } }));
}, 15_000);

it('shared provisioning recovers an actual unique collision without poisoning the outer transaction', async () => {
  const transaction = db.$transaction.bind(db) as (...args: any[]) => Promise<any>;
  let collided = false;
  const spy = vi.spyOn(db, '$transaction').mockImplementation(((work: any, ...options: any[]) => transaction(async (tx: any) => {
    const memory = new Proxy(tx.memory, { get(target, prop, receiver) {
      if (prop === 'create') return async (args: any) => {
        if (!collided && args.data?.class === 'app') {
          collided = true;
          await db.memory.create({ ...args, data: { ...args.data, id: generateId() } });
        }
        return target.create(args); // Real P2002, then the shared helper must recover its savepoint.
      };
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    return work(new Proxy(tx, { get(target, prop, receiver) {
      if (prop === 'memory') return memory;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    } }));
  }, ...options)) as any);
  try {
    expect((await start('shared')).systemMessage).toContain('LICENSED STAGE');
    expect(collided).toBe(true);
    expect(await db.memory.count({ where: { appId, sharedMemoryOfAgentId: agentId } })).toBe(1);
  } finally { spy.mockRestore(); }
});

it('failed savepoint recovery preserves the original provisioning error', async () => {
  const transaction = db.$transaction.bind(db) as (...args: any[]) => Promise<any>;
  const original = new Error('original provisioning connection error');
  const secondary = new Error('secondary rollback error');
  const before = await state();
  let reached = false;
  const spy = vi.spyOn(db, '$transaction').mockImplementation(((work: any, ...options: any[]) => transaction(async (tx: any) => {
    const memory = new Proxy(tx.memory, { get(target, prop, receiver) {
      if (prop === 'create') return (args: any) => {
        if (args.data?.class === 'app') { reached = true; throw original; }
        return target.create(args);
      };
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    return work(new Proxy(tx, { get(target, prop, receiver) {
      if (prop === 'memory') return memory;
      if (prop === '$executeRawUnsafe') return (query: string, ...params: any[]) => {
        if (query === 'ROLLBACK TO SAVEPOINT shared_chat_memory_create') throw secondary;
        return target.$executeRawUnsafe(query, ...params);
      };
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    } }));
  }, ...options)) as any);
  try {
    await expect(M.startChat({}, { agentId, scope: 'shared', conversationName: 'flow' }, ctx())).rejects.toBe(original);
    expect(reached).toBe(true);
    expect(await state()).toBe(before);
  } finally { spy.mockRestore(); }
});

it('a cold start rolls back its home when parent creation fails after provisioning', async () => {
  const transaction = db.$transaction.bind(db) as (...args: any[]) => Promise<any>;
  const original = new Error('late parent failure');
  const before = await state();
  let reached = false;
  const spy = vi.spyOn(db, '$transaction').mockImplementation(((work: any, ...options: any[]) => transaction(async (tx: any) => {
    const node = new Proxy(tx.node, { get(target, prop, receiver) {
      if (prop === 'upsert') return (args: any) => {
        if (args.where?.loc_memoryId?.loc === 'chats') { reached = true; throw original; }
        return target.upsert(args);
      };
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    return work(new Proxy(tx, { get(target, prop, receiver) {
      if (prop === 'node') return node;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    } }));
  }, ...options)) as any);
  try {
    await expect(M.startChat({}, { agentId, conversationName: 'flow' }, ctx())).rejects.toBe(original);
    expect(reached).toBe(true);
    expect(await state()).toBe(before);
  } finally { spy.mockRestore(); }
});

for (const scope of ['private', 'shared'] as const) {
  it(`a cold ${scope} PUBLIC start cannot retain App membership that is revoked before the locked check`, async () => {
    await db.orgMember.deleteMany({ where: { userId } });
    await db.agent.update({ where: { id: agentId }, data: { visibility: 'PUBLIC' } });
    await assertHeldRefusal({ kind: 'app', id: appId }, tx => tx.appMember.delete({ where: { appId_userId: { appId, userId } } }), scope);
  });
}
it('a cold org-participant start rechecks CONTRIBUTOR after the org anchor wait', async () => {
  const agent = await db.agent.findUniqueOrThrow({ where: { id: agentId } });
  await db.orgMember.updateMany({ where: { userId }, data: { role: 'CONTRIBUTOR' } });
  await db.appMember.deleteMany({ where: { userId } });
  await assertHeldRefusal({ kind: 'org', id: agent.organizationId! }, tx => tx.orgMember.updateMany({ where: { userId }, data: { role: 'READER' } }));
});

it('an ineligible App-less start keeps the unknown-Agent answer even with an invalid config choice', async () => {
  await db.appAgent.delete({ where: { appId_agentId: { appId, agentId } } });
  await db.orgMember.updateMany({ where: { userId }, data: { role: 'READER' } });
  const before = await state();
  const result = await observeDefinitionReads(async () => {
    try { await M.startChat({}, { agentId, conversationName: 'flow', aiConfigChoice: generateId() }, ctx()); return null; }
    catch (error) { return error as any; }
  });
  expect(result.value?.code).toBe('AGENT_NOT_FOUND');
  expect(result.systemReads).toEqual([]);
  expect(await state()).toBe(before);
});

it('a replaced system pointer cannot read the old definition at locked admission', async () => {
  await start();
  const before = await state();
  let changed = false;
  const result = await observeDefinitionReads(async () => {
    try { await M.startChat({}, { agentId, conversationName: 'flow' }, ctx()); return null; }
    catch (error) { return error as any; }
  }, async () => {
    if (!changed) {
      changed = true;
      await db.agent.update({ where: { id: agentId }, data: { systemMemoryId: null } });
    }
  });
  expect(changed).toBe(true);
  expect(result.value?.code).toBe('AGENT_NOT_FOUND');
  expect(result.systemReads).toEqual([]);
  expect(await state()).toBe(before);
});

it('parent ensure recovers a real loc-memory collision without aborting the chat transaction', async () => {
  const prior = await start();
  const home = (await chatNodeByLocOrThrow(db, prior.chatId)).memoryId;
  await db.node.delete({ where: { loc_memoryId: { memoryId: home, loc: 'chats' } } });
  const transaction = db.$transaction.bind(db) as (...args: any[]) => Promise<any>;
  let collided = false;
  const spy = vi.spyOn(db, '$transaction').mockImplementation(((work: any, ...options: any[]) => transaction(async (tx: any) => {
    const node = new Proxy(tx.node, { get(target, prop, receiver) {
      if (prop === 'upsert') return async (args: any) => {
        if (!collided && args.where?.loc_memoryId?.loc === 'chats') {
          collided = true;
          // Model a writer winning after an emulated upsert's cold lookup. The
          // following INSERT creates a real P2002 inside the guarded savepoint.
          await db.node.create({ data: { ...args.create, id: generateId() } });
          return target.create({ data: args.create });
        }
        return target.upsert(args);
      };
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    return work(new Proxy(tx, { get(target, prop, receiver) {
      if (prop === 'node') return node;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    } }));
  }, ...options)) as any);
  try {
    expect((await start()).systemMessage).toContain('LICENSED STAGE');
    expect(collided).toBe(true);
    expect(await db.node.count({ where: { memoryId: home, loc: 'chats' } })).toBe(1);
  } finally { spy.mockRestore(); }
});
