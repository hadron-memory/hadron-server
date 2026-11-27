/**
 * #5027 (hrn:node:hadronmemory.com:specs:cor:acl:030:01, D-2026-11-26-008): a chat's home is named by memory
 * (`startChat(memoryRef:)`), and the default comes from the Agent (`Agent.defaultChatHome`). Pins (a)-(h) of the issue,
 * red first on main 26b435a6:
 *   - (a) a chat started with memoryRef in each of the four hosts lives in that memory and reads back its class and URN, with the
 *     derived scope label (red: no memoryRef argument, no homeMemoryClass/homeMemoryUrn);
 *   - (b) memoryRef with a contradicting scope is BAD_USER_INPUT and writes nothing (red: memoryRef is ignored);
 *   - (c) the Agent default picks the home; a null default is byte-identical to today (red: no defaultChatHome);
 *   - (d) every CHAT_HOME_INVALID case answers the same full error and provisions nothing (red: no such refusal);
 *   - (e) an App key, a run principal and a worker session with a PRIVATE default and no private memory are refused (red);
 *   - (f) a signed-in person in that case gets the memory created with the derived name (red);
 *   - (g) an encrypted personal home works with a cached key and answers MEMORY_ENCRYPTED_NO_KEY without one (red);
 *   - (h) updateAgent(defaultChatHome:) is refused for a caller who does not manage the Agent (red: no such argument).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, chatNodeByLocOrThrow } from '../../../test/helpers.js';
import { serveEveryAgent } from '../../../test/servedBootPrompt.js';
import { generateId } from '../../../lib/id.js';
import { generateDataKey } from '../../../lib/crypto.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';
import { RUN_CLIENT_PREFIX } from '../../../lib/auth/runPrincipal.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
let orgId: string, orgUrn: string, appId: string, agentId: string, systemId: string, otherAgentId: string;
let ann: string, bob: string, carol: string;
const as = (userId: string, extra: Partial<Context> = {}): Context => ({ db, userId, roles: ['READER'], ...extra } as Context);

beforeEach(async () => {
  await cleanDb(db);
  sessionKeyCache.clear();
  const org = await db.organization.create({ data: { name: 'Chat home', urn: 'chat5027.test' } });
  orgId = org.id; orgUrn = org.urn;
  ann = (await db.user.create({ data: { handle: 'ann5027' } })).id;
  bob = (await db.user.create({ data: { handle: 'bob5027' } })).id;
  carol = (await db.user.create({ data: { handle: 'carol5027' } })).id;
  await db.orgMember.create({ data: { organizationId: orgId, userId: ann, role: 'ADMIN' } });
  await db.orgMember.create({ data: { organizationId: orgId, userId: bob, role: 'CONTRIBUTOR' } });
  const agent = await M.createAgent({}, { orgRef: orgId, name: 'Home agent', visibility: 'ORGANIZATION' }, as(ann));
  agentId = agent.id; systemId = agent.systemMemoryId;
  appId = (await db.app.create({ data: { name: 'Tutor', urn: `${orgUrn}:tutor`, organizationId: orgId } })).id;
  await db.appAgent.create({ data: { appId, agentId } });
  // A second Agent installed in the App. The person's personal and private memories are made through it, so their
  // userMemoryOfAgentId names IT: today's start path (which looks up a memory by this Agent's pointer) never finds them,
  // and a pin can only pass by naming the memory or by the default.
  otherAgentId = (await M.createAgent({}, { orgRef: orgId, name: 'Other agent', visibility: 'ORGANIZATION' }, as(ann))).id;
  await db.appAgent.create({ data: { appId, agentId: otherAgentId } });
  for (const u of [ann, bob]) await db.appMember.create({ data: { appId, userId: u, role: 'member' } });
  for (const row of [
    { loc: 'conversations', data: {} },
    { loc: 'conversations:flow', data: { stageOrder: ['step'], isSetup: false } },
    { loc: 'conversations:flow:step', data: { promptRef: 'prompts:step' } },
    { loc: 'prompts', data: {} },
    { loc: 'prompts:step', content: 'HOME STAGE', data: {} },
  ]) await db.node.create({ data: { memoryId: systemId, name: row.loc, nodeType: 'system', ...row } });
  await serveEveryAgent(db);
});
afterEach(() => sessionKeyCache.clear());

const start = (ctx: Context, args: Record<string, unknown> = {}) =>
  M.startChat({}, { agentRef: agentId, conversationName: 'flow', ...args }, ctx);
const refusal = async (p: Promise<unknown>) => {
  const err: any = await p.then(() => null, (e: unknown) => e);
  expect(err, 'the start must be refused').not.toBeNull();
  return { message: err.message, extensions: err.extensions ?? null };
};
const footprint = async () => ({
  memories: await db.memory.count(),
  nodes: await db.node.count(),
  counters: await db.chatRootCounter.count(),
  subscriptions: await db.agentSubscription.count(),
});
const sharedHome = async () => {
  const s = await start(as(ann), { scope: 'shared' });
  return (await chatNodeByLocOrThrow(db, s.chatId)).memoryId as string;
};
const appUserMemory = async (memoryClass: 'personal' | 'private', userId = ann) =>
  (await M.createMemoryInApp({}, { appRef: appId, agentRef: otherAgentId, memoryClass }, as(userId))).id as string;
const groupHome = async (role: 'writer' | 'reader' = 'writer') => {
  const g = await db.memory.create({ data: {
    id: generateId(), class: 'group', visibility: 'GROUP', name: 'Study group', urn: `${orgUrn}:study-group`,
    organizationId: orgId, appId, createdBy: ann,
  } });
  await db.memoryMember.create({ data: { memoryId: g.id, userId: ann, role } });
  return g.id;
};
const listed = async (userId: string, chatLoc: string) =>
  ((await Q.myChatsPage({}, { agentRef: agentId, limit: 50 }, as(userId))).items as any[]).find((c) => c.loc === chatLoc);

const HOSTS = [
  { klass: 'app', label: 'shared', make: sharedHome },
  { klass: 'personal', label: 'private', make: () => appUserMemory('personal') },
  { klass: 'private', label: 'private', make: () => appUserMemory('private') },
] as const;

describe('#5027 (a) a chat started with memoryRef lives in the named memory', () => {
  // An App-scoped group row is readable to none of its MemoryMembers today (#653 parity), so a group home that must carry
  // the chat's App cannot pass the read gate. Xan (#153780): the way out is a ruling for Holger; this pin stays unwritten.
  it.todo('group: awaits the group-host ruling (chat #153776/#153780)');
  for (const host of HOSTS) {
    it(`${host.klass}: the chat and its next message are in that memory; it reads back the class, the URN and scope ${host.label}`, async () => {
      const memoryId = await host.make();
      const memory = await db.memory.findUniqueOrThrow({ where: { id: memoryId } });
      const started = await start(as(ann), { memoryRef: memory.urn });
      const root = await chatNodeByLocOrThrow(db, started.chatId);
      expect(root.memoryId).toBe(memoryId);
      await M.sendChatMessage({}, { chatId: started.chatId, userMessage: 'hello home' }, as(ann));
      expect(await db.node.count({ where: { memoryId, loc: { startsWith: `${started.chatId}:messages:` } } })).toBeGreaterThan(0);
      const chat = await listed(ann, started.chatId);
      expect(chat, 'the chat is listed for its starter').toBeDefined();
      expect({ homeMemoryClass: chat.homeMemoryClass, homeMemoryUrn: chat.homeMemoryUrn, scope: chat.scope })
        .toEqual({ homeMemoryClass: host.klass, homeMemoryUrn: memory.urn, scope: host.label });
    });
  }

  it('an id works as well as a URN', async () => {
    const memoryId = await appUserMemory('personal');
    const started = await start(as(ann), { memoryRef: memoryId });
    expect((await chatNodeByLocOrThrow(db, started.chatId)).memoryId).toBe(memoryId);
  });
});

describe('#5027 (b) memoryRef with a contradicting scope', () => {
  it('is BAD_USER_INPUT and writes nothing, in both directions (a personal and an app home)', async () => {
    const personal = await appUserMemory('personal');
    const shared = await sharedHome();
    for (const [memoryRef, scope] of [[personal, 'shared'], [shared, 'private']] as const) {
      const before = await footprint();
      const err = await refusal(start(as(ann), { memoryRef, scope }));
      expect(err.extensions?.code).toBe('BAD_USER_INPUT');
      expect(await footprint()).toEqual(before);
    }
  });

  it('the matching scope is accepted', async () => {
    const personal = await appUserMemory('personal');
    const started = await start(as(ann), { memoryRef: personal, scope: 'private' });
    expect((await chatNodeByLocOrThrow(db, started.chatId)).memoryId).toBe(personal);
  });
});

describe('#5027 (c) the Agent default home', () => {
  const setDefault = (value: string | null) => M.updateAgent({}, { ref: agentId, defaultChatHome: value }, as(ann));

  it('APP_SHARED: the App\'s shared memory, as a shared chat\'s', async () => {
    await setDefault('APP_SHARED');
    const started = await start(as(ann));
    const home = await db.memory.findUniqueOrThrow({ where: { id: (await chatNodeByLocOrThrow(db, started.chatId)).memoryId } });
    expect({ class: home.class, appId: home.appId, sharedMemoryOfAgentId: home.sharedMemoryOfAgentId }).toEqual({ class: 'app', appId, sharedMemoryOfAgentId: agentId });
  });

  for (const klass of ['personal', 'private'] as const) {
    it(`${klass.toUpperCase()}: the caller's own ${klass} memory in the App`, async () => {
      const own = await appUserMemory(klass);
      await setDefault(klass.toUpperCase());
      const started = await start(as(ann));
      expect((await chatNodeByLocOrThrow(db, started.chatId)).memoryId).toBe(own);
    });
  }

  it('null: byte-identical to today (the per-user personal home, scope private)', async () => {
    await setDefault('APP_SHARED');
    await setDefault(null);
    expect((await db.agent.findUniqueOrThrow({ where: { id: agentId } })).defaultChatHome).toBeNull();
    const started = await start(as(ann));
    const root = await chatNodeByLocOrThrow(db, started.chatId);
    const home = await db.memory.findUniqueOrThrow({ where: { id: root.memoryId } });
    expect({ class: home.class, userId: home.userId, userMemoryOfAgentId: home.userMemoryOfAgentId, appUserMemory: home.appUserMemory, scope: (root.data as any).scope })
      .toEqual({ class: 'personal', userId: ann, userMemoryOfAgentId: agentId, appUserMemory: false, scope: 'private' });
  });

  it('an explicit scope still wins over the default', async () => {
    await setDefault('PRIVATE');
    const started = await start(as(ann), { scope: 'shared' });
    const home = await db.memory.findUniqueOrThrow({ where: { id: (await chatNodeByLocOrThrow(db, started.chatId)).memoryId } });
    expect(home.class).toBe('app');
  });
});

describe('#5027 (d) CHAT_HOME_INVALID: one refusal, byte-identical, nothing provisioned', () => {
  it('missing, unreadable, not writable, wrong class, another App, and an unresolvable default all answer the same', async () => {
    // Another user's private memory in the same App: real, but unreadable to ann.
    const bobsPrivate = await appUserMemory('private', bob);
    // A group memory ann may read but not write (reader role).
    const readOnlyGroup = await groupHome('reader');
    // A memory of a class that is never a home: the Agent's system memory, and an org knowledge memory ann may write.
    const knowledge = await db.memory.create({ data: {
      id: generateId(), class: 'knowledge', visibility: 'ORGANIZATION', name: 'Org notes', urn: `${orgUrn}:org-notes`, organizationId: orgId, createdBy: ann,
    } });
    // ann's own app memory in ANOTHER App that does not install this Agent.
    const otherApp = await db.app.create({ data: { name: 'Other', urn: `${orgUrn}:other`, organizationId: orgId } });
    await db.appMember.create({ data: { appId: otherApp.id, userId: ann, role: 'member' } });
    const otherAppMemory = await db.memory.create({ data: {
      id: generateId(), class: 'app', name: 'Other app memory', urn: `${orgUrn}:other-app-memory`, organizationId: orgId, appId: otherApp.id, createdBy: ann,
    } });
    const cases: Array<[string, () => Promise<unknown>]> = [
      ['missing', () => start(as(ann), { memoryRef: `${orgUrn}:no-such-memory` })],
      ['missing id', () => start(as(ann), { memoryRef: generateId() })],
      ['unreadable', () => start(as(ann), { memoryRef: bobsPrivate })],
      ['not writable', () => start(as(ann), { memoryRef: readOnlyGroup })],
      ['system class', () => start(as(ann), { memoryRef: systemId })],
      ['knowledge class', () => start(as(ann), { memoryRef: knowledge.id })],
      ['another App', () => start(as(ann), { memoryRef: otherAppMemory.id })],
    ];
    const answers: unknown[] = [];
    for (const [name, run] of cases) {
      const before = await footprint();
      const err = await refusal(run());
      expect(err.extensions?.code, name).toBe('CHAT_HOME_INVALID');
      expect(await footprint(), `${name}: nothing provisioned`).toEqual(before);
      answers.push(err);
    }
    for (const a of answers) expect(a).toEqual(answers[0]);
    // The message names no memory, App or class.
    const text = JSON.stringify(answers[0]);
    for (const leak of [bobsPrivate, readOnlyGroup, systemId, knowledge.id, knowledge.urn, otherApp.id, otherAppMemory.urn, 'private', 'group', 'system', 'knowledge']) {
      expect(text).not.toContain(leak);
    }
  });
});

describe('#5027 (d) part 2: each step of the home gate refuses on its own', () => {
  // Each case passes every step of the gate but one, so dropping that one step admits the home. The answer is still the
  // one CHAT_HOME_INVALID, and nothing is written.
  it('read-only share, a knowledge memory in this App, a home with no App, another App of this Agent, a deleted home', async () => {
    const reference = await refusal(start(as(ann), { memoryRef: `${orgUrn}:no-such-memory` }));
    // Write step: bob's personal memory, shared with ann as a reader (#778): readable to her, not writable.
    const bobsPersonal = await appUserMemory('personal', bob);
    await db.memoryShare.create({ data: { memoryId: bobsPersonal, granteeId: ann, grantorId: bob, role: 'reader' } });
    // Class step: a knowledge memory in this App, for a caller whose roles pass the read and write steps.
    const appKnowledge = await db.memory.create({ data: {
      id: generateId(), class: 'knowledge', visibility: 'ORGANIZATION', name: 'App notes', urn: `${orgUrn}:app-notes`, organizationId: orgId, appId, createdBy: ann,
    } });
    // App step: ann's own free-standing personal memory (no App).
    const freeStanding = await db.memory.create({ data: {
      id: generateId(), class: 'personal', name: 'Own notes', urn: `ann5027:own-notes`, userId: ann, ownerUserId: ann, createdBy: ann,
    } });
    // App-scope step: a second App that also installs this Agent; an App key of the first App names ann's memory there.
    const app2 = (await db.app.create({ data: { name: 'Tutor two', urn: `${orgUrn}:tutor-two`, organizationId: orgId } })).id;
    await db.appAgent.create({ data: { appId: app2, agentId } });
    await db.appMember.create({ data: { appId: app2, userId: ann, role: 'member' } });
    const inApp2 = (await M.createMemoryInApp({}, { appRef: app2, agentRef: agentId, memoryClass: 'personal' }, as(ann))).id as string;
    // Deleted step: ann's own personal memory in this App, soft-deleted.
    const deleted = await appUserMemory('personal');
    await db.memory.update({ where: { id: deleted }, data: { deletedAt: new Date() } });
    const cases: Array<[string, () => Promise<unknown>]> = [
      ['read-only share', () => start(as(ann), { memoryRef: bobsPersonal })],
      ['knowledge in this App', () => start(as(ann, { roles: ['ADMIN'] }), { memoryRef: appKnowledge.id })],
      ['no App', () => start(as(ann), { memoryRef: freeStanding.id })],
      ['another App of this Agent', () => start(as(ann, { appKeyId: 'k', appId }), { memoryRef: inApp2 })],
      ['deleted', () => start(as(ann), { memoryRef: deleted })],
    ];
    for (const [name, run] of cases) {
      const before = await footprint();
      expect(await refusal(run()), name).toEqual(reference);
      expect(await footprint(), `${name}: nothing written`).toEqual(before);
    }
  });
});

describe('#5027 (d) part 3: a home lost after the first judgement', () => {
  // The authorized transaction's own memory gate refuses a home deleted in the window (plain Forbidden, a caller who
  // could use the memory a moment earlier), before startChat's in-transaction re-judgement; nothing is written either way.
  it('a home deleted between the first judgement and the transaction is refused, writing nothing', async () => {
    const home = await appUserMemory('personal');
    // The home is soft-deleted the moment startChat opens its transaction: after the first judgement, before the second.
    let deleted = false;
    const racing = new Proxy(db, {
      get(target, key) {
        if (key === '$transaction') {
          return async (...args: unknown[]) => {
            if (!deleted) {
              deleted = true;
              await db.memory.update({ where: { id: home }, data: { deletedAt: new Date() } });
            }
            return (target.$transaction as (...a: unknown[]) => unknown)(...args);
          };
        }
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as typeof db;
    const before = await footprint();
    await refusal(start(as(ann, { db: racing }), { memoryRef: home }));
    expect(deleted).toBe(true);
    expect(await footprint()).toEqual(before);
  });
});

describe('#5027 (e) only the person creates a missing personal or private home', () => {
  // READER on each so the start passes startChat's role check and reaches the home rule: the hybrid App-key shape carries
  // the user's roles, and a real run principal (runAuthContext, roles: []) is refused earlier still, creating nothing.
  const principals: Array<[string, (u: string) => Context]> = [
    ['App key', (u) => ({ db, userId: u, roles: ['READER'], appKeyId: 'k', appId } as Context)],
    ['run principal carrying the user', (u) => ({ db, userId: u, roles: ['READER'], appId, clientId: `${RUN_CLIENT_PREFIX}${generateId()}` } as Context)],
    ['worker session', (u) => ({ db, userId: u, roles: ['READER'], sessionId: 'sess' } as Context)],
  ];
  for (const [name, ctxOf] of principals) {
    it(`${name}: a PRIVATE default with no private memory is CHAT_HOME_INVALID and creates nothing`, async () => {
      await M.updateAgent({}, { ref: agentId, defaultChatHome: 'PRIVATE' }, as(ann));
      const before = await footprint();
      const err = await refusal(start(ctxOf(ann)));
      expect(err.extensions?.code).toBe('CHAT_HOME_INVALID');
      expect(await footprint()).toEqual(before);
    });
  }
});

describe('#5027 (f) a signed-in person with no memory of the default class', () => {
  it('gets it created by createMemoryInApp\'s rule: derived name, the person\'s own, one per class', async () => {
    await M.updateAgent({}, { ref: agentId, defaultChatHome: 'PRIVATE' }, as(ann));
    const started = await start(as(ann));
    const home = await db.memory.findUniqueOrThrow({ where: { id: (await chatNodeByLocOrThrow(db, started.chatId)).memoryId } });
    expect({ class: home.class, urn: home.urn, name: home.name, userId: home.userId, ownerUserId: home.ownerUserId, appId: home.appId, appUserMemory: home.appUserMemory })
      .toEqual({ class: 'private', urn: 'ann5027:tutor-ann5027-private', name: 'tutor-ann5027-private', userId: ann, ownerUserId: ann, appId, appUserMemory: true });
    // A second start reuses it.
    const again = await start(as(ann));
    expect((await chatNodeByLocOrThrow(db, again.chatId)).memoryId).toBe(home.id);
    expect(await db.memory.count({ where: { appId, userId: ann, class: 'private' } })).toBe(1);
  });
});

describe('#5027 (g) an encrypted personal home', () => {
  it('works with a cached key, and answers MEMORY_ENCRYPTED_NO_KEY without one, writing nothing', async () => {
    const personal = await appUserMemory('personal');
    await db.memory.update({ where: { id: personal }, data: { isEncrypted: true } });
    sessionKeyCache.set(generateId(), personal, generateDataKey());
    const started = await start(as(ann), { memoryRef: personal });
    expect((await chatNodeByLocOrThrow(db, started.chatId)).memoryId).toBe(personal);
    sessionKeyCache.clear();
    const before = await footprint();
    const err = await refusal(start(as(ann), { memoryRef: personal }));
    expect(err.extensions).toMatchObject({ reason: 'MEMORY_ENCRYPTED_NO_KEY' });
    expect(await footprint()).toEqual(before);
  });

  it('a caller who cannot read the encrypted memory gets CHAT_HOME_INVALID, not the key answer', async () => {
    const bobsPersonal = await appUserMemory('personal', bob);
    await db.memory.update({ where: { id: bobsPersonal }, data: { isEncrypted: true } });
    const err = await refusal(start(as(ann), { memoryRef: bobsPersonal }));
    expect(err.extensions?.code).toBe('CHAT_HOME_INVALID');
  });
});

describe('#5027 (h) who sets the default', () => {
  it('whoever manages the Agent sets and reads it; anyone else is refused and nothing changes', async () => {
    const set = await M.updateAgent({}, { ref: agentId, defaultChatHome: 'PERSONAL' }, as(ann));
    expect(set.defaultChatHome).toBe('PERSONAL');
    const err = await refusal(M.updateAgent({}, { ref: agentId, defaultChatHome: 'PRIVATE' }, as(bob)));
    expect(err.extensions?.code).toMatch(/FORBIDDEN|NOT_FOUND/);
    await refusal(M.updateAgent({}, { ref: agentId, defaultChatHome: 'PRIVATE' }, as(carol)));
    expect((await db.agent.findUniqueOrThrow({ where: { id: agentId } })).defaultChatHome).toBe('PERSONAL');
  });
});
