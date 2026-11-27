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
import { canReadMemory as mcpCanRead, canWriteToMemory as mcpCanWrite } from '../../../mcp/access-control.js';

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
  // R1 (Holger, 2026-11-27): a group memory made in the App is read and written through its MemoryMembers.
  { klass: 'group', label: 'shared', make: () => groupHome('writer') },
  { klass: 'personal', label: 'private', make: () => appUserMemory('personal') },
  { klass: 'private', label: 'private', make: () => appUserMemory('private') },
] as const;

describe('#5027 (a) a chat started with memoryRef lives in the named memory', () => {
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

describe('#5027 (d) part 2b: the class and caller-App steps, each with every other step passing', () => {
  // Found by mutating each step (the class step and the caller-App step survived part 2): there a platform ADMIN's App
  // knowledge memory is refused by the in-transaction read step, and the App key's other-App memory by the write step.
  // These two cases pass read, write, App and licence, in both judgements, so only the named step refuses.
  it('a knowledge memory in this App that the caller owns (reads and writes it) is refused by the class step', async () => {
    const reference = await refusal(start(as(ann), { memoryRef: `${orgUrn}:no-such-memory` }));
    const ownKnowledge = await db.memory.create({ data: {
      id: generateId(), class: 'knowledge', name: 'Own App notes', urn: `${orgUrn}:own-app-notes`, appId,
      ownerUserId: ann, createdBy: ann,
    } });
    const before = await footprint();
    expect(await refusal(start(as(ann), { memoryRef: ownKnowledge.id }))).toEqual(reference);
    expect(await footprint(), 'nothing written').toEqual(before);
  });

  it('an App key naming a memory of another App of this Agent, which it may read and write as ADMIN, is refused by the caller-App step', async () => {
    const reference = await refusal(start(as(ann), { memoryRef: `${orgUrn}:no-such-memory` }));
    const app2 = (await db.app.create({ data: { name: 'Tutor three', urn: `${orgUrn}:tutor-three`, organizationId: orgId } })).id;
    await db.appAgent.create({ data: { appId: app2, agentId } });
    const shared2 = await db.memory.create({ data: {
      id: generateId(), class: 'app', name: 'Tutor three shared', urn: `${orgUrn}:tutor-three-shared`, organizationId: orgId, appId: app2,
      sharedMemoryOfAgentId: agentId, createdBy: ann,
    } });
    const before = await footprint();
    expect(await refusal(start(as(ann, { appKeyId: 'k', appId, roles: ['ADMIN'] }), { memoryRef: shared2.id }))).toEqual(reference);
    expect(await footprint(), 'nothing written').toEqual(before);
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

  // Found by mutating the AppMember step of the create (it survived): an org CONTRIBUTOR who is no AppMember still
  // reaches the create through the App's participation set, and only that step refuses. createMemoryInApp's rule is the
  // App's members, so they get the one refusal and nothing is created.
  it('an org CONTRIBUTOR who is not a member of the App gets CHAT_HOME_INVALID, and nothing is created', async () => {
    await M.updateAgent({}, { ref: agentId, defaultChatHome: 'PRIVATE' }, as(ann));
    await db.orgMember.create({ data: { organizationId: orgId, userId: carol, role: 'CONTRIBUTOR' } });
    const before = await footprint();
    const err = await refusal(start(as(carol)));
    expect(err.extensions?.code).toBe('CHAT_HOME_INVALID');
    expect(await footprint()).toEqual(before);
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

// Ask 6 (Option A): the chat records its Agent, and a home's readers are the chat's audience. Holger's rulings of
// 2026-11-27 (R1: a group memory made in an App is read and written through its MemoryMembers; R4: the smallest unit of
// access is the memory, so a personal memory's share grantee reads a chat started there), recorded with Vera's FIT
// (hrn:node:hadronmemory.com:hadron-dev-team-shared:decisions:2026-11-27-holger-rulings-to-vera-group-chat-no-admin-read).
describe('#5027 Ask 6: the chat records its Agent; the home\'s readers are its audience', () => {
  const turn = (ctx: Context, chatId: string, userMessage = 'next turn') =>
    M.sendChatMessage({}, { chatId, userMessage }, ctx) as Promise<{ systemMessage: string }>;
  const history = (ctx: Context, chatId: string) => Q.chatHistory({}, { chatId }, ctx) as Promise<unknown[]>;
  const withCarolInApp = async () => {
    await db.orgMember.create({ data: { organizationId: orgId, userId: carol, role: 'CONTRIBUTOR' } });
    await db.appMember.create({ data: { appId, userId: carol, role: 'member' } });
  };

  it('(i) a chat in a group home and one in a private home answer the next turn with the recorded Agent', async () => {
    const group = await groupHome('writer');
    const priv = await appUserMemory('private');
    for (const memoryRef of [group, priv]) {
      const started = await start(as(ann), { memoryRef });
      const reply = await turn(as(ann), started.chatId);
      // The private memory's own pointer names the OTHER Agent (it was made through it), and the group row has none:
      // only the recorded Agent gives this flow's stage prompt.
      expect(reply.systemMessage, memoryRef === group ? 'group' : 'private').toContain('HOME STAGE');
    }
  });

  it('(ii) an old chat with no recorded Agent routes and lists exactly as today', async () => {
    const started = await start(as(ann));
    const root = await chatNodeByLocOrThrow(db, started.chatId);
    await db.$executeRawUnsafe('UPDATE chat_root_counters SET agent_id = NULL WHERE chat_root_node_id = $1', root.id);
    expect((await turn(as(ann), started.chatId)).systemMessage).toContain('HOME STAGE');
    expect(await listed(ann, started.chatId)).toBeDefined();
  });

  it('(iii) a second group member reads, lists and posts in a group chat they did not start', async () => {
    const group = await groupHome('writer');
    await db.memoryMember.create({ data: { memoryId: group, userId: bob, role: 'writer' } });
    const started = await start(as(ann), { memoryRef: group });
    await turn(as(ann), started.chatId, 'from ann');
    expect((await history(as(bob), started.chatId)).length).toBeGreaterThan(0);
    expect(await listed(bob, started.chatId), 'listed for the other member').toBeDefined();
    expect((await turn(as(bob), started.chatId, 'from bob')).systemMessage).toContain('HOME STAGE');
  });

  // (iv) Xan's call on the gate, 2026-11-27 (#154086, option B): R4 makes the memory the unit, so the chat follows the
  // memory's read gate exactly. The shared gate admits no share grantee to an App personal memory (granteeShareAccess
  // and getAccessibleMemoryIds' sharedWithMe arm require user_memory_of_agent_id NULL, which chk_memory_personal_agent_id
  // forbids once app_id is set), and every chat home carries an App. So a grantee of a personal chat home gets the
  // not-found of a chat that does not exist, writes nothing and lists nothing. Whether such a share should grant
  // anything is a separate question, filed apart from #5027.
  // Found by mutating chatLoc's owner arm (it survived: the creator arms admit every chat the owner starts). A chat in
  // the owner's home whose root and memory another principal wrote (an import, a support restore) is still the owner's
  // to read and list: R3, the owner reads their memory.
  it('(iii-b) the owner reads and lists a chat in their own private home that rows written by someone else hold', async () => {
    const priv = await appUserMemory('private');
    const started = await start(as(ann), { memoryRef: priv });
    await turn(as(ann), started.chatId, 'from ann');
    const root = await chatNodeByLocOrThrow(db, started.chatId);
    await db.node.updateMany({ where: { memoryId: priv }, data: { createdBy: bob } });
    await db.memory.update({ where: { id: priv }, data: { createdBy: bob } });
    expect((await history(as(ann), started.chatId)).length).toBeGreaterThan(0);
    expect(await listed(ann, started.chatId), 'listed for the owner').toBeDefined();
    expect(root.memoryId).toBe(priv);
  });

  it('(iv) a share grantee of an App personal home is refused as for a missing chat: the chat follows the memory gate (R4, option B)', async () => {
    const personal = await appUserMemory('personal');
    await db.memoryShare.create({ data: { memoryId: personal, granteeId: bob, grantorId: ann, role: 'writer' } });
    const missing = `chats:${Date.now()}-${generateId().slice(0, 8)}-flow`;
    const nothing = {
      history: await refusal(history(as(bob), missing)),
      send: await refusal(turn(as(bob), missing)),
    };
    const started = await start(as(ann), { memoryRef: personal });
    await turn(as(ann), started.chatId, 'from ann');
    const before = await footprint();
    const seen = {
      history: await refusal(history(as(bob), started.chatId)),
      send: await refusal(turn(as(bob), started.chatId)),
    };
    const swap = (e: { message: string; extensions: unknown }) => JSON.parse(JSON.stringify(e).split(started.chatId).join(missing));
    expect(swap(seen.history), 'history').toEqual(nothing.history);
    expect(swap(seen.send), 'send').toEqual(nothing.send);
    expect(await footprint(), 'nothing written').toEqual(before);
    expect(await listed(bob, started.chatId), 'not listed for the grantee').toBeUndefined();
  });

  it('(v) a non-reader of the home gets the not-found of a chat that does not exist, and no listing', async () => {
    await withCarolInApp();
    const group = await groupHome('writer');
    const personal = await appUserMemory('personal');
    const priv = await appUserMemory('private');
    const missing = `chats:${Date.now()}-${generateId().slice(0, 8)}-flow`;
    const nothing = {
      history: await refusal(history(as(carol), missing)),
      send: await refusal(turn(as(carol), missing)),
    };
    for (const memoryRef of [group, personal, priv]) {
      const started = await start(as(ann), { memoryRef });
      await turn(as(ann), started.chatId, 'from ann');
      const before = await footprint();
      const seen = {
        history: await refusal(history(as(carol), started.chatId)),
        send: await refusal(turn(as(carol), started.chatId)),
      };
      // Each answer is compared with the missing chat's after swapping the chat id, the one thing the caller named.
      const swap = (e: { message: string; extensions: unknown }) => JSON.parse(JSON.stringify(e).split(started.chatId).join(missing));
      expect(swap(seen.history), `${memoryRef} history`).toEqual(nothing.history);
      expect(swap(seen.send), `${memoryRef} send`).toEqual(nothing.send);
      expect(await footprint(), 'nothing written').toEqual(before);
      expect(await listed(carol, started.chatId)).toBeUndefined();
    }
  });

  it('(vi) the validator accepts a group home as shared and a private home as private, and refuses a mismatched label', async () => {
    const group = await groupHome('writer');
    const priv = await appUserMemory('private');
    expect((await chatNodeByLocOrThrow(db, (await start(as(ann), { memoryRef: group, scope: 'shared' })).chatId)).memoryId).toBe(group);
    expect((await chatNodeByLocOrThrow(db, (await start(as(ann), { memoryRef: priv, scope: 'private' })).chatId)).memoryId).toBe(priv);
    expect((await refusal(start(as(ann), { memoryRef: group, scope: 'private' }))).extensions?.code).toBe('BAD_USER_INPUT');
    expect((await refusal(start(as(ann), { memoryRef: priv, scope: 'shared' }))).extensions?.code).toBe('BAD_USER_INPUT');
  });

  it('(vii) a group MemoryMember reads and writes an App-scoped group memory; an App member outside it is refused as for a missing memory (R1)', async () => {
    await withCarolInApp();
    const group = await groupHome('writer');
    await db.memoryMember.create({ data: { memoryId: group, userId: bob, role: 'writer' } });
    const made = await M.createNode({}, { input: { memoryRef: group, loc: 'notes:one', name: 'one', content: 'by bob' } }, as(bob));
    expect(made.memoryId ?? (await db.node.findUniqueOrThrow({ where: { id: made.id } })).memoryId).toBe(group);
    expect((await Q.node({}, { ref: 'notes:one', memoryRef: group }, as(bob)))?.content).toBe('by bob');
    const missingMemory = generateId();
    const read = async (memoryRef: string) => {
      const r = await Q.node({}, { ref: 'notes:one', memoryRef }, as(carol)).then((n: unknown) => ({ value: n }), (e: any) => ({ message: e.message, code: e.extensions?.code ?? null }));
      return JSON.parse(JSON.stringify(r).split(memoryRef).join('<ref>'));
    };
    expect(await read(group)).toEqual(await read(missingMemory));
    const write = async (memoryRef: string) => {
      const r = await refusal(M.createNode({}, { input: { memoryRef, loc: 'notes:two', name: 'two', content: 'x' } }, as(carol)));
      return JSON.parse(JSON.stringify(r).split(memoryRef).join('<ref>'));
    };
    // createNode answers a memory the caller may not write with its write refusal, whatever the memory: the App-scoped
    // group answers exactly as an org group carol is not a member of does today.
    const orgGroup = (await db.memory.create({ data: {
      id: generateId(), class: 'group', visibility: 'GROUP', name: 'Org group', urn: `${orgUrn}:org-group`, organizationId: orgId, createdBy: ann,
    } })).id;
    await db.memoryMember.create({ data: { memoryId: orgGroup, userId: ann, role: 'owner' } });
    expect(await write(group)).toEqual(await write(orgGroup));
    expect(await db.node.count({ where: { memoryId: group, loc: 'notes:two' } })).toBe(0);
  });

  // The gate's conditions (Xan's re-gate of 2026-11-27): the new arm admits MemoryMembers only. An org ADMIN who is not
  // a member gets nothing through it; a platform admin's answer is whatever it was before #5027 (the R2 admin audit is
  // a separate issue), identical for an App-scoped group and an org group; an org group with no App is unchanged.
  const groupOf = async (inApp: boolean, members: Array<[string, 'reader' | 'writer' | 'owner']>) => {
    const g = await db.memory.create({ data: {
      id: generateId(), class: 'group', visibility: 'GROUP', name: inApp ? 'App group' : 'Org group',
      urn: `${orgUrn}:${inApp ? 'app' : 'org'}-group-${generateId().slice(0, 6)}`, organizationId: orgId, createdBy: bob, ...(inApp ? { appId } : {}),
    } });
    for (const [userId, role] of members) await db.memoryMember.create({ data: { memoryId: g.id, userId, role } });
    await db.node.create({ data: { memoryId: g.id, loc: 'notes:seed', name: 'seed', content: 'seeded' } });
    return g.id;
  };
  const answers = async (ctx: Context, memoryId: string) => ({
    record: !!(await Q.memory({}, { ref: memoryId }, ctx).catch(() => null)),
    node: (await Q.node({}, { ref: 'notes:seed', memoryRef: memoryId }, ctx).catch(() => null))?.content ?? null,
    write: await M.createNode({}, { input: { memoryRef: memoryId, loc: `notes:w${generateId().slice(0, 6)}`, name: 'w', content: 'w' } }, ctx).then(() => true, () => false),
    mcpRead: await mcpCanRead(db, { userId: ctx.userId!, roles: ctx.roles ?? [] } as any, memoryId),
    mcpWrite: await mcpCanWrite(db, { userId: ctx.userId!, roles: ctx.roles ?? [] } as any, memoryId),
  });
  const NOTHING = { record: false, node: null, write: false, mcpRead: false, mcpWrite: false };
  const EVERYTHING = { record: true, node: 'seeded', write: true, mcpRead: true, mcpWrite: true };

  it('(vii) the new arm, on GraphQL and MCP alike: a member writer reads and writes, a member reader only reads', async () => {
    const g = await groupOf(true, [[bob, 'writer'], [carol, 'reader']]);
    await withCarolInApp();
    expect(await answers(as(bob), g)).toEqual(EVERYTHING);
    expect(await answers(as(carol), g)).toEqual({ record: true, node: 'seeded', write: false, mcpRead: true, mcpWrite: false });
  });

  it('(vii) an org ADMIN who is not a member gets nothing through it, on GraphQL and MCP; nor does an App member', async () => {
    const g = await groupOf(true, [[bob, 'owner']]);
    await withCarolInApp();
    expect(await answers(as(ann), g), 'org ADMIN, App member, not in the group').toEqual(NOTHING);
    expect(await answers(as(carol), g), 'App member, not in the group').toEqual(NOTHING);
  });

  it('(vii) a platform admin answers the same for an App-scoped group as for an org group, as before #5027', async () => {
    const inApp = await groupOf(true, [[bob, 'owner']]);
    const inOrg = await groupOf(false, [[bob, 'owner']]);
    const admin = as(carol, { roles: ['ADMIN'] });
    expect(await answers(admin, inApp)).toEqual(await answers(admin, inOrg));
  });

  it('(vii) control: an org group with no App is unchanged: its members in, an org ADMIN outside it refused', async () => {
    const g = await groupOf(false, [[bob, 'writer']]);
    expect(await answers(as(bob), g)).toEqual(EVERYTHING);
    expect(await answers(as(ann), g)).toEqual(NOTHING);
  });
});
