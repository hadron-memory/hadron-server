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
  const agent = await M.createAgent({}, { orgRef: org.id, name: 'Chat agent', visibility: 'ORGANIZATION' }, ctx());
  agentId = agent.id; systemId = agent.systemMemoryId;
  const app = await db.app.create({ data: {
    name: 'Chat app', urn: `${org.urn}:chat`, organizationId: org.id,
  } });
  appId = app.id;
  await db.appAgent.create({ data: { appId, agentId } });
  await db.appMember.create({ data: { appId, userId, role: 'member' } });
  for (const row of [
    { loc: 'conversations:flow', data: { stageOrder: ['step'], isSetup: false } },
    { loc: 'conversations:flow:step', data: { promptRef: 'prompts:step' } },
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
  const started = await M.startChat({}, { agentRef: agentId, scope, conversationName: 'flow', appRef: appId }, ctx());
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
/** #5394: a start that names no App is refused CHAT_APP_NOT_IDENTIFIED before any definition read or write. */
async function unidentifiedStartRefused() {
  const before = await state();
  const seen = await observeDefinitionReads(async () => {
    try { await M.startChat({}, { agentRef: agentId, conversationName: 'flow' }, ctx()); return null; }
    catch (error) { return error as any; }
  });
  expect(seen.value?.code).toBe('CHAT_APP_NOT_IDENTIFIED');
  expect(seen.systemReads).toEqual([]);
  expect(seen.edgeReads).toBe(0);
  expect(await state()).toBe(before);
}
/** #5394: a retained App-less home is never picked; the start runs in a home of the named App and leaves it untouched. */
async function startsBesideRetainedAppLessHome(retainedMemoryId: string, run: () => Promise<any> = () => start()) {
  const retained = JSON.stringify(await Promise.all([
    db.memory.findUniqueOrThrow({ where: { id: retainedMemoryId } }),
    db.node.findMany({ where: { memoryId: retainedMemoryId }, orderBy: { id: 'asc' } }),
  ]));
  const started = await run();
  expect(started.systemMessage).toContain('LICENSED STAGE');
  const home = (await chatNodeByLocOrThrow(db, started.chatId)).memoryId;
  expect(home).not.toBe(retainedMemoryId);
  expect((await db.memory.findUniqueOrThrow({ where: { id: home } })).appId).toBe(appId);
  expect(JSON.stringify(await Promise.all([
    db.memory.findUniqueOrThrow({ where: { id: retainedMemoryId } }),
    db.node.findMany({ where: { memoryId: retainedMemoryId }, orderBy: { id: 'asc' } }),
  ]))).toBe(retained);
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
// #5394: pinned a refusal when the start re-used the non-manager's retained app_id-null home. That home is never picked
// now: with no App named the start is refused CHAT_APP_NOT_IDENTIFIED before any read or write, and naming the App starts
// in a home of that App, leaving the retained App-less home untouched.
it('retained no-App non-manager refuses before definition reads', async () => {
  const started = await start();
  const root = await chatNodeByLocOrThrow(db, started.chatId);
  await db.memory.update({ where: { id: root.memoryId }, data: { appId: null } });
  await db.orgMember.updateMany({ where: { userId }, data: { role: 'READER' } });
  await unidentifiedStartRefused();
  await startsBesideRetainedAppLessHome(root.memoryId);
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
// #5394: pinned the Agent manager's direct route (with no installing App, a manager created and reused an app_id-null
// home). The route is retired: no App named is CHAT_APP_NOT_IDENTIFIED, and an App that does not install the Agent is
// the unknown-Agent refusal, both before any read or write.
it('an Agent manager with no App installing the Agent gets no direct home: refused with or without an App named, nothing provisioned', async () => {
  await db.appAgent.delete({ where: { appId_agentId: { appId, agentId } } });
  await unidentifiedStartRefused();
  await refusedStart();
  expect(await db.memory.count({ where: { userMemoryOfAgentId: agentId } })).toBe(0);
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
      // #5394: pinned the Agent manager's App-less route reaching the locked write. The route is retired: a manager
      // whose named App does not install the Agent is refused as an unknown Agent before any transaction, read or write.
      await unidentifiedStartRefused();
      const prior = await state();
      let transactions = 0;
      const refused = await observeDefinitionReads(async () => {
        try { await start(); return null; } catch (error) { return error as any; }
      }, async () => { transactions++; });
      expect(refused.value?.code).toBe('AGENT_NOT_FOUND');
      expect(transactions).toBe(0);
      expect(refused.systemReads).toEqual([]);
      expect(await state()).toBe(prior);
      return;
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
      await expect(M.startChat({}, { agentRef: agentId, conversationName: 'flow', appRef: appId }, ctx())).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND' });
      expect(changed).toBe(true); // The test reaches the locked write, not just the early guard.
      expect(await state()).toBe(before);
    } finally { spy.mockRestore(); }
  });
}

// #5394: pinned the user-owned Agent's owner re-using a retained app_id-null home. That home is never picked now: no
// App named is CHAT_APP_NOT_IDENTIFIED, and the org App does not license the user-owned Agent, so naming it is the
// unknown-Agent refusal; either way the retained home is untouched.
it('a retained App-less home is never picked, even for the user-owned Agent owner: refused with or without an App named', async () => {
  const first = await start();
  const root = await chatNodeByLocOrThrow(db, first.chatId);
  await db.memory.update({ where: { id: root.memoryId }, data: { appId: null } });
  await db.agent.update({ where: { id: agentId }, data: { organizationId: null, ownerUserId: userId } });
  await db.memory.update({ where: { id: systemId }, data: { organizationId: null, ownerUserId: userId } });
  await unidentifiedStartRefused();
  await refusedStart();
});
// #5394: pinned which platform claim could re-use a retained app_id-null home (stale: refused; live: served). That home
// is never picked now, so the platform role decides nothing here: with no App named both claims are CHAT_APP_NOT_IDENTIFIED,
// and naming the App starts each in a home of that App, the retained App-less home untouched.
it('a retained App-less home is never picked for a platform admin, live or stale: no App named is refused, naming the App starts beside it', async () => {
  const first = await start();
  const root = await chatNodeByLocOrThrow(db, first.chatId);
  await db.memory.update({ where: { id: root.memoryId }, data: { appId: null } });
  await db.orgMember.updateMany({ where: { userId }, data: { role: 'READER' } });
  const platformCtx = { ...ctx(), roles: ['ADMIN'] } as Context;
  await expect(M.startChat({}, { agentRef: agentId, conversationName: 'flow' }, platformCtx)).rejects.toMatchObject({ code: 'CHAT_APP_NOT_IDENTIFIED' });
  await startsBesideRetainedAppLessHome(root.memoryId, () => M.startChat({}, { agentRef: agentId, conversationName: 'flow', appRef: appId }, platformCtx));
  await db.user.update({ where: { id: userId }, data: { roles: ['ADMIN'] } });
  await expect(M.startChat({}, { agentRef: agentId, conversationName: 'flow' }, platformCtx)).rejects.toMatchObject({ code: 'CHAT_APP_NOT_IDENTIFIED' });
  await startsBesideRetainedAppLessHome(root.memoryId, () => M.startChat({}, { agentRef: agentId, conversationName: 'flow', appRef: appId }, platformCtx));
});

for (const route of ['app', 'manager'] as const) {
  it(`cold ${route} refusal at the locked write leaves no provisioned memory or parent`, async () => {
    if (route === 'manager') {
      await db.appAgent.delete({ where: { appId_agentId: { appId, agentId } } });
      await db.agent.update({ where: { id: agentId }, data: { visibility: 'PUBLIC' } });
      // #5394: pinned the Agent manager's App-less route reaching the locked write. The route is retired: a manager
      // whose named App does not install the Agent is refused as an unknown Agent before any transaction, read or write.
      await unidentifiedStartRefused();
      const prior = await state();
      let transactions = 0;
      const refused = await observeDefinitionReads(async () => {
        try { await start(); return null; } catch (error) { return error as any; }
      }, async () => { transactions++; });
      expect(refused.value?.code).toBe('AGENT_NOT_FOUND');
      expect(transactions).toBe(0);
      expect(refused.systemReads).toEqual([]);
      expect(await state()).toBe(prior);
      return;
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
      await expect(M.startChat({}, { agentRef: agentId, conversationName: 'flow', appRef: appId }, ctx())).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND' });
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
  expect((await M.startChat({}, { agentRef: agentId, conversationName: 'flow' }, keyCtx)).systemMessage).toContain('LICENSED STAGE');
  await db.memory.update({ where: { id: root.memoryId }, data: { appId: null } });
  const before = await state();
  const seen = await observeDefinitionReads(async () => {
    try { await M.startChat({}, { agentRef: agentId, conversationName: 'flow' }, keyCtx); return null; }
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
      try { await M.startChat({}, { agentRef: agentId, scope: 'shared', conversationName: 'flow', appRef: appId }, ctx()); return null; }
      catch (error) { return error as any; }
    });
    expect(changed).toBe(true);
    expect(seen.value?.code).toBe('AGENT_NOT_FOUND');
    expect(seen.systemReads).toEqual([]);
    expect(await state()).toBe(expectedState);
  } finally { spy.mockRestore(); }
});

/** The only uncommitted revoker holds this named authority domain in our private test database. */
async function assertHeldRefusal(anchor: { kind: 'app' | 'org' | 'user'; id: string }, revoke: (tx: any) => Promise<unknown>, scope: 'private' | 'shared' = 'private', viaCredential = false) {
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
    // viaCredential (#5394): the App is identified by the caller's credential (ctx.appId), which needs no participation.
    const args = viaCredential ? { agentRef: agentId, scope, conversationName: 'flow' } : { agentRef: agentId, scope, conversationName: 'flow', appRef: appId };
    try { await M.startChat({}, args, viaCredential ? { ...ctx(), appId } : ctx()); return null; }
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
/**
 * #5394: the three home-only anchor pins below held the retained home's App/org/owner domain and proved the start waited
 * on it before refusing. A start now names its App, and appRef resolves only among the Apps the caller takes part in, so a
 * caller who no longer takes part in the home's App is refused at once as an unknown Agent: before any anchor is read or
 * locked, so it never waits on the held domain, with no definition read and no write.
 */
async function assertImmediateRefusal(anchor: { kind: 'app' | 'org' | 'user'; id: string }, revoke: (tx: any) => Promise<unknown>) {
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
  try {
    const result = await observeDefinitionReads(async () => {
      try { await M.startChat({}, { agentRef: agentId, conversationName: 'flow', appRef: appId }, ctx()); return null; }
      catch (error) { return error as any; }
    });
    expect(result.value?.code).toBe('AGENT_NOT_FOUND');
    expect(result.systemReads).toEqual([]);
    expect(await state()).toBe(before);
  } finally { release(); await holder; }
}
async function retainedForeignHomeWithoutParticipation() {
  await foreignHome();
  await start();
  await db.appMember.deleteMany({ where: { appId, userId } });
  await db.orgMember.deleteMany({ where: { organizationId: foreignOrgId, userId } });
}
it('a retained home-only App with no participation left: the start is refused at once, not held behind an uninstall on the App anchor', async () => {
  await retainedForeignHomeWithoutParticipation();
  await assertImmediateRefusal({ kind: 'app', id: appId }, tx => tx.appAgent.delete({ where: { appId_agentId: { appId, agentId } } }));
}, 15_000);
it('a retained home-only App with no participation left: the start is refused at once, not held behind a tenant deletion on the App org anchor', async () => {
  await retainedForeignHomeWithoutParticipation();
  await assertImmediateRefusal({ kind: 'org', id: foreignOrgId }, tx => tx.organization.update({ where: { id: foreignOrgId }, data: { deletedAt: new Date() } }));
}, 15_000);
it('a retained home-only user App with no participation left: the start is refused at once, not held behind an owner licence revocation on the owner anchor', async () => {
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
  await assertImmediateRefusal({ kind: 'user', id: owner.id }, tx => tx.orgMember.update({ where: { organizationId_userId: { organizationId: agent.organizationId!, userId: owner.id } }, data: { deletedAt: new Date() } }));
}, 15_000);

// #5394 (Bindi BLIND P2 on #5407): the held variants of the three pins above. A credential naming the home's App
// identifies it without participation, so the non-participant reaches the retained home, and the start waits on the held
// App, org or owner domain before refusing, with no definition read and no write (the #4046 home-only anchor fences).
it('a credential-identified retained home-only App anchor fences uninstall when the caller has no App participation', async () => {
  await retainedForeignHomeWithoutParticipation();
  await assertHeldRefusal({ kind: 'app', id: appId }, tx => tx.appAgent.delete({ where: { appId_agentId: { appId, agentId } } }), 'private', true);
}, 15_000);
it('a credential-identified retained home-only App org anchor fences tenant deletion independently of the Agent org', async () => {
  await retainedForeignHomeWithoutParticipation();
  await assertHeldRefusal({ kind: 'org', id: foreignOrgId }, tx => tx.organization.update({ where: { id: foreignOrgId }, data: { deletedAt: new Date() } }), 'private', true);
}, 15_000);
it('a credential-identified retained home-only user-App owner anchor fences owner licence revocation independently of the caller', async () => {
  const agent = await db.agent.findUniqueOrThrow({ where: { id: agentId } });
  const owner = await db.user.create({ data: { handle: 'home4046-owner-cred' } });
  await db.orgMember.create({ data: { organizationId: agent.organizationId!, userId: owner.id, role: 'READER' } });
  await db.agentSubscription.create({ data: { userId: owner.id, agentId, activatedAt: new Date('2020-01-01') } });
  const app = await db.app.create({ data: { ownerUserId: owner.id, name: 'Owner licence cred', urn: '@home4046-owner-cred:app' } });
  await db.appAgent.delete({ where: { appId_agentId: { appId, agentId } } });
  appId = app.id;
  await db.appAgent.create({ data: { appId, agentId } });
  await db.appMember.create({ data: { appId, userId, role: 'member' } });
  await start();
  await db.appMember.delete({ where: { appId_userId: { appId, userId } } });
  await assertHeldRefusal({ kind: 'user', id: owner.id }, tx => tx.orgMember.update({ where: { organizationId_userId: { organizationId: agent.organizationId!, userId: owner.id } }, data: { deletedAt: new Date() } }), 'private', true);
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
    await expect(M.startChat({}, { agentRef: agentId, scope: 'shared', conversationName: 'flow', appRef: appId }, ctx())).rejects.toBe(original);
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
    await expect(M.startChat({}, { agentRef: agentId, conversationName: 'flow', appRef: appId }, ctx())).rejects.toBe(original);
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
    try { await M.startChat({}, { agentRef: agentId, conversationName: 'flow', aiConfigChoice: generateId(), appRef: appId }, ctx()); return null; }
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
    try { await M.startChat({}, { agentRef: agentId, conversationName: 'flow', appRef: appId }, ctx()); return null; }
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
