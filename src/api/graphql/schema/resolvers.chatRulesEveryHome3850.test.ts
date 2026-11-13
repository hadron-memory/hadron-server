/**
 * #4038 (Know Yourself S5, #3850): completion/routing rules are evaluated in every chat home an Agent is reached
 * through (shared App memory, App-key session memory, per-user memory), under the install-and-licence check, and a
 * condition reads the SPEAKING member's own facts (#910). cor:cht:030:02, cor:acl:010:01, cor:acl:010:04 (C1).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '../../../generated/prisma/index.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { serveEveryAgent } from '../../../test/servedBootPrompt.js';
import { generateId } from '../../../lib/id.js';
import { deriveEdgeLoc } from '../../../lib/edgeLoc.js';
import { ensureAgentSubscription } from '../../../controller/operations/ensureAgentSubscription.js';
import { createDbAgentOrgGrant } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { compileTemplate } from '../../../lib/template.js';
import { buildPrismaMemoryLayer } from '../../../lib/edge-conditions/prisma-memory-layer.js';
import { dataViewFor, declaredMemoryWideFields } from '../../../lib/memoryDataView.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as any;
let orgId: string, adminId: string, aliceId: string, bobId: string, agentId: string, systemId: string, appId: string;
const as = (userId: string): Context => ({ db, roles: ['READER'], userId });

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'Rules everywhere', urn: 'rules3850.test' } });
  orgId = org.id;
  const mk = async (n: string, role: 'ADMIN' | 'CONTRIBUTOR') => {
    const u = await db.user.create({ data: { handle: `rules3850-${n}` } });
    await db.orgMember.create({ data: { organizationId: org.id, userId: u.id, role } });
    return u.id;
  };
  adminId = await mk('admin', 'ADMIN'); aliceId = await mk('alice', 'CONTRIBUTOR'); bobId = await mk('bob', 'CONTRIBUTOR');
  const agent = await M.createAgent({}, { orgId, name: 'Rules agent', visibility: 'ORGANIZATION' }, { db, roles: ['ADMIN'], userId: adminId });
  agentId = agent.id; systemId = agent.systemMemoryId;
  const app = await db.app.create({ data: { name: 'Rules app', urn: `${org.urn}:app`, organizationId: org.id } });
  appId = app.id;
  await db.appAgent.create({ data: { appId, agentId } });
  for (const u of [aliceId, bobId]) await db.appMember.create({ data: { appId, userId: u, role: 'member' } });
  const ids: Record<string, string> = {};
  for (const [loc, data, content] of [
    ['config', { agentExtractionSpec: [{ field: 'memory.region' }] }, null],
    ['conversations', {}, null],
    ['conversations:intake', { stageOrder: ['scope'], isSetup: false, extractionSpec: [{ field: 'industry' }] }, null],
    ['conversations:intake:scope', { promptRef: 'prompts:intake:scope' }, null],
    ['conversations:done', { stageOrder: ['end'], isSetup: false }, null],
    ['conversations:done:end', { promptRef: 'prompts:intake:scope' }, null],
    ['prompts', {}, null], ['prompts:intake', {}, null], ['prompts:intake:scope', {}, 'RULES STAGE'],
  ] as const) {
    ids[loc] = (await db.node.create({ data: { memoryId: systemId, loc, name: loc.split(':').pop()!, nodeType: 'system', data: data as never, content } })).id;
  }
  await db.edge.create({ data: {
    memoryId: systemId, loc: deriveEdgeLoc('conversations:intake:scope', 'route', 'conversations:done'), name: 'route',
    sourceId: ids['conversations:intake:scope'], targetId: ids['conversations:done'],
    data: { timing: 'on_complete', behavior: 'transition' },
    condition: { '==': [{ var: 'memory.industry' }, 'farming'] },
  } as never });
  await serveEveryAgent(db);
});

const startShared = (userId: string) => M.startChat({}, { agentId, scope: 'shared', conversationName: 'intake' }, as(userId));
const complete = (ctx: Context, chatId: string, data?: Record<string, unknown>) =>
  M.processChatResponse({}, { chatId, toolResponse: { message: 'ok', goal_reached: true, ...(data ? { data } : {}), onTrack: true } }, ctx);
const uninstall = () => db.appAgent.delete({ where: { appId_agentId: { appId, agentId } } });

// C1 (Vera, #103559): a non-manager member's turn after uninstall reads nothing from the Agent's system memory. Alice is an
// org CONTRIBUTOR, not a manager, so cor:dmo:050:13 does not excuse a read. Every read method of `db.node` and `db.edge`
// and the raw-SQL doors are spied and matched on the ids in their arguments; nothing is exempt: the memory-wide-field list is gated on the home App's licence too.
async function observeDefinitionReads<T>(run: () => Promise<T>) {
  const defIds = [systemId, ...(await db.node.findMany({ where: { memoryId: systemId }, select: { id: true } })).map((n) => n.id)];
  // Every read shape counts, not a few known ones: any call whose arguments mention the definition memory or one of its
  // nodes is a read of it, whatever the method (find*, count, aggregate, groupBy) or the table (node, edge, raw SQL).
  const reads = (['findFirst', 'findMany', 'findUnique', 'findUniqueOrThrow', 'findFirstOrThrow', 'count', 'aggregate', 'groupBy'] as const)
    .flatMap((m) => [['node', m], ['edge', m]] as const);
  const spies = reads.map(([t, m]) => ({ name: `${t}.${m}`, spy: vi.spyOn((db as any)[t], m) }));
  const rawSpies = (['$queryRaw', '$queryRawUnsafe'] as const).map((m) => ({ name: m, spy: vi.spyOn(db as any, m) }));
  const mentions = (args: unknown) => {
    const text = JSON.stringify(args, (_k, v) => (typeof v === 'bigint' ? String(v) : v)) ?? '';
    return defIds.some((id) => text.includes(id));
  };
  try {
    const value: any = await run();
    const seen = [...spies, ...rawSpies].flatMap(({ name, spy }) => spy.mock.calls.filter((c) => mentions(c)).map((c) => ({ name, args: c })));
    return { value, reads: seen };
  } finally { for (const { spy } of [...spies, ...rawSpies]) spy.mockRestore(); }
}

describe('#4038 shared chat', () => {
  it('a flagged completion fires the rule in a shared chat', async () => {
    const chat = await startShared(aliceId);
    const result = await complete(as(aliceId), chat.chatId, { industry: 'farming' });
    expect(result.conversationHandoff).toBe('done');
  });

  it('after the App uninstalls the Agent a shared turn fires no rule and reads no definition (edge or node), on send and response', async () => {
    const chat = await startShared(aliceId);
    await uninstall();
    const sent = await observeDefinitionReads(() => M.sendChatMessage({}, { chatId: chat.chatId, userMessage: 'after uninstall' }, as(aliceId)));
    expect(sent.value.systemMessage).toBe('');
    expect(sent.reads).toEqual([]);
    const done = await observeDefinitionReads(() => complete(as(aliceId), chat.chatId, { industry: 'farming' }));
    expect(done.value.conversationHandoff).toBeNull();
    expect(done.reads).toEqual([]);
  });

  it("member A's condition does not see member B's bucket", async () => {
    const chat = await startShared(aliceId);
    await M.processChatResponse({}, { chatId: chat.chatId, toolResponse: { message: 'ok', data: { industry: 'farming' }, next_stage: 'scope', onTrack: true } }, as(aliceId));
    // Bob speaks in the same shared chat: Alice's `industry` is not his, so the condition is false for him.
    expect((await complete(as(bobId), chat.chatId)).conversationHandoff).toBeNull();
    // Alice's own turn reads her own bucket.
    expect((await complete(as(aliceId), chat.chatId)).conversationHandoff).toBe('done');
  });
});

// A pure App key starts the chat in its session's memory but cannot address a chat by loc (chatLocFilter matches
// nothing without a user), so the turn that carries the rules is the memory's own user responding.
describe('#4038 App-key session memory', () => {
  async function sessionHome(memoryClass: 'personal') {
    const memory = await db.memory.create({ data: {
      name: 'session home', urn: `rules3850.test:session-${generateId()}`, ownerUserId: aliceId, class: memoryClass,
      userId: aliceId, appId, userMemoryOfAgentId: agentId, createdBy: aliceId,
    } as never });
    await ensureAgentSubscription(db, aliceId, agentId);
    const session = await db.session.create({ data: { id: generateId(), appId, agentId, userId: aliceId, memoryId: memory.id } as never });
    const keyCtx = { db, roles: ['READER'], appId, sessionId: session.id } as unknown as Context;
    return { memory, keyCtx };
  }

  it.each(['personal'] as const)('a chat in a %s session memory evaluates rules for a pure App key', async (cls) => {
    const { memory, keyCtx } = await sessionHome(cls);
    const chat = await M.startChat({}, { agentId, conversationName: 'intake' }, keyCtx);
    expect((await db.node.findUnique({ where: { loc_memoryId: { loc: chat.chatId, memoryId: memory.id } } }))?.id).toBeTruthy();
    // A pure key has no person: `industry` is not memory-wide, so use an always-true view by dropping the condition.
    await db.edge.updateMany({ where: { memoryId: systemId, loc: { contains: 'route' } }, data: { condition: Prisma.DbNull } });
    expect((await complete(as(aliceId), chat.chatId)).conversationHandoff).toBe('done');
  });

  it.each(['personal'] as const)('C1: after uninstall a %s session chat evaluates no rules and reads no definition, on send and response', async (cls) => {
    const { keyCtx } = await sessionHome(cls);
    const chat = await M.startChat({}, { agentId, conversationName: 'intake' }, keyCtx);
    await db.edge.updateMany({ where: { memoryId: systemId, loc: { contains: 'route' } }, data: { condition: Prisma.DbNull } });
    await uninstall();
    const sent = await observeDefinitionReads(() => M.sendChatMessage({}, { chatId: chat.chatId, userMessage: 'after uninstall' }, as(aliceId)));
    expect(sent.value.systemMessage).toBe('');
    expect(sent.reads).toEqual([]);
    const done = await observeDefinitionReads(() => complete(as(aliceId), chat.chatId));
    expect(done.value.conversationHandoff).toBeNull();
    expect(done.reads).toEqual([]);
  });
});

// C1 remedy (#4038, AT0.7083): the memory-wide field list is read from the Agent's definition, so it is gated on the
// HOME App's install-and-licence check, in the one shared helper, for every caller alike (no manager arm).
describe('#4038 C1 declared memory-wide fields follow the home App licence', () => {
  let shared: string;
  const stored = () => ({ region: 'EU', secret: 'flat-legacy', memoryWideKeys: ['secret'], users: { [aliceId]: { industry: 'farming' }, [bobId]: { industry: 'mining' } } });
  const view = (personId: string) => dataViewFor(db, shared, stored(), personId) as Promise<Record<string, unknown>>;
  beforeEach(async () => {
    await startShared(aliceId);
    shared = (await db.memory.findFirstOrThrow({ where: { appId, class: 'app' } })).id;
  });

  it('licensed: the declared field reads flat for everyone, each member also reads only their own', async () => {
    expect(await view(aliceId)).toMatchObject({ region: 'EU', secret: 'flat-legacy', industry: 'farming' });
    expect(await view(bobId)).toMatchObject({ region: 'EU', secret: 'flat-legacy', industry: 'mining' });
    expect((await view(bobId)).industry).not.toBe('farming');
  });

  it.each([
    ['uninstall', () => uninstall()],
    ['App marked uninstalled', () => db.app.update({ where: { id: appId }, data: { uninstalledAt: new Date() } })],
  ])('after %s: no declared field, zero system-node reads, own values and memoryWideKeys still read, for a member and a manager alike', async (_n, lapse) => {
    await lapse();
    for (const who of [aliceId, bobId, adminId]) {
      const seen = await observeDefinitionReads(() => view(who));
      expect(seen.reads).toEqual([]);
      expect(seen.value).not.toHaveProperty('region');
      expect(seen.value).toMatchObject({ secret: 'flat-legacy' });
    }
    expect(await view(aliceId)).toMatchObject({ industry: 'farming' });
    expect(await view(bobId)).toMatchObject({ industry: 'mining' });
  });

  it('reinstalling restores the declared list with no rewrite', async () => {
    await uninstall();
    expect(await view(aliceId)).not.toHaveProperty('region');
    await db.appAgent.create({ data: { appId, agentId } });
    expect(await view(aliceId)).toMatchObject({ region: 'EU' });
  });

  it('a template render and a condition read follow the same gate', async () => {
    await db.node.create({ data: { memoryId: shared, loc: 'data', name: 'data', nodeType: 'data', data: stored() as never } });
    const render = () => compileTemplate('{{region}}|{{industry}}|{{secret}}', null, shared, db, {}, aliceId);
    const cond = async () => (await (await buildPrismaMemoryLayer(db, 'memory', shared, '', aliceId)).read('region')) as { value?: unknown };
    expect(await render()).toBe('EU|farming|flat-legacy');
    expect((await cond()).value).toBe('EU');
    await uninstall();
    expect(await render()).toBe('|farming|flat-legacy');
    expect((await cond()).value).toBeUndefined();
  });

  it('a memory with no home App fails closed without a database read', async () => {
    const spy = vi.spyOn(db.agent, 'findUnique');
    const memory = { id: shared, class: 'app', appId: null, sharedMemoryOfAgentId: agentId, userMemoryOfAgentId: null };
    expect((await declaredMemoryWideFields(db, memory)).size).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

// Baloo's P2 and Betty's P2 (#4114 LOCAL and BLIND): a lapsed LICENCE is a foreign-org Agent whose AgentOrgGrant is no longer
// usable while the App is live and the Agent still installed. An install-only decision (the AppAgent row plus a live App)
// passes every case above; these fail it.
describe('#4038 C1 a lapsed AgentOrgGrant (live App, Agent still installed)', () => {
  let holderId: string, shared: string;
  const stored = () => ({ region: 'EU', secret: 'flat-legacy', memoryWideKeys: ['secret'], users: { [aliceId]: { industry: 'farming' }, [bobId]: { industry: 'mining' } } });
  const view = (personId: string) => dataViewFor(db, shared, stored(), personId) as Promise<Record<string, unknown>>;
  const lapse = (state: 'revoked' | 'expired' | 'inactive') => db.agentOrgGrant.update({
    where: { orgId_agentId: { orgId: holderId, agentId } },
    data: state === 'revoked' ? { revokedAt: new Date() } : state === 'expired' ? { expiresAt: new Date(0) } : { activatedAt: null },
  });
  const renew = () => db.agentOrgGrant.update({ where: { orgId_agentId: { orgId: holderId, agentId } }, data: { revokedAt: null, expiresAt: null, activatedAt: new Date() } });

  beforeEach(async () => {
    // The Agent stays in its own org; the App moves to a holder org, so the Agent is foreign to it and only a grant licenses it.
    const holder = await db.organization.create({ data: { name: 'Holder', urn: 'holder4038.test' } });
    holderId = holder.id;
    for (const u of [adminId, aliceId, bobId]) await db.orgMember.create({ data: { organizationId: holderId, userId: u, role: u === adminId ? 'ADMIN' : 'CONTRIBUTOR' } });
    await db.app.update({ where: { id: appId }, data: { organizationId: holderId } });
    await createDbAgentOrgGrant(db, holderId, agentId);
    await startShared(aliceId);
    shared = (await db.memory.findFirstOrThrow({ where: { appId, class: 'app' } })).id;
  });

  it('control: the foreign Agent under an active grant is licensed and reads its declared field', async () => {
    expect(await view(bobId)).toMatchObject({ region: 'EU' });
  });

  it.each(['revoked', 'expired', 'inactive'] as const)('a %s grant: declared field gone for every reader, zero definition reads, own values and memoryWideKeys stay, renewal restores', async (state) => {
    await lapse(state);
    for (const who of [aliceId, bobId, adminId]) {
      const seen = await observeDefinitionReads(() => view(who));
      expect(seen.reads).toEqual([]);
      expect(seen.value).not.toHaveProperty('region');
      expect(seen.value).toMatchObject({ secret: 'flat-legacy' });
    }
    expect(await view(aliceId)).toMatchObject({ industry: 'farming' });
    await renew();
    expect(await view(bobId)).toMatchObject({ region: 'EU' });
  });

  it.each(['revoked', 'expired', 'inactive'] as const)('a %s grant: shared extraction reads no definition and files the declared field under the speaker, not flat; renewal restores Bob\'s view of the old flat value', async (state) => {
    const chat = await startShared(aliceId);
    await complete(as(aliceId), chat.chatId, { region: 'EU' });
    expect(((await db.node.findFirstOrThrow({ where: { memoryId: shared, loc: 'data' } })).data as any).region).toBe('EU');
    await lapse(state);
    const done = await observeDefinitionReads(() => complete(as(aliceId), chat.chatId, { region: 'XX' }));
    expect(done.reads).toEqual([]);
    const data = (await db.node.findFirstOrThrow({ where: { memoryId: shared, loc: 'data' } })).data as any;
    expect(data.region).toBe('EU');
    expect(data.users[aliceId].region).toBe('XX');
    expect(data.users[bobId]?.region).toBeUndefined();
    expect(await dataViewFor(db, shared, data, bobId)).not.toHaveProperty('region');
    await renew();
    expect(await dataViewFor(db, shared, data, bobId)).toMatchObject({ region: 'EU' });
  });
});
