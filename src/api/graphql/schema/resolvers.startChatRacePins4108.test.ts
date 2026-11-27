/**
 * #4108: race pins for startChat's selected-owner retry, the retained home's authority fence, the home App checks and the
 * parent-ensure catch, written against #4095's merged implementation (resolvers.mutation.chat.ts).
 *
 * Law (Vera's scoped FIT, #4108): cor:acl:010:01 (a definition read only through route A, the home's App with the Agent
 * installed and licensed, or route M, the Agent's manager), cor:dmo:050:13 (route M only for a home with no App) and
 * cor:dmo:050:22 (the licence is checked at every read and serve). The mechanics (authority domains, advisory locks,
 * abort-and-retry, wait-then-rejudge) and the refusal shape (AGENT_NOT_FOUND before any write) are #4095's / the #4046
 * gate's, not corpus law; they are pinned as built.
 *
 * 1. The selected App's owner changes after anchor discovery: the stale attempt aborts and the retry waits on the NEW
 *    owner's authority domain (a real advisory wait) before any definition read or write, then a licensed start succeeds.
 * 2. A retained home is transferred, or deleted, while another transaction holds its memory authority domain: the start waits
 *    on that domain, then refuses against the committed state with no definition read and no start write.
 * 3. A retained private home is detached from its App (starter does not manage the Agent) or attached to another App with no
 *    licensed install, between selection and locked admission: unknown-Agent refusal, no definition read, no start write.
 * 4. The parent-ensure savepoint's failed recovery propagates the ORIGINAL deciding error, not the rollback's.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { lockAuthorityAnchors } from '../../../lib/auth/authorityAnchors.js';
import { waitForLockWaitersOfType } from '../../../test/lockWait.js';
import { cleanDb, chatNodeByLocOrThrow } from '../../../test/helpers.js';
import { serveEveryAgent } from '../../../test/servedBootPrompt.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as any;
let userId: string, appId: string, agentId: string, systemId: string, agentOrgId: string;
const ctx = (): Context => ({ db, userId, roles: ['READER'] });
/** The unspied transaction, for the test's own external writers. */
const realTransaction = db.$transaction.bind(db) as (...args: any[]) => Promise<any>;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'Chat race', urn: 'chat4108.test' } });
  agentOrgId = org.id;
  const user = await db.user.create({ data: { handle: 'chat4108-caller' } });
  userId = user.id;
  await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgRef: org.id, name: 'Race agent', visibility: 'ORGANIZATION' }, ctx());
  agentId = agent.id; systemId = agent.systemMemoryId;
  appId = (await db.app.create({ data: { name: 'Race app', urn: `${org.urn}:chat`, organizationId: org.id } })).id;
  await db.appAgent.create({ data: { appId, agentId } });
  await db.appMember.create({ data: { appId, userId, role: 'member' } });
  for (const row of [
    { loc: 'conversations:flow', data: { stageOrder: ['step'], isSetup: false } },
    { loc: 'conversations:flow:step', data: { promptRef: 'prompts:step' } },
    { loc: 'prompts:step', content: 'LICENSED STAGE', data: {} },
  ]) await db.node.create({ data: { memoryId: systemId, name: row.loc, nodeType: 'system', ...row } });
  await serveEveryAgent(db);
});

const startChat = (scope: 'private' | 'shared' = 'private') => M.startChat({}, { agentRef: agentId, conversationName: 'flow', scope, appRef: appId }, ctx());

/** Whole rows a start may write: nodes (chat, parents), subscriptions and served records. Memory rows are compared separately. */
async function startWrites() {
  return JSON.stringify(await Promise.all([
    db.node.findMany({ orderBy: { id: 'asc' } }),
    db.agentSubscription.findMany({ orderBy: [{ userId: 'asc' }, { agentId: 'asc' }] }),
    db.servedPrompt.findMany({ orderBy: { id: 'asc' } }),
  ]));
}
async function memories() { return JSON.stringify(await db.memory.findMany({ orderBy: { id: 'asc' } })); }

/**
 * Like #4046's observer, but the definition reads are visible WHILE the start runs (`seen.systemReads()`), so a pin can
 * assert none happened before a lock was released. Every transaction the start opens is wrapped; `beforeTransaction` runs
 * before each one (the window between anchor discovery and the locked admission).
 */
