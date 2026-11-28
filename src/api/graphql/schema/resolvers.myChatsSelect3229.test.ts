/**
 * #3229: `myChats` and `myChatsPage` fetch chat roots with a narrow `select` of exactly the
 * columns `toChatRows` reads (`ChatRootRow`), not full `Node` rows.
 *
 * Pin 1 (red on main): both `node.findMany` calls — `myChats`'s own and the one inside
 * `myChatsPage`'s `$transaction` — carry a `select` whose key set is exactly the six
 * `ChatRootRow` columns. Dropping any column `toChatRows` needs fails this pin, which is the
 * issue's acceptance criterion.
 *
 * Pin 2 (green on main, holds the change honest): every one of the six columns is load-bearing
 * in the returned `Chat` row, so a dropped column breaks the asserted output rather than merely
 * shrinking the query — `id`/`loc`/`createdAt`/`createdBy` are asserted directly, `data` through
 * title/scope/aiConfigChoice, `memoryId` through the counter and engine-state lookups
 * (`readChatCounters` / `readChatEngineStates` key their per-memory encryption lookup on it and
 * answer zeros/nulls for an unknown memory). Both surfaces must return identical rows.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

const Q = resolvers.Query as any;

let org: { id: string; urn: string };
let agent: { id: string; urn: string };
let owner: { id: string };
let ownerPersonal: { id: string; urn: string };
let shared: { id: string; urn: string };
/** The rich chat in the App's shared memory: explicit title, counter row, engine-state row. */
let chatA: { id: string };
/** The personal chat with no title: its title is the trimmed first message. */
let chatB: { id: string };

const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] } as Context);
const byLoc = (rows: Array<{ loc: string }>, loc: string) => rows.find(r => r.loc === loc);

