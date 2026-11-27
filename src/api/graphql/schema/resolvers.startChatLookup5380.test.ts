/**
 * #5380 (hrn:node:hadronmemory.com:specs:cor:cht:010:02): with no scope, startChat's per-user lookup (the memories
 * stamped with the Agent and created by the caller) picked whichever row came first, a private-class memory included.
 * A private memory is never a chat home (scope private admits personal and knowledge), so the start succeeded and every
 * sendChatMessage was refused CHAT_MEMORY_OUT_OF_SCOPE. Pins, red first on main 884292f3 where marked:
 *   - (a) a private memory only: the start never lands there and the send works (red);
 *   - (b) a private and a personal memory: the personal one, every time (red);
 *   - (c) a personal memory only: unchanged;
 *   - (d) the private memory is untouched: no chat root is written there (red, inside (a) and (b));
 *   - controls: another person's memory and a deleted one are not picked; a stamped knowledge home (the no-App manager
 *     route's) is found again, not provisioned a second time; a personal memory wins over it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, chatNodeByLocOrThrow } from '../../../test/helpers.js';
import { serveEveryAgent } from '../../../test/servedBootPrompt.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as any;
let orgId: string, orgUrn: string, appId: string, agentId: string, systemId: string;
let ann: string, bob: string, adminId: string;
const as = (userId: string): Context => ({ db, userId, roles: ['READER'] } as Context);

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'Lookup', urn: 'chat5380.test' } });
  orgId = org.id; orgUrn = org.urn;
  const admin = (await db.user.create({ data: { handle: 'admin5380' } })).id;
  adminId = admin;
  ann = (await db.user.create({ data: { handle: 'ann5380' } })).id;
  bob = (await db.user.create({ data: { handle: 'bob5380' } })).id;
  await db.orgMember.create({ data: { organizationId: orgId, userId: admin, role: 'ADMIN' } });
  for (const u of [ann, bob]) await db.orgMember.create({ data: { organizationId: orgId, userId: u, role: 'CONTRIBUTOR' } });
  const agent = await M.createAgent({}, { orgRef: orgId, name: 'Lookup agent', visibility: 'ORGANIZATION' }, { db, userId: admin, roles: ['ADMIN'] });
  agentId = agent.id; systemId = agent.systemMemoryId;
  appId = (await db.app.create({ data: { name: 'Tutor', urn: `${orgUrn}:tutor`, organizationId: orgId } })).id;
  await db.appAgent.create({ data: { appId, agentId } });
  for (const u of [ann, bob]) await db.appMember.create({ data: { appId, userId: u, role: 'member' } });
  await seedFlow(systemId);
  await serveEveryAgent(db);
});

const seedFlow = async (memoryId: string) => {
  for (const row of [
    { loc: 'conversations', data: {} },
    { loc: 'conversations:flow', data: { stageOrder: ['step'], isSetup: false } },
    { loc: 'conversations:flow:step', data: { promptRef: 'prompts:step' } },
    { loc: 'prompts', data: {} },
    { loc: 'prompts:step', content: 'LOOKUP STAGE', data: {} },
  ]) await db.node.create({ data: { memoryId, name: row.loc, nodeType: 'system', ...row } });
};

const start = (userId: string) => M.startChat({}, { agentRef: agentId, conversationName: 'flow' }, as(userId));
const homeOf = async (chatId: string) => (await chatNodeByLocOrThrow(db, chatId)).memoryId as string;
const startAndSend = async (userId: string) => {
  const started = await start(userId);
  await M.sendChatMessage({}, { chatId: started.chatId, userMessage: 'hello' }, as(userId));
  return homeOf(started.chatId);
};
const appMemory = async (memoryClass: 'personal' | 'private', userId = ann) =>
  (await M.createMemoryInApp({}, { appRef: appId, agentRef: agentId, memoryClass }, as(userId))).id as string;
const nodesIn = (memoryId: string) => db.node.count({ where: { memoryId } });

describe('#5380 startChat never picks a private-class memory as the per-user home', () => {
  it('(a)+(d) a private memory only: the chat starts in a personal home, the send works, the private memory is untouched', async () => {
    const priv = await appMemory('private');
    const before = await nodesIn(priv);
    const home = await startAndSend(ann);
    expect(home).not.toBe(priv);
    const row = await db.memory.findUniqueOrThrow({ where: { id: home } });
    expect({ class: row.class, userId: row.userId, appId: row.appId }).toEqual({ class: 'personal', userId: ann, appId });
    expect(await nodesIn(priv)).toBe(before);
  });

  it('(b)+(d) a private and a personal memory: the personal one, every time', async () => {
    const priv = await appMemory('private');
    const personal = await appMemory('personal');
    const before = await nodesIn(priv);
    for (let i = 0; i < 3; i++) expect(await startAndSend(ann)).toBe(personal);
    expect(await nodesIn(priv)).toBe(before);
  });

  it('(b) the same with the private memory made last', async () => {
    const personal = await appMemory('personal');
    await appMemory('private');
    for (let i = 0; i < 3; i++) expect(await startAndSend(ann)).toBe(personal);
  });

  it('(c) a personal memory only: unchanged', async () => {
    const personal = await appMemory('personal');
    expect(await startAndSend(ann)).toBe(personal);
  });
});

describe('#5380 controls', () => {
  it('another person\'s personal memory is not picked', async () => {
    const bobs = await appMemory('personal', bob);
    const home = await startAndSend(ann);
    expect(home).not.toBe(bobs);
    expect((await db.memory.findUniqueOrThrow({ where: { id: home } })).userId).toBe(ann);
  });

  it('a deleted personal memory is not picked', async () => {
    const gone = await appMemory('personal');
    await db.memory.update({ where: { id: gone }, data: { deletedAt: new Date() } });
    expect(await startAndSend(ann)).not.toBe(gone);
  });

  it('a stamped knowledge home (the no-App manager route) is found again, not provisioned a second time', async () => {
    // An Agent no App installs: its manager's first start provisions a knowledge home stamped with the Agent.
    const solo = await M.createAgent({}, { orgRef: orgId, name: 'Solo agent', visibility: 'ORGANIZATION' }, { db, userId: adminId, roles: ['ADMIN'] });
    await seedFlow(solo.systemMemoryId);
    await serveEveryAgent(db);
    const startSolo = () => M.startChat({}, { agentRef: solo.id, conversationName: 'flow' }, { db, userId: adminId, roles: ['ADMIN'] } as Context);
    const first = await homeOf((await startSolo()).chatId);
    const row = await db.memory.findUniqueOrThrow({ where: { id: first } });
    expect({ class: row.class, userMemoryOfAgentId: row.userMemoryOfAgentId }).toEqual({ class: 'knowledge', userMemoryOfAgentId: solo.id });
    const memories = await db.memory.count();
    expect(await homeOf((await startSolo()).chatId)).toBe(first);
    expect(await db.memory.count()).toBe(memories);
  });
  it('a personal memory wins over a stamped knowledge home, whichever is older', async () => {
    const solo = await M.createAgent({}, { orgRef: orgId, name: 'Solo agent', visibility: 'ORGANIZATION' }, { db, userId: adminId, roles: ['ADMIN'] });
    await seedFlow(solo.systemMemoryId);
    await serveEveryAgent(db);
    const adminCtx = { db, userId: adminId, roles: ['ADMIN'] } as Context;
    const startSolo = () => M.startChat({}, { agentRef: solo.id, conversationName: 'flow' }, adminCtx);
    const knowledge = await homeOf((await startSolo()).chatId);
    // The Agent is installed in the App later and its manager makes a personal memory there.
    await db.appAgent.create({ data: { appId, agentId: solo.id } });
    await db.appMember.create({ data: { appId, userId: adminId, role: 'member' } });
    const personal = (await M.createMemoryInApp({}, { appRef: appId, agentRef: solo.id, memoryClass: 'personal' }, adminCtx)).id as string;
    expect(personal).not.toBe(knowledge);
    expect(await homeOf((await startSolo()).chatId)).toBe(personal);
  });
});

describe('#5380 the order within one class is deterministic (LOCAL P3-1 on #5382, Babaya; added with #5027)', () => {
  it('two stamped personal memories: the older one wins even when the newer row was inserted first', async () => {
    // Inserted newest-first, so heap order alone (an unordered or descending pick) returns the newer row.
    const personalRow = (urn: string, createdAt: Date) => db.memory.create({ data: {
      class: 'personal', name: urn, urn: `ann5380:${urn}`, appId, userId: ann, ownerUserId: ann, createdBy: ann,
      userMemoryOfAgentId: agentId, appUserMemory: true, createdAt,
    } });
    const newer = await personalRow('newer', new Date('2026-06-01T00:00:00Z'));
    const older = await personalRow('older', new Date('2026-01-01T00:00:00Z'));
    expect(newer.id).not.toBe(older.id);
    for (let i = 0; i < 2; i++) expect(await homeOf((await start(ann)).chatId)).toBe(older.id);
  });
});