function observeStart(beforeTransaction?: () => Promise<void>) {
  const reads: unknown[] = [];
  const isSystem = (args: any) => {
    const memory = args?.where?.memoryId ?? args?.where?.loc_memoryId?.memoryId;
    return memory === systemId || memory?.equals === systemId || memory?.in?.includes(systemId);
  };
  const methods = ['findFirst', 'findMany', 'findUnique', 'findUniqueOrThrow', 'findFirstOrThrow'];
  const spies = methods.map((m) => {
    const orig = (db.node as any)[m].bind(db.node);
    return vi.spyOn(db.node as any, m).mockImplementation(((args: any) => {
      if (isSystem(args)) reads.push(args);
      return orig(args);
    }) as any);
  });
  const wrap = (client: any) => new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'node' || prop === 'edge') return new Proxy(target[prop], {
        get(model, method, modelReceiver) {
          const value = Reflect.get(model, method, modelReceiver);
          if (typeof value !== 'function') return value;
          return (...args: any[]) => {
            if (prop === 'node' && methods.includes(String(method)) && isSystem(args[0])) reads.push(args[0]);
            if (prop === 'edge' && method === 'findMany') reads.push(args[0]);
            return value.apply(model, args);
          };
        },
      });
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const tx = vi.spyOn(db, '$transaction').mockImplementation((async (first: any, ...rest: any[]) => {
    await beforeTransaction?.();
    return typeof first === 'function' ? realTransaction((t: any) => first(wrap(t)), ...rest) : realTransaction(first, ...rest);
  }) as any);
  const restore = () => { tx.mockRestore(); for (const s of spies) s.mockRestore(); };
  return { systemReads: () => reads.length, restore };
}

/** An external writer that holds `anchors` exclusively (after running `change`) until released. Always released by the caller. */
async function holdAnchors(anchors: Array<{ kind: 'app' | 'org' | 'user' | 'memory'; id: string }>, change: (tx: any) => Promise<unknown> = async () => {}) {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let held!: () => void;
  const ready = new Promise<void>((r) => { held = r; });
  const done = realTransaction(async (tx: any) => {
    await lockAuthorityAnchors(tx, anchors, 'exclusive');
    await change(tx);
    held();
    await gate;
  }, { timeout: 20_000 });
  await Promise.race([ready, done]);
  return { release: async () => { release(); await done; } };
}

async function settle(p: Promise<any>): Promise<{ ok: true; value: any } | { ok: false; error: any }> {
  try { return { ok: true, value: await p }; } catch (error) { return { ok: false, error }; }
}

describe('#4108 item 1: the selected App owner changes after anchor discovery', () => {
  it('aborts the stale attempt and waits on the NEW owner domain before reading or writing; the licensed start then succeeds', async () => {
    // A user-owned home App, licensed through its owner (owner subscription + owner reads the Agent org). Two owners, both licensed.
    const owners = [];
    for (const handle of ['chat4108-owner-a', 'chat4108-owner-b']) {
      const owner = await db.user.create({ data: { handle } });
      await db.orgMember.create({ data: { organizationId: agentOrgId, userId: owner.id, role: 'READER' } });
      await db.agentSubscription.create({ data: { userId: owner.id, agentId, activatedAt: new Date('2020-01-01') } });
      owners.push(owner.id);
    }
    const [ownerA, ownerB] = owners;
    await db.appAgent.delete({ where: { appId_agentId: { appId, agentId } } });
    appId = (await db.app.create({ data: { ownerUserId: ownerA, name: 'Owned home', urn: '@chat4108-owner-a:home' } })).id;
    await db.appAgent.create({ data: { appId, agentId } });
    await db.appMember.create({ data: { appId, userId, role: 'member' } });
    const first = await startChat();
    const home = (await chatNodeByLocOrThrow(db, first.chatId)).memoryId;
    expect((await db.memory.findUniqueOrThrow({ where: { id: home } })).appId).toBe(appId);
    // Not a participant: the home App is not a carrier, so only the selected-App completeness check sees its owner.
    // #5394: a named appRef resolves only among the Apps the caller takes part in, so the racing start identifies the
    // App through its credential (ctx.appId), which needs no participation, and reuses the existing home.
    await db.appMember.delete({ where: { appId_userId: { appId, userId } } });

    let holder: Awaited<ReturnType<typeof holdAnchors>> | null = null;
    let transactions = 0;
    const seen = observeStart(async () => {
      if (++transactions !== 1) return;
      // After the first attempt read owner A as its anchor, before its locked admission: the App changes hands, and
      // another writer holds the new owner's domain.
      await db.app.update({ where: { id: appId }, data: { ownerUserId: ownerB } });
      holder = await holdAnchors([{ kind: 'user', id: ownerB }]);
    });
    let completed = false;
    const credentialStart = () => M.startChat({}, { agentRef: agentId, conversationName: 'flow' }, { ...ctx(), appId });
    const run = settle(credentialStart()).then((r) => { completed = true; return r; });
    try {
      const writesBefore = await startWrites();
      await waitForLockWaitersOfType(db, 'advisory', 1);
      expect(transactions).toBe(2); // the stale attempt aborted and a second attempt is the one waiting
      expect(completed).toBe(false);
      expect(seen.systemReads()).toBe(0);
      expect(await startWrites()).toBe(writesBefore);
    } finally {
      await (holder as any)?.release();
      await run;
      seen.restore();
    }
    const result = await run;
    expect(result.ok, String(!result.ok && result.error)).toBe(true);
    if (result.ok) expect(result.value.systemMessage).toContain('LICENSED STAGE');
    expect(seen.systemReads()).toBeGreaterThan(0);
  }, 20_000);
});