beforeEach(async () => {
  await cleanDb(db);
  const t = generateId().slice(-8);
  org = await db.organization.create({ data: { id: generateId(), name: 'mcp', urn: `mcp-${t}` } });
  owner = await db.user.create({
    data: { id: generateId(), githubId: 3229_00, githubUsername: `mcp-${t}`, handle: `mcp-${t}` },
  });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: owner.id, role: 'CONTRIBUTOR' } });
  agent = await db.agent.create({
    data: { id: generateId(), organizationId: org.id, name: 'agent', urn: `${org.urn}:agent`, visibility: 'ORGANIZATION' },
  });
  const app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'A', urn: `${org.urn}:a` } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await db.appMember.create({ data: { appId: app.id, userId: owner.id, role: 'admin' } });

  ownerPersonal = await db.memory.create({
    data: {
      id: generateId(), organizationId: org.id, urn: `${org.urn}:owner-p`, name: 'owner-p', class: 'knowledge',
      visibility: 'ORGANIZATION', userMemoryOfAgentId: agent.id, createdBy: owner.id,
    },
  });
  shared = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:shared`, name: 'shared', class: 'app', appId: app.id },
  });

  chatA = await db.node.create({
    data: {
      id: generateId(), memoryId: shared.id, loc: 'chats:rich', name: 'chats:rich', nodeType: 'record',
      createdBy: owner.id, createdAt: new Date('2026-03-04T05:06:07.890Z'),
      data: { scope: 'shared', title: 'Explicit title', aiConfigChoice: 'glm-flash' },
    },
  });
  await db.chatRootCounter.create({
    data: { chatRootNodeId: chatA.id, messageCount: 3, lastMessageAt: new Date('2026-02-02T00:00:00Z') },
  });
  await db.chatRootEngineState.create({
    data: {
      chatRootNodeId: chatA.id,
      state: {
        conversationName: 'intake', stageName: 'triage',
        completedConversations: [{ conversation: 'goal-setting', completedAt: '2026-01-02T03:04:05Z' }],
      },
    },
  });

  chatB = await db.node.create({
    data: {
      id: generateId(), memoryId: ownerPersonal.id, loc: 'chats:titled-by-first-message', name: 'b', nodeType: 'record',
      createdBy: owner.id, createdAt: new Date('2026-03-05T05:06:07.890Z'),
      data: { scope: 'private' },
    },
  });
  await db.node.create({
    data: {
      id: generateId(), memoryId: ownerPersonal.id, loc: 'chats:titled-by-first-message:messages:001-u',
      name: 'm1', nodeType: 'record', content: '  Hello  world  ',
    },
  });
});

const SIX_COLUMNS = ['createdAt', 'createdBy', 'data', 'id', 'loc', 'memoryId'];

/** A chat-root fetch is a `node.findMany` whose `where` is the `myChatsScope` shape (`loc` starts with `chats:`). */
const isChatRootFetch = (call: any[]) => call[0]?.where?.loc?.startsWith === 'chats:';

/** Select the chat-root fetches by shape (#4762), require exactly `expected` of them, and check each select. */
function expectChatRootSelects(calls: any[][], expected: number) {
  const matched = calls.filter(isChatRootFetch);
  // Non-vacuous: a shape change that matches nothing must fail here, not pass with nothing checked.
  expect(matched).toHaveLength(expected);
  for (const call of matched) {
    expect(Object.keys(call[0]?.select ?? {}).sort()).toEqual(SIX_COLUMNS);
  }
}

async function spyFindMany(run: () => Promise<unknown>, decoy = false): Promise<any[][]> {
  const spy = vi.spyOn(db.node, 'findMany');
  // Snapshot before mockRestore(): vitest's restore clears mock.calls.
  try {
    // loc-scope-ok: a deliberate decoy query that matches no row; the pin must ignore it.
    if (decoy) await db.node.findMany({ where: { loc: 'decoy-not-a-chat-root' } });
    await run();
    return [...spy.mock.calls];
  } finally {
    spy.mockRestore();
  }
}

describe('#3229 myChats/myChatsPage select exactly the toChatRows columns', () => {
  it('each surface runs one chat-root fetch with the six-column select (red on main: no select at all)', async () => {
    expectChatRootSelects(await spyFindMany(() => Q.myChats({}, { agentRef: agent.id }, ctx(owner.id))), 1);
    expectChatRootSelects(await spyFindMany(() => Q.myChatsPage({}, { agentRef: agent.id }, ctx(owner.id))), 1);
  });

  it('an unrelated node.findMany does not disturb the pin (#4762 F1: the old count-of-2 pin failed here)', async () => {
    const calls = await spyFindMany(async () => {
      await Q.myChats({}, { agentRef: agent.id }, ctx(owner.id));
      await Q.myChatsPage({}, { agentRef: agent.id }, ctx(owner.id));
    }, true);
    expect(calls).toHaveLength(3);
    expectChatRootSelects(calls, 2);
  });

  it('a chat-root fetch with a column dropped fails the pin, and a vanished shape fails the count', () => {
    const where = { loc: { startsWith: 'chats:' } };
    const dropped = { id: true, loc: true, memoryId: true, data: true, createdAt: true };
    expect(() => expectChatRootSelects([[{ where, select: dropped }]], 1)).toThrow();
    // loc-scope-ok: a fake call record handed to the pin helper, not a query.
    expect(() => expectChatRootSelects([[{ where: { loc: 'x' }, select: dropped }]], 1)).toThrow();
  });
});

describe('#3229 every selected column is load-bearing in the Chat row', () => {
  it('returns the rich chat and the first-message-titled chat, identically from both surfaces', async () => {
    const rows = await Q.myChats({}, { agentRef: agent.id }, ctx(owner.id));
    const page = await Q.myChatsPage({}, { agentRef: agent.id }, ctx(owner.id));

    // `data` (title, scope, aiConfigChoice), `id`, `loc`, `createdAt`, `createdBy`;
    // `memoryId` through the counter/engine lookups keyed on it.
    expect(byLoc(rows, 'chats:rich')).toEqual({
      id: chatA.id,
      loc: 'chats:rich',
      title: 'Explicit title',
      conversationName: 'intake',
      stageName: 'triage',
      completedConversations: ['goal-setting'],
      messageCount: 3,
      createdAt: new Date('2026-03-04T05:06:07.890Z'),
      lastMessageAt: '2026-02-02T00:00:00.000Z',
      scope: 'shared',
      // #5027: the home memory's class and URN (memoryId is load-bearing for them too).
      homeMemoryClass: 'app',
      homeMemoryUrn: `hrn:mem:${shared.urn}`,
      createdBy: owner.id,
      aiConfigChoice: 'glm-flash',
    });
    expect(byLoc(rows, 'chats:titled-by-first-message')).toEqual({
      id: chatB.id,
      loc: 'chats:titled-by-first-message',
      title: 'Hello world',
      conversationName: null,
      stageName: null,
      completedConversations: [],
      messageCount: 0,
      createdAt: new Date('2026-03-05T05:06:07.890Z'),
      lastMessageAt: null,
      scope: 'private',
      homeMemoryClass: 'knowledge',
      homeMemoryUrn: `hrn:mem:${ownerPersonal.urn}`,
      createdBy: owner.id,
      aiConfigChoice: null,
    });

    expect(page).toMatchObject({ total: 2, hasMore: false });
    const sorted = (list: Array<{ loc: string }>) => [...list].sort((a, b) => a.loc.localeCompare(b.loc));
    expect(sorted(page.items)).toEqual(sorted(rows));
  });
});
