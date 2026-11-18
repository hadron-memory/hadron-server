/**
 * #4039 (S6 of #3850; cor:cht:020:02 r2, cor:cht:020:01, cor:cht:030:02 Q19; rulings Q11-Q19, Q14a; gate B1-B4):
 * an unnamed `startChat` opens the first ordinary conversation, in the author's order (`Node.seq`, nulls last, ties by
 * loc), whose `data.entryCondition` holds for THIS starter. The home memory is located with no write, the conditions are
 * evaluated, and only then is anything provisioned. A condition that cannot be evaluated refuses with
 * `ENTRY_CONDITION_FAILED` and leaves nothing behind.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, chatNodeByLoc } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { generateId } from '../../../lib/id.js';
import { serveEveryAgent } from '../../../test/servedBootPrompt.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const M = resolvers.Mutation as any;
let org: { id: string; urn: string };
let alice: { id: string };
let bob: { id: string };
let agentId: string;
let appId: string;
let systemMemoryId: string;
const ctxFor = (userId: string): Context => ({ db, roles: ['READER'], userId }) as Context;

const NAME_UNKNOWN = { '!': [{ var: 'memory.name' }] };
type Seed = { loc: string; data?: Record<string, unknown> | null; seq?: number | null; content?: string | null };

function conv(name: string, opts: { seq?: number | null; condition?: unknown; flags?: Record<string, unknown> } = {}): Seed[] {
  return [
    {
      loc: `conversations:${name}`, seq: opts.seq ?? null,
      data: { stageOrder: ['s1'], ...(opts.flags ?? {}), ...(opts.condition !== undefined ? { entryCondition: opts.condition } : {}) },
    },
    { loc: `conversations:${name}:s1`, data: {}, content: `prompt ${name}` },
  ];
}

async function seed(seeds: Seed[], path: 'live' | 'snapshot' = 'live') {
  const all: Seed[] = [{ loc: 'conversations', data: null }, ...seeds];
  if (path === 'live') {
    for (const s of all) {
      await db.node.create({ data: {
        id: generateId(), memoryId: systemMemoryId, loc: s.loc, name: s.loc.split(':').pop()!, nodeType: 'system',
        data: (s.data ?? null) as never, content: s.content ?? null, seq: s.seq ?? null,
      } });
    }
    return;
  }
  const nodes = all.map((s) => ({
    loc: s.loc, name: s.loc.split(':').pop()!, nodeType: 'system', description: null, content: s.content ?? null,
    data: s.data ?? null, seq: s.seq ?? null,
  }));
  await db.node.create({ data: {
    id: generateId(), memoryId: systemMemoryId, loc: 'revisions:rev-4039', name: 'rev-4039', nodeType: 'system',
    data: { snapshot: { edgeFormat: 2, nodes, edges: [] } } as never,
  } });
  await db.agent.update({ where: { id: agentId }, data: { publishedRevisionLoc: 'revisions:rev-4039' } });
}

beforeEach(async () => {
  await cleanDb(db);
  sessionKeyCache.clear();
  org = await db.organization.create({ data: { id: generateId(), name: 'org-4039', urn: 'org-4039' } });
  const admin = await db.user.create({ data: { githubId: 40390, githubUsername: 'admin-4039', roles: ['ADMIN'] } });
  alice = await db.user.create({ data: { githubId: 40391, githubUsername: 'alice-4039', roles: ['READER'] } });
  bob = await db.user.create({ data: { githubId: 40392, githubUsername: 'bob-4039', roles: ['READER'] } });
  for (const u of [admin, alice, bob]) {
    await db.orgMember.create({ data: { organizationId: org.id, userId: u.id, role: u === admin ? 'ADMIN' : 'CONTRIBUTOR' } });
  }
  const created = await M.createAgent({}, { orgId: org.id, name: 'intake-agent', visibility: 'ORGANIZATION' }, { db, roles: ['ADMIN'], userId: admin.id });
  agentId = created.id;
  systemMemoryId = created.systemMemoryId!;
  const app = await db.app.create({ data: {
    id: generateId(), name: 'intake-app', urn: `${org.urn}:intake-app`, organizationId: org.id, appAgents: { create: { agentId } },
  } });
  appId = app.id;
  for (const u of [alice, bob]) await db.appMember.create({ data: { appId, userId: u.id, role: 'member' } });
  await serveEveryAgent(db);
});

const startShared = (userId: string, args: Record<string, unknown> = {}) =>
  M.startChat({}, { agentId, scope: 'shared', ...args }, ctxFor(userId));
const opened = async (userId: string, args: Record<string, unknown> = {}) => (await startShared(userId, args)).conversationName as string;
async function refusal(userId: string, args: Record<string, unknown> = {}) {
  const err = await startShared(userId, args).then(() => null, (e: unknown) => e) as { extensions?: Record<string, any> } | null;
  expect(err).not.toBeNull();
  return err!.extensions!;
}
const sharedMemory = () => db.memory.findFirst({ where: { appId, sharedMemoryOfAgentId: agentId } });
async function saveFacts(users: Record<string, Record<string, unknown>>) {
  const memory = await sharedMemory();
  expect(memory).not.toBeNull();
  await db.node.upsert({
    where: { loc_memoryId: { loc: 'data', memoryId: memory!.id } },
    update: { data: { users } as never },
    create: { id: generateId(), memoryId: memory!.id, loc: 'data', name: 'data', nodeType: 'system', data: { users } as never },
  });
}
const footprint = async () => ({
  memories: await db.memory.count(), nodes: await db.node.count(), subscriptions: await db.agentSubscription.count(),
  deletedMemories: await db.memory.count({ where: { deletedAt: { not: null } } }),
});

for (const path of ['live', 'snapshot'] as const) describe(`#4039 unnamed start by entry condition (${path})`, () => {
  it('1 (S1/S2/S3): unknown name opens welcome, a saved name opens recent-event, and seq beats alphabetical order', async () => {
    await seed([
      ...conv('welcome', { seq: 1, condition: NAME_UNKNOWN }),
      ...conv('alpha-recent-event', { seq: 2 }),
    ], path);
    expect(await opened(alice.id)).toBe('welcome');
    await saveFacts({ [alice.id]: { name: 'Ann' } });
    expect(await opened(alice.id)).toBe('alpha-recent-event');
  });

  it('3 (Q14a): no seq sorts after a set seq; equal seq breaks by loc', async () => {
    await seed([
      ...conv('aaa-noseq'), ...conv('mmm-two', { seq: 2 }), ...conv('zzz-one', { seq: 1 }), ...conv('bbb-one', { seq: 1 }),
    ], path);
    expect(await opened(alice.id)).toBe('bbb-one');
  });

  it('S4 (Q12): every ordered condition fails: setup, else fallback, else AGENT_HAS_NO_CONVERSATIONS', async () => {
    const never = { '==': [1, 2] };
    await seed([...conv('one', { seq: 1, condition: never }), ...conv('fb', { flags: { isFallback: true } }), ...conv('su', { flags: { isSetup: true } })], path);
    expect(await opened(alice.id)).toBe('su');
  });

  it('S5 (Q17): a named start opens the named conversation although its condition fails, and reads no facts', async () => {
    await seed([...conv('welcome', { seq: 1, condition: NAME_UNKNOWN }), ...conv('other', { seq: 2 })], path);
    await opened(alice.id);
    await saveFacts({ [alice.id]: { name: 'Ann' } });
    expect(await opened(alice.id, { conversationName: 'welcome' })).toBe('welcome');
    // Encrypted home memory, no key: a named start never evaluates, so it is not refused for the condition.
    await db.memory.update({ where: { id: (await sharedMemory())!.id }, data: { isEncrypted: true } });
    const err = await startShared(alice.id, { conversationName: 'welcome' }).then(() => null, (e: any) => e);
    expect(err?.extensions?.code).not.toBe('ENTRY_CONDITION_FAILED');
  });

  it('8 (shared chat): the starter\'s bucket decides, never another member\'s', async () => {
    await seed([...conv('welcome', { seq: 1, condition: NAME_UNKNOWN }), ...conv('recent', { seq: 2 })], path);
    await opened(alice.id);
    await saveFacts({ [alice.id]: { name: 'Ann' } });
    expect(await opened(alice.id)).toBe('recent');
    expect(await opened(bob.id)).toBe('welcome');
  });
});

describe('#4039 refusals judged before any write', () => {
  it('4 (Q16): a stored condition that reads chat.* refuses at start; no memory, node, chat or subscription is created', async () => {
    await seed([...conv('welcome', { seq: 1, condition: { '==': [{ var: 'chat.message_count' }, 0] } })]);
    const before = await footprint();
    const ext = await refusal(alice.id);
    expect(ext.code).toBe('ENTRY_CONDITION_FAILED');
    expect(ext.reason).toBe('SCOPE_NOT_AVAILABLE_AT_START');
    expect(ext.messageId).toBe('chat-start.error.invalid_condition');
    expect(await footprint()).toEqual(before);
  });

  it('10 / 11: the restored-content refusal carries exactly {conversation, field} and no value, URN or id', async () => {
    await seed([...conv('welcome', { seq: 1, condition: { '==': [{ var: 'message.data.x' }, 1] } })]);
    const ext = await refusal(alice.id);
    expect(Object.keys(ext).filter((k) => !['stacktrace', 'exception', 'http'].includes(k)).sort()).toEqual(['code', 'detail', 'messageId', 'reason']);
    expect(ext.detail).toEqual({ conversation: 'welcome', field: 'message.data.x' });
  });

  it('4b (B1): an encrypted home memory with no key refuses even when the FIRST conversation has no condition; nothing is written', async () => {
    await seed([...conv('first', { seq: 1 }), ...conv('second', { seq: 2, condition: NAME_UNKNOWN })]);
    await opened(alice.id); // provisions the shared memory, plaintext
    await db.memory.update({ where: { id: (await sharedMemory())!.id }, data: { isEncrypted: true } });
    const before = await footprint();
    const ext = await refusal(alice.id);
    expect(ext).toMatchObject({ code: 'ENTRY_CONDITION_FAILED', reason: 'MEMORY_ENCRYPTED_NO_KEY', messageId: 'chat-start.error.memory_encrypted_no_key', detail: {} });
    expect(await footprint()).toEqual(before);
  });

  it('4c: with no condition anywhere nothing is read or refused for the memory', async () => {
    await seed([...conv('first', { seq: 1 }), ...conv('second', { seq: 2 })]);
    await opened(alice.id);
    await db.memory.update({ where: { id: (await sharedMemory())!.id }, data: { isEncrypted: true } });
    const err = await startShared(alice.id).then(() => null, (e: any) => e);
    expect(err?.extensions?.code).not.toBe('ENTRY_CONDITION_FAILED');
  });

  it('4d (B2): a soft-deleted shared memory counts as absent (no facts read), and is then revived as today', async () => {
    await seed([...conv('welcome', { seq: 1, condition: NAME_UNKNOWN }), ...conv('recent', { seq: 2 })]);
    await opened(alice.id);
    await saveFacts({ [alice.id]: { name: 'Ann' } });
    expect(await opened(alice.id)).toBe('recent');
    const memory = (await sharedMemory())!;
    await db.memory.update({ where: { id: memory.id }, data: { deletedAt: new Date() } });
    expect(await opened(alice.id)).toBe('welcome');
    expect((await db.memory.findUniqueOrThrow({ where: { id: memory.id } })).deletedAt).toBeNull();
  });

  it('4d2 (B2, Baloo P2): with an older tombstoned and a younger live legacy row, the start picks the row provisioning will revive: facts of the younger row are not read', async () => {
    await seed([...conv('welcome', { seq: 1, condition: NAME_UNKNOWN }), ...conv('recent', { seq: 2 })]);
    await opened(alice.id);
    const older = (await sharedMemory())!;
    const { id: _id, urn: _urn, ...rest } = older as any;
    await db.memory.update({ where: { id: older.id }, data: { sharedMemoryOfAgentId: null, urn: `${org.urn}:intake-app:intake-agent:shared`, deletedAt: new Date(), createdAt: new Date(Date.now() - 86400000) } });
    const younger = await db.memory.create({ data: { ...rest, id: generateId(), urn: `${org.urn}:intake-app2:intake-agent:shared`, legacyUrn: null, sharedMemoryOfAgentId: null, deletedAt: null, createdAt: new Date() } });
    await db.node.create({ data: { id: generateId(), memoryId: younger.id, loc: 'data', name: 'data', nodeType: 'system', data: { users: { [alice.id]: { name: 'Ann' } } } as never } });
    expect(await opened(alice.id)).toBe('welcome');
    expect((await db.memory.findUniqueOrThrow({ where: { id: older.id } })).deletedAt).toBeNull();
  });

  it('4d3 (B2, Betty F1): a live unkeyed legacy row is the home the start reads; provisioning adopts the SAME row', async () => {
    await seed([...conv('welcome', { seq: 1, condition: NAME_UNKNOWN }), ...conv('recent', { seq: 2 })]);
    await opened(alice.id);
    const keyed = (await sharedMemory())!;
    await db.memory.update({ where: { id: keyed.id }, data: { sharedMemoryOfAgentId: null, urn: `${org.urn}:intake-app:intake-agent:shared` } });
    await db.node.upsert({
      where: { loc_memoryId: { loc: 'data', memoryId: keyed.id } },
      update: { data: { users: { [alice.id]: { name: 'Ann' } } } as never },
      create: { id: generateId(), memoryId: keyed.id, loc: 'data', name: 'data', nodeType: 'system', data: { users: { [alice.id]: { name: 'Ann' } } } as never },
    });
    expect(await opened(alice.id)).toBe('recent');
    expect((await db.memory.findUniqueOrThrow({ where: { id: keyed.id } })).sharedMemoryOfAgentId).toBe(agentId);
  });

  it('4e (B2): a live home memory the starter cannot read refuses MEMORY_UNREADABLE; nothing is read or written', async () => {
    await seed([...conv('welcome', { seq: 1, condition: NAME_UNKNOWN })]);
    const memory = await db.memory.create({ data: {
      id: generateId(), organizationId: org.id, urn: `org-4039:private-${generateId()}`, name: 'alice home', class: 'personal',
      userId: bob.id, userMemoryOfAgentId: agentId, appId, createdBy: alice.id,
    } });
    const before = await footprint();
    const err = await M.startChat({}, { agentId }, ctxFor(alice.id)).then(() => null, (e: any) => e);
    expect(err?.extensions).toMatchObject({ code: 'ENTRY_CONDITION_FAILED', reason: 'MEMORY_UNREADABLE', messageId: 'chat-start.error.memory_unreadable', detail: {} });
    expect(await footprint()).toEqual(before);
    expect((await db.memory.findUniqueOrThrow({ where: { id: memory.id } })).deletedAt).toBeNull();
  });
});

describe('#4039 regression (2): no seq and no condition give exactly ruling 0127', () => {
  it('opens the lower loc and provisions as before', async () => {
    await seed([...conv('zeta'), ...conv('alpha')]);
    expect(await opened(alice.id)).toBe('alpha');
    expect(await sharedMemory()).not.toBeNull();
  });
});

describe('#4039 Q19: the fallback re-route walks the same order', () => {
  it('8: two conversations both matching: the lower seq wins, not the lower loc; the no-match default is the lower seq too', async () => {
    const signals = { goalSignals: ['mentor'] };
    await seed([
      ...conv('fallback', { flags: { isFallback: true } }),
      ...conv('alpha', { seq: 2, flags: signals }), ...conv('zeta', { seq: 1, flags: signals }),
    ]);
    const reroute = async (userMessage: string) => {
      const chat = await startShared(alice.id, { conversationName: 'fallback' });
      await M.sendChatMessage({}, { chatId: chat.chatId, userMessage }, ctxFor(alice.id));
      const node = await chatNodeByLoc(db, chat.chatId, { includeDeleted: true });
      const row = await db.chatRootEngineState.findUniqueOrThrow({ where: { chatRootNodeId: node!.id } });
      return (row.state as Record<string, unknown>).conversationName;
    };
    expect(await reroute('I need a mentor')).toBe('zeta');
    expect(await reroute('tell me something about everything')).toBe('zeta');
  });
});