describe('#4108 item 2: the retained home\'s memory authority domain', () => {
  for (const change of ['transferred', 'deleted'] as const) {
    it(`waits while another writer holds the home domain, then refuses the ${change} home without reads or writes`, async () => {
      const first = await startChat();
      const home = (await chatNodeByLocOrThrow(db, first.chatId)).memoryId;
      // The transfer target is an App with no licensed install of the Agent.
      const other = (await db.app.create({ data: { name: 'No install', urn: 'chat4108.test:other', organizationId: agentOrgId } })).id;
      const writesBefore = await startWrites();
      const holder = await holdAnchors([{ kind: 'memory', id: home }], (tx) => tx.memory.update({
        where: { id: home }, data: change === 'transferred' ? { appId: other } : { deletedAt: new Date() },
      }));
      const memoriesHeld = await memories(); // the change is not committed yet, so this is the pre-change state
      const seen = observeStart();
      let completed = false;
      const run = settle(startChat()).then((r) => { completed = true; return r; });
      try {
        await waitForLockWaitersOfType(db, 'advisory', 1);
        expect(completed).toBe(false);
        expect(seen.systemReads()).toBe(0);
        expect(await startWrites()).toBe(writesBefore);
        expect(await memories()).toBe(memoriesHeld);
      } finally {
        await holder.release();
        await run;
        seen.restore();
      }
      const result = await run;
      expect(result.ok).toBe(false);
      // As built: a transferred home is rejudged by the locked admission's home-App check (unknown Agent); a deleted home is
      // refused by the shared memory-anchor liveness re-read after the wait (authorizedTx.ts, Forbidden).
      if (!result.ok) expect(result.error?.extensions?.code ?? result.error?.code).toBe(change === 'transferred' ? 'AGENT_NOT_FOUND' : 'FORBIDDEN');
      expect(seen.systemReads()).toBe(0);
      expect(await startWrites()).toBe(writesBefore);
      // Only the external writer's own committed change is in the memories.
      const row = await db.memory.findUniqueOrThrow({ where: { id: home } });
      if (change === 'transferred') expect(row.appId).toBe(other); else expect(row.deletedAt).not.toBeNull();
      expect(await db.memory.count()).toBe(JSON.parse(memoriesHeld).length);
    }, 20_000);
  }
});

describe('#4108 item 3: the home App between selection and locked admission', () => {
  for (const move of ['detached', 'attached elsewhere'] as const) {
    it(`a retained private home ${move} refuses as an unknown Agent, with no reads or writes`, async () => {
      const first = await startChat();
      const home = (await chatNodeByLocOrThrow(db, first.chatId)).memoryId;
      // Both routes removed (FIT constraint): the starter does not manage the Agent (READER), and the other App has no
      // licensed install of it.
      await db.orgMember.updateMany({ where: { userId }, data: { role: 'READER' } });
      const other = (await db.app.create({ data: { name: 'No install', urn: 'chat4108.test:elsewhere', organizationId: agentOrgId } })).id;
      await db.appMember.create({ data: { appId: other, userId, role: 'member' } });
      expect((await startChat()).systemMessage).toContain('LICENSED STAGE'); // the licensed control, same starter
      const writesBefore = await startWrites();
      let expectedMemories: string | undefined;
      let changed = false;
      const seen = observeStart(async () => {
        if (changed) return;
        changed = true;
        await db.memory.update({ where: { id: home }, data: { appId: move === 'detached' ? null : other } });
        expectedMemories = await memories();
      });
      const result = await settle(startChat());
      seen.restore();
      expect(changed).toBe(true);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error?.extensions?.code ?? result.error?.code).toBe('AGENT_NOT_FOUND');
      expect(seen.systemReads()).toBe(0);
      expect(await startWrites()).toBe(writesBefore);
      expect(await memories()).toBe(expectedMemories);
    });
  }
});

describe('#4108 item 4: the parent-ensure catch', () => {
  it('a failed savepoint recovery propagates the original deciding error, not the rollback error', async () => {
    const original = new Error('original parent ensure error');
    const secondary = new Error('secondary parent rollback error');
    const writesBefore = await startWrites();
    const memoriesBefore = await memories();
    let reached = false;
    let rolledBack = false;
    const spy = vi.spyOn(db, '$transaction').mockImplementation(((work: any, ...options: any[]) => realTransaction(async (tx: any) => {
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
        if (prop === '$executeRawUnsafe') return (query: string, ...params: any[]) => {
          if (query === 'ROLLBACK TO SAVEPOINT start_chat_parent') { rolledBack = true; throw secondary; }
          return target.$executeRawUnsafe(query, ...params);
        };
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      } }));
    }, ...options)) as any);
    try {
      await expect(startChat()).rejects.toBe(original);
      expect(reached).toBe(true);
      expect(rolledBack).toBe(true); // the failed-recovery branch itself was reached
      expect(await startWrites()).toBe(writesBefore);
      expect(await memories()).toBe(memoriesBefore);
    } finally { spy.mockRestore(); }
  });
});
