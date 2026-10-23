import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
/** #915 / cor:dmo:010:01: request-user audit is separate from Worker lineage and platform prose. */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { generateDataKey } from '../../../lib/crypto.js';
import { decryptNodeFields, encryptNodeFields } from '../../../lib/nodeCrypto.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));
const M = resolvers.Mutation;
let orgId: string, appId: string;
let alice: { id: string }, bob: { id: string }, outsider: { id: string };
let actors: { workerId: string; agentId: string }[];
const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] });
// Existing internal no-user branch: privileged App/system context, not a new public App-key entitlement.
const systemCtx = (): Context => ({ db, appId, roles: ['ADMIN'] });

beforeEach(async () => {
  await cleanDb(db);
  sessionKeyCache.clear();
  orgId = (await db.organization.create({ data: { name: 'Audit915', urn: `audit915-${generateId()}.example` } })).id;
  const user = () => db.user.create({ data: { handle: `audit-${generateId()}`, roles: ['READER'] } });
  [alice, bob, outsider] = await Promise.all([user(), user(), user()]);
  appId = (await db.app.create({ data: { organizationId: orgId, name: 'Audit', urn: `hrn:app:audit915:app-${generateId()}` } })).id;
  for (const u of [alice, bob]) {
    await db.orgMember.create({ data: { organizationId: orgId, userId: u.id, role: 'CONTRIBUTOR' } });
    await db.appMember.create({ data: { appId, userId: u.id, role: 'member' } });
  }
  actors = [];
  for (const name of ['Alpha', 'Beta']) {
    const agent = await db.agent.create({ data: { organizationId: orgId, name, urn: `hrn:agent:audit915:${name.toLowerCase()}-${generateId()}` } });
    await db.appAgent.create({ data: { appId, agentId: agent.id } });
    const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId, agentId: agent.id, name, slug: name.toLowerCase() } });
    actors.push({ workerId: worker.id, agentId: agent.id });
  }
});
afterEach(() => sessionKeyCache.clear());

async function host(encrypted = false) {
  const memory = await db.memory.create({ data: {
    organizationId: orgId, appId, class: 'app', name: 'Audit host', urn: `audit915:host-${generateId()}`,
    createdBy: alice.id, isEncrypted: encrypted, vectorIndexEnabled: false,
  } });
  if (encrypted) sessionKeyCache.set(`fixture-${memory.id}`, memory.id, generateDataKey());
  const chatId = `chats:audit-${generateId()}`;
  const enc = encryptNodeFields({ content: null, data: { scope: 'shared', userId: alice.id, messageCount: 0, stageName: 'scope', conversationName: 'audit' } }, memory);
  await db.node.create({ data: { memoryId: memory.id, loc: 'chats', name: 'Chats', nodeType: 'info' } });
  const chat = await db.node.create({ data: { memoryId: memory.id, loc: chatId, name: 'Chat', nodeType: 'info', createdBy: alice.id, data: enc.data as never } });
  await db.node.create({ data: { memoryId: memory.id, loc: `${chatId}:messages`, name: 'Messages', nodeType: 'info' } });
  return { memory, chatId, chat };
}
type Host = Awaited<ReturnType<typeof host>>;
const extract = (h: Host, c: Context, value = 'submitted-value') =>
  M.processChatResponse({}, { chatId: h.chatId, toolResponse: { message: 'platform words', data: { field: value } } }, c);
const summarize = (h: Host, c: Context, value = 'submitted-summary') => M.saveChatSummary({}, { chatId: h.chatId, summary: value }, c);
const dataOf = (h: Host) => db.node.findUniqueOrThrow({ where: { loc_memoryId: { memoryId: h.memory.id, loc: 'data' } } });
const summaryOf = (h: Host) => db.node.findFirstOrThrow({ where: { memoryId: h.memory.id, nodeType: 'abstract', tags: { has: 'summary' } } });
async function seedData(h: Host, createdBy: string | null, updatedBy: string | null = null) {
  const enc = encryptNodeFields({ content: null, data: { memoryWideKeys: ['field'], field: 'before' } }, h.memory);
  return db.node.create({ data: { memoryId: h.memory.id, loc: 'data', name: 'data', nodeType: 'info', createdBy, updatedBy, data: enc.data as never } });
}

describe('bounded chat audit stamps #915', () => {
  for (const encrypted of [false, true]) {
    const label = encrypted ? 'encrypted' : 'plaintext';
    it(`${label}: first extraction records the submitting user, not the chat/host creator`, async () => {
      const h = await host(encrypted);
      await extract(h, ctx(bob.id));
      const row = await dataOf(h);
      expect(row.createdBy).toBe(bob.id);
      expect((await db.node.findUniqueOrThrow({ where: { id: h.chat.id } })).createdBy).toBe(alice.id);
      if (encrypted) expect(row.data).toHaveProperty('__enc');
      decryptNodeFields(row, h.memory);
      expect(JSON.stringify(row.data)).toContain('submitted-value');
    });
    it(`${label}: extraction merge stamps the updater and preserves the creator`, async () => {
      const h = await host(encrypted);
      await seedData(h, alice.id);
      await extract(h, ctx(bob.id), 'merged-value');
      const row = await dataOf(h);
      expect(row).toMatchObject({ createdBy: alice.id, updatedBy: bob.id });
      if (encrypted) expect(row.data).toHaveProperty('__enc');
      decryptNodeFields(row, h.memory);
      expect(row.data).toMatchObject({ field: 'merged-value' });
    });
    it(`${label}: a supplied summary records its submitter, not the host owner`, async () => {
      const h = await host(encrypted);
      await summarize(h, ctx(bob.id));
      const row = await summaryOf(h);
      expect(row.createdBy).toBe(bob.id);
      if (encrypted) expect(row.content).not.toBe('submitted-summary');
      decryptNodeFields(row, h.memory);
      expect(row.content).toBe('submitted-summary');
    });
    it(`${label}: a denied request leaves data, audit stamps and message count untouched`, async () => {
      const h = await host(encrypted);
      const seeded = await seedData(h, outsider.id, alice.id); // creator provenance grants no access
      await expect(extract(h, ctx(outsider.id))).rejects.toThrow();
      await expect(summarize(h, ctx(outsider.id))).rejects.toThrow();
      expect(await dataOf(h)).toEqual(seeded);
      expect(await db.node.findUniqueOrThrow({ where: { id: h.chat.id } })).toEqual(h.chat);
      expect(await db.node.count({ where: { memoryId: h.memory.id, nodeType: 'abstract' } })).toBe(0);
    });
  }
  it('interleaved users and Workers keep user stamps and Worker/Agent lineage independent', async () => {
    const hosts = await Promise.all([host(), host()]);
    let arrived = 0;
    let release!: () => void;
    const both = new Promise<void>((resolve) => { release = resolve; });
    await Promise.all([alice, bob].map((user, index) => runAsActor(actors[index], async () => {
      if (++arrived === 2) release();
      await both;
      await extract(hosts[index], ctx(user.id));
      await summarize(hosts[index], ctx(user.id));
    })));
    for (const [index, user] of [alice, bob].entries()) {
      for (const row of [await dataOf(hosts[index]), await summaryOf(hosts[index])]) {
        expect(row).toMatchObject({ createdBy: user.id, createdByWorkerId: actors[index].workerId, createdByAgentId: actors[index].agentId });
      }
    }
  });
  it('interleaved merges retain each original creator and stamp the corresponding user/Worker editor', async () => {
    const hosts = await Promise.all([host(), host()]);
    for (const h of hosts) await seedData(h, alice.id);
    await Promise.all([alice, bob].map((user, index) => runAsActor(actors[index], () => extract(hosts[index], ctx(user.id)))));
    for (const [index, user] of [alice, bob].entries()) {
      expect(await dataOf(hosts[index])).toMatchObject({ createdBy: alice.id, updatedBy: user.id, updatedByWorkerId: actors[index].workerId, updatedByAgentId: actors[index].agentId });
    }
  });
  it('does not backfill a legacy unknown creator when a known user merges data', async () => {
    const h = await host();
    await seedData(h, null);
    await extract(h, ctx(bob.id));
    expect(await dataOf(h)).toMatchObject({ createdBy: null, updatedBy: bob.id });
  });
  it('an existing permitted no-user App/system request creates no invented human author', async () => {
    const h = await host();
    await extract(h, systemCtx());
    await summarize(h, systemCtx());
    expect((await dataOf(h)).createdBy).toBeNull();
    expect((await summaryOf(h)).createdBy).toBeNull();
  });
  it('a no-user merge clears an earlier human updater without inventing the chat creator', async () => {
    const h = await host();
    await seedData(h, alice.id, bob.id);
    await extract(h, systemCtx());
    expect(await dataOf(h)).toMatchObject({ createdBy: alice.id, updatedBy: null });
  });
  it('keeps platform-authored assistant words human-unstamped while usage records the triggering user', async () => {
    const h = await host();
    await M.processChatResponse({}, { chatId: h.chatId, toolResponse: { message: 'platform words' } }, ctx(bob.id));
    const assistant = await db.node.findFirstOrThrow({ where: { memoryId: h.memory.id, nodeType: 'record' } });
    expect(assistant.createdBy).toBeNull();
    const { drainNodeUsage } = await import('../../../lib/usageRecorder.js');
    await drainNodeUsage(db);
    expect(await db.usageEvent.findFirst({ where: { nodeId: assistant.id, type: 'write', userId: bob.id } })).not.toBeNull();
  });
  it('missing encryption key refuses before any content or stamp write', async () => {
    const h = await host(true);
    const seeded = await seedData(h, alice.id, bob.id);
    sessionKeyCache.clear();
    await expect(extract(h, ctx(bob.id))).rejects.toThrow(/SESSION_EXPIRED/);
    await expect(summarize(h, ctx(bob.id))).rejects.toThrow(/SESSION_EXPIRED/);
    expect(await dataOf(h)).toEqual(seeded);
    expect(await db.node.findUniqueOrThrow({ where: { id: h.chat.id } })).toEqual(h.chat);
  });
});
