/**
 * #1349 Slice 1 — a legacy AgentMemoryItem is honoured only up to what the
 * memory's own access rules allow. An item is a LIMIT, never a grant
 * (cor:dmo:050:09; Holger "A", team chat #13055), and PUBLIC widens who may
 * READ a knowledge memory, never who may write it (cor:acl:010:01; Holger "A",
 * team chat #13052).
 *
 * #1357 gated NEW attaches. These rows are inserted directly, the way a row
 * minted before that gate exists, so every case here is a legacy row. Each
 * asserts what the agent's App key can actually do, over GraphQL and MCP, and
 * that a refused write leaves the node unchanged.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../../server.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb, createDbAppWithKey, createDbAppAgent, createDbAppMember } from '../helpers.js';
import { generateId } from '../../lib/id.js';
import { createTestableMcpServer } from '../../mcp/server.js';
import { getAppMemoryAccess, getPrincipalAppMemoryAccess } from '../../mcp/access-control.js';
import { sharedChatKnowledgeMemoryIds } from '../../api/graphql/schema/chat-scope.js';
import { sessionScopedMemoryIds } from '../../lib/auth/sessionScopedMemoryIds.js';
import { resolveAssetTargetMemoryId } from '../../api/graphql/schema/resolvers.helpers.js';
import { resolvers } from '../../api/graphql/schema/resolvers.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

type Gql = { data: Record<string, any> | null | undefined; errors: Array<{ message: string }> | undefined };

const READ = `query($r: ID!) { node(ref: $r) { content } }`;
const WRITE = `mutation($i: UpdateNodeInput!) { updateNode(input: $i) { id } }`;
const LIST = `query($m: ID!) { memoryNodes(memoryRef: $m) { total } }`;

let server: Server;
let baseUrl: string;
let suffix: string;
let homeOrgId: string;
let foreignOrgId: string;
const mem: Record<string, { id: string; urn: string; nodeId: string; content: string }> = {};

async function gql(key: string, query: string, variables: Record<string, unknown>): Promise<Gql> {
  const response = await fetch(`${baseUrl}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await response.json()) as { data?: Record<string, any> | null; errors?: Gql['errors'] };
  return { data: body.data, errors: body.errors };
}

/** A fresh agent in a fresh App of the HOME org, linked to `target` by a legacy row. */
async function legacyLink(target: string, role: string, opts: { createdBy?: string | null } = {}) {
  const label = `${target}-${role}-${Math.floor(Math.random() * 1e9)}`;
  const agent = await db.agent.create({
    data: { id: generateId(), organizationId: homeOrgId, name: label, urn: `ag-${label}-${suffix}` } as never,
  });
  const { app, rawKey } = await createDbAppWithKey(db, `app-${label}`, homeOrgId);
  await createDbAppAgent(db, app.id, agent.id);
  await db.agentMemoryItem.create({
    data: { id: generateId(), agentId: agent.id, memoryId: mem[target]!.id, role, createdBy: opts.createdBy ?? null } as never,
  });
  return { appId: app.id, agentId: agent.id, appKey: rawKey };
}

const reads = async (appKey: string, target: string) =>
  (await gql(appKey, READ, { r: mem[target]!.nodeId })).data?.node?.content ?? null;

async function writes(appKey: string, target: string) {
  const r = await gql(appKey, WRITE, { i: { id: mem[target]!.nodeId, content: `tampered-${Math.random()}` } });
  const after = await db.node.findUniqueOrThrow({ where: { id: mem[target]!.nodeId } });
  if (r.errors) expect(after.content).toBe(mem[target]!.content);
  else await db.node.update({ where: { id: after.id }, data: { content: mem[target]!.content } });
  return !r.errors;
}

const lists = async (appKey: string, target: string) =>
  ((await gql(appKey, LIST, { m: mem[target]!.urn })).data?.memoryNodes?.total ?? 0) > 0;

const mcpFor = (appId: string, userId?: string) => createTestableMcpServer({ appId, userId, roles: ['READER'] });

/** #1376: an App member (a user behind the App), the principal that still reaches memory through the agent's items. */
async function memberOf(appId: string) {
  const user = await db.user.create({ data: { id: generateId(), handle: `am-${generateId()}`, githubUsername: `am-${generateId()}` } });
  await createDbAppMember(db, appId, user.id, 'member');
  return user.id;
}
const nodeUrn = (target: string) => `hrn:node:${mem[target]!.urn.replace(/^hrn:mem:/, '')}:payroll`;

async function mcpReads(appId: string, target: string, userId?: string) {
  const text = await mcpFor(appId, userId).callToolText('hadron_get_node', { urn: nodeUrn(target) });
  return text.includes(mem[target]!.content);
}

async function mcpWrites(appId: string, target: string, userId?: string) {
  const text = await mcpFor(appId, userId).callToolText('hadron_update_node', { urn: nodeUrn(target), content: 'mcp-tampered' });
  const after = await db.node.findUniqueOrThrow({ where: { id: mem[target]!.nodeId } });
  const wrote = after.content === 'mcp-tampered';
  if (wrote) await db.node.update({ where: { id: after.id }, data: { content: mem[target]!.content } });
  else expect(text).not.toContain(mem[target]!.content);
  return wrote;
}

beforeAll(async () => {
  await cleanDb(db);
  suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  const mkOrg = (label: string) =>
    db.organization.create({ data: { id: generateId(), name: label, urn: `${label}-${suffix}` } });
  const home = await mkOrg('home');
  const foreign = await mkOrg('foreign');
  homeOrgId = home.id;
  foreignOrgId = foreign.id;
  const owner = await db.user.create({ data: { id: generateId(), handle: `owner-${suffix}`, githubUsername: `owner-${suffix}` } });

  const mkMem = async (label: string, urnRoot: string, data: Record<string, unknown>) => {
    const m = await db.memory.create({ data: { id: generateId(), urn: `${urnRoot}:${label}`, name: label, ...data } as never });
    const content = `${label} SECRET`;
    const n = await db.node.create({ data: { id: generateId(), memoryId: m.id, loc: 'payroll', name: 'p', content } });
    mem[label] = { id: m.id, urn: `hrn:mem:${urnRoot}:${label}`, nodeId: n.id, content };
  };
  await mkMem('foreignOrg', foreign.urn, { organizationId: foreign.id, class: 'knowledge', visibility: 'ORGANIZATION' });
  await mkMem('foreignPublic', foreign.urn, { organizationId: foreign.id, class: 'knowledge', visibility: 'PUBLIC' });
  await mkMem('foreignGroup', foreign.urn, { organizationId: foreign.id, class: 'group', visibility: 'GROUP' });
  await mkMem('foreignPersonal', foreign.urn, { class: 'personal', visibility: null, userId: owner.id, ownerUserId: owner.id });
  await mkMem('foreignSubscribed', foreign.urn, { organizationId: foreign.id, class: 'knowledge', visibility: 'PUBLIC' });
  await mkMem('foreignRevoked', foreign.urn, { organizationId: foreign.id, class: 'knowledge', visibility: 'PUBLIC' });
  await mkMem('homeOrg', home.urn, { organizationId: home.id, class: 'knowledge', visibility: 'ORGANIZATION' });
  await mkMem('homePublic', home.urn, { organizationId: home.id, class: 'knowledge', visibility: 'PUBLIC' });
  // The home org subscribes to two foreign PUBLIC memories at CONTRIBUTOR (read-write);
  // the second subscription is revoked.
  await db.memorySubscription.create({ data: { memoryId: mem.foreignSubscribed!.id, organizationId: home.id, role: 'CONTRIBUTOR' } as never });
  await db.memorySubscription.create({
    data: { memoryId: mem.foreignRevoked!.id, organizationId: home.id, role: 'CONTRIBUTOR', deletedAt: new Date() } as never,
  });

  // An ORGANIZATION memory a THIRD org subscribes to: someone else's subscription is no reach for home.
  const third = await mkOrg('third');
  await mkMem('foreignThirdSub', foreign.urn, { organizationId: foreign.id, class: 'knowledge', visibility: 'ORGANIZATION' });
  await db.memorySubscription.create({ data: { memoryId: mem.foreignThirdSub!.id, organizationId: third.id, role: 'CONTRIBUTOR' } as never });

  const app = await createServer();
  server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

describe('#1349 Slice 1 — a legacy link to another tenant grants nothing it could not reach', () => {
  it.each(['read', 'read-write'])('cross-tenant ORGANIZATION knowledge, %s: no read, no list, no write — GraphQL', async (role) => {
    const { appKey } = await legacyLink('foreignOrg', role);
    expect(await reads(appKey, 'foreignOrg')).toBeNull();
    expect(await lists(appKey, 'foreignOrg')).toBe(false);
    expect(await writes(appKey, 'foreignOrg')).toBe(false);
  });

  it.each(['read', 'read-write'])('cross-tenant ORGANIZATION knowledge, %s: no read, no write — MCP', async (role) => {
    const { appId } = await legacyLink('foreignOrg', role);
    expect(await mcpReads(appId, 'foreignOrg')).toBe(false);
    expect(await mcpWrites(appId, 'foreignOrg')).toBe(false);
  });

  it('cross-tenant PUBLIC knowledge, read-write: the public read stays, the write is refused', async () => {
    const { appId, appKey } = await legacyLink('foreignPublic', 'read-write');
    expect(await reads(appKey, 'foreignPublic')).toBe('foreignPublic SECRET');
    expect(await mcpReads(appId, 'foreignPublic')).toBe(true);
    expect(await writes(appKey, 'foreignPublic')).toBe(false);
    expect(await mcpWrites(appId, 'foreignPublic')).toBe(false);
    expect((await getAppMemoryAccess(db, appId)).get(mem.foreignPublic!.id)).toBe('READ_ONLY');
  });

  it('a foreign group memory: membership is MemoryMember only, so the link grants nothing', async () => {
    const { appId, appKey } = await legacyLink('foreignGroup', 'read-write');
    expect(await reads(appKey, 'foreignGroup')).toBeNull();
    expect(await writes(appKey, 'foreignGroup')).toBe(false);
    expect((await getAppMemoryAccess(db, appId)).has(mem.foreignGroup!.id)).toBe(false);
  });

  it('another user\'s personal memory: nothing, as before', async () => {
    const { appId, appKey } = await legacyLink('foreignPersonal', 'read-write');
    expect(await reads(appKey, 'foreignPersonal')).toBeNull();
    expect(await writes(appKey, 'foreignPersonal')).toBe(false);
    expect(await mcpReads(appId, 'foreignPersonal')).toBe(false);
  });

  it('a row with no attributable creator gains nothing from being anonymous', async () => {
    const { appKey } = await legacyLink('foreignOrg', 'read-write', { createdBy: null });
    expect(await reads(appKey, 'foreignOrg')).toBeNull();
    expect(await writes(appKey, 'foreignOrg')).toBe(false);
  });

  it('the access map is capped: no cross-tenant entry, and PUBLIC only READ_ONLY', async () => {
    const { appId } = await legacyLink('foreignOrg', 'read-write');
    expect((await getAppMemoryAccess(db, appId)).has(mem.foreignOrg!.id)).toBe(false);
  });
});

describe('#1349 Slice 1 — the link still caps what the App reaches on its own', () => {
  it('home ORGANIZATION knowledge, read-write: an App member reads and writes; the bare key does neither (#1376)', async () => {
    const { appId, appKey } = await legacyLink('homeOrg', 'read-write');
    expect(await reads(appKey, 'homeOrg')).toBeNull();
    expect(await writes(appKey, 'homeOrg')).toBe(false);
    const userId = await memberOf(appId);
    expect(await mcpReads(appId, 'homeOrg', userId)).toBe(true);
    expect(await mcpWrites(appId, 'homeOrg', userId)).toBe(true);
  });

  it('home ORGANIZATION knowledge, read: an App member reads, and the link still caps the write; the bare key reads nothing (#1376)', async () => {
    const { appId, appKey } = await legacyLink('homeOrg', 'read');
    expect(await reads(appKey, 'homeOrg')).toBeNull();
    expect(await writes(appKey, 'homeOrg')).toBe(false);
    const userId = await memberOf(appId);
    expect(await mcpReads(appId, 'homeOrg', userId)).toBe(true);
    expect(await mcpWrites(appId, 'homeOrg', userId)).toBe(false);
  });

  it('home PUBLIC knowledge, read-write: the bare key reads and no longer writes (#1376); an App member writes it', async () => {
    const { appId, appKey } = await legacyLink('homePublic', 'read-write');
    expect(await reads(appKey, 'homePublic')).toBe('homePublic SECRET');
    expect(await writes(appKey, 'homePublic')).toBe(false);
    expect(await mcpWrites(appId, 'homePublic', await memberOf(appId))).toBe(true);
  });

  it('an invalid stored role grants nothing, even on a memory the App could reach', async () => {
    const { appId, appKey } = await legacyLink('homeOrg', 'admin');
    expect((await getAppMemoryAccess(db, appId)).has(mem.homeOrg!.id)).toBe(false);
    expect(await writes(appKey, 'homeOrg')).toBe(false);
  });
});

describe('#1349 Slice 1 — a subscribed memory (Vera\'s control)', () => {
  it('a live CONTRIBUTOR subscription is independent reach: the read-write link reads and writes it', async () => {
    const { appId, appKey } = await legacyLink('foreignSubscribed', 'read-write');
    // #1376: a bare key gets no item-derived reach, and a subscription is the org's, not the key's; a user behind the App does.
    expect(await reads(appKey, 'foreignSubscribed')).toBe('foreignSubscribed SECRET');
    expect(await writes(appKey, 'foreignSubscribed')).toBe(false);
    const userId = await memberOf(appId);
    expect((await getPrincipalAppMemoryAccess(db, { appId, userId })).get(mem.foreignSubscribed!.id)).toBe('READ_WRITE');
    expect(await mcpWrites(appId, 'foreignSubscribed', userId)).toBe(true);
  });

  it('a read link on a subscribed memory still caps the write', async () => {
    const { appKey } = await legacyLink('foreignSubscribed', 'read');
    expect(await writes(appKey, 'foreignSubscribed')).toBe(false);
  });

  it("another organization's subscription is no reach for this agent's tenant", async () => {
    const { appId, appKey } = await legacyLink('foreignThirdSub', 'read-write');
    expect(await reads(appKey, 'foreignThirdSub')).toBeNull();
    expect(await writes(appKey, 'foreignThirdSub')).toBe(false);
    expect((await getAppMemoryAccess(db, appId)).has(mem.foreignThirdSub!.id)).toBe(false);
  });

  it('a revoked subscription is no reach: the PUBLIC read stays, the write goes', async () => {
    const { appId, appKey } = await legacyLink('foreignRevoked', 'read-write');
    expect(await reads(appKey, 'foreignRevoked')).toBe('foreignRevoked SECRET');
    expect((await getAppMemoryAccess(db, appId)).get(mem.foreignRevoked!.id)).toBe('READ_ONLY');
    expect(await writes(appKey, 'foreignRevoked')).toBe(false);
  });
});

/** Give an agent a minimal conversation, so startChat reaches its target-memory choice. */
async function giveConversation(agentId: string) {
  const sys = await db.memory.create({
    data: { id: generateId(), urn: `home-${suffix}:sys-${generateId()}`, name: 'sys', organizationId: homeOrgId, class: 'system' } as never,
  });
  await db.agent.update({ where: { id: agentId }, data: { systemMemoryId: sys.id } as never });
  for (const [loc, data, content] of [
    ['conversations', null, null],
    ['conversations:c', { stageOrder: ['s'], isSetup: false }, null],
    ['conversations:c:s', { promptRef: 'prompts:c:s' }, null],
    ['prompts', null, null], ['prompts:c', null, null], ['prompts:c:s', null, 'Hi.'],
  ] as const) {
    await db.node.create({ data: { id: generateId(), memoryId: sys.id, loc, name: loc.split(':').pop()!, nodeType: 'system', data: data as never, content } });
  }
}

describe('#1349 Slice 1 — the folds that read links directly use the same cap', () => {
  it('shared-chat grounding: a foreign ORG link grounds nothing; PUBLIC and home links still do', async () => {
    const foreign = await legacyLink('foreignOrg', 'read');
    const pub = await legacyLink('foreignPublic', 'read');
    const home = await legacyLink('homeOrg', 'read');
    const owner = await db.user.create({ data: { id: generateId(), handle: `g-${generateId()}`, githubUsername: `g-${generateId()}` } });
    expect(await sharedChatKnowledgeMemoryIds(db, foreign.agentId, foreign.appId, owner.id)).toEqual([]);
    expect(await sharedChatKnowledgeMemoryIds(db, pub.agentId, pub.appId, owner.id)).toEqual([mem.foreignPublic!.id]);
    expect(await sharedChatKnowledgeMemoryIds(db, home.agentId, home.appId, owner.id)).toEqual([mem.homeOrg!.id]);
  });

  it('session scope: a session naming a foreign ORG memory through its agent link admits nothing', async () => {
    for (const [target, admitted] of [['foreignOrg', false], ['homeOrg', false]] as const) {
      // #1376: every caller is a userless key, for which an item never admits (Dara, P2)
      const { appId, agentId } = await legacyLink(target, 'read-write');
      const session = await db.session.create({
        data: { id: generateId(), appId, agentId, memoryId: mem[target]!.id } as never,
      });
      expect((await sessionScopedMemoryIds(db, appId, session.id)).includes(mem[target]!.id)).toBe(admitted);
    }
  });

  it('asset upload target: a foreign read-write link is never the target; a home one is', async () => {
    const owner = await db.user.create({ data: { id: generateId(), handle: `a-${generateId()}`, githubUsername: `a-${generateId()}` } });
    for (const target of ['foreignOrg', 'foreignPublic']) {
      const { agentId } = await legacyLink(target, 'read-write');
      await expect(resolveAssetTargetMemoryId(db, agentId, owner.id)).rejects.toThrow(/NO_TARGET_MEMORY/);
    }
    const { agentId } = await legacyLink('homeOrg', 'read-write');
    expect(await resolveAssetTargetMemoryId(db, agentId, owner.id)).toEqual({ memoryId: mem.homeOrg!.id });
  });

  it("legacy startChat target: never another user's personal memory through a read-write link (Colin, P2)", async () => {
    const link = await legacyLink('foreignPersonal', 'read-write');
    await giveConversation(link.agentId);
    const before = await db.node.count({ where: { memoryId: mem.foreignPersonal!.id } });
    const response = await gql(link.appKey, 'mutation($agent: ID!) { startChat(agentId: $agent) { chatId } }', { agent: link.agentId });
    expect(response.errors, JSON.stringify(response)).toBeDefined();
    expect(await db.node.count({ where: { memoryId: mem.foreignPersonal!.id } })).toBe(before);
  });

  it('#1376 legacy startChat: a bare key writes nothing into org knowledge through a read-write item (Riana, P2 1)', async () => {
    const link = await legacyLink('homeOrg', 'read-write');
    await giveConversation(link.agentId);
    const before = await db.node.count({ where: { memoryId: mem.homeOrg!.id } });
    const response = await gql(link.appKey, 'mutation($agent: ID!) { startChat(agentId: $agent) { chatId } }', { agent: link.agentId });
    expect(response.errors, JSON.stringify(response)).toBeDefined();
    expect(await db.node.count({ where: { memoryId: mem.homeOrg!.id } })).toBe(before);
  });

  it('#1376 session-bound startChat: a bare key never takes an item-linked org memory from Session.memoryId (Diego, P1)', async () => {
    const link = await legacyLink('homeOrg', 'read-write');
    await giveConversation(link.agentId);
    const session = await db.session.create({ data: { id: generateId(), appId: link.appId, agentId: link.agentId, memoryId: mem.homeOrg!.id } as never });
    const before = await db.node.count({ where: { memoryId: mem.homeOrg!.id } });
    const response = await fetch(`${baseUrl}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${link.appKey}`, 'x-hadron-session': session.id },
      body: JSON.stringify({ query: 'mutation($agent: ID!) { startChat(agentId: $agent) { chatId } }', variables: { agent: link.agentId } }),
    });
    expect(((await response.json()) as { errors?: unknown }).errors).toBeDefined();
    expect(await db.node.count({ where: { memoryId: mem.homeOrg!.id } })).toBe(before);
  });

  it('#1376 session-bound startChat: the App-provisioned session memory (anon app-class, personal) stays a chat target (Riana, P1 on f96eec28)', async () => {
    for (const cls of ['app', 'personal'] as const) {
      const link = await legacyLink('homeOrg', 'read');
      await giveConversation(link.agentId);
      const owner = await db.user.create({ data: { id: generateId(), handle: `sc-${generateId()}`, githubUsername: `sc-${generateId()}` } });
      const own = await db.memory.create({
        data: {
          id: generateId(), urn: `home-${suffix}:sess-${cls}-${generateId()}`, name: `sess-${cls}`, ...(cls === 'personal' ? {} : { organizationId: homeOrgId }),
          class: cls, visibility: null, appId: link.appId, userMemoryOfAgentId: link.agentId,
          ...(cls === 'personal' ? { userId: owner.id, ownerUserId: owner.id } : {}),
        } as never,
      });
      if (cls === 'personal') await db.agentSubscription.create({ data: { userId: owner.id, agentId: link.agentId, activatedAt: new Date() } });
      const session = await db.session.create({ data: { id: generateId(), appId: link.appId, agentId: link.agentId, memoryId: own.id, ...(cls === 'personal' ? { userId: owner.id } : {}) } as never });
      // the gate's input: the session's verified reach holds the provisioned memory (personal: read-only in the access map, still reachable)
      expect(await sessionScopedMemoryIds(db, link.appId, session.id), cls).toContain(own.id);
      if (cls === 'personal') continue;
      const response = await fetch(`${baseUrl}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${link.appKey}`, 'x-hadron-session': session.id },
        body: JSON.stringify({ query: 'mutation($agent: ID!) { startChat(agentId: $agent) { chatId } }', variables: { agent: link.agentId } }),
      });
      const body = (await response.json()) as { errors?: unknown; data?: { startChat?: { chatId?: string } } };
      expect(body.errors, `${cls}: ${JSON.stringify(body)}`).toBeUndefined();
      expect(body.data?.startChat?.chatId).toBeTruthy();
    }
  });

  it("asset upload target: never another user's personal memory through a read-write link", async () => {
    const stranger = await db.user.create({ data: { id: generateId(), handle: `s-${generateId()}`, githubUsername: `s-${generateId()}` } });
    const { agentId } = await legacyLink('foreignPersonal', 'read-write');
    await expect(resolveAssetTargetMemoryId(db, agentId, stranger.id)).rejects.toThrow(/NO_TARGET_MEMORY/);
  });

  it("a personal memory's strict owner is its userId, whatever ownerUserId says (Riana, P2 1)", async () => {
    const victim = await db.user.create({ data: { id: generateId(), handle: `v-${generateId()}`, githubUsername: `v-${generateId()}` } });
    const caller = await db.user.create({ data: { id: generateId(), handle: `c-${generateId()}`, githubUsername: `c-${generateId()}` } });
    const skewed = await db.memory.create({
      data: { id: generateId(), urn: `home-${suffix}:skewed-${generateId()}`, name: 'skewed', class: 'personal', visibility: null, userId: victim.id, ownerUserId: caller.id } as never,
    });
    const agent = await db.agent.create({ data: { id: generateId(), organizationId: homeOrgId, name: 'skew', urn: `ag-skew-${generateId()}` } as never });
    await db.agentMemoryItem.create({ data: { id: generateId(), agentId: agent.id, memoryId: skewed.id, role: 'read-write' } });
    await expect(resolveAssetTargetMemoryId(db, agent.id, caller.id)).rejects.toThrow(/NO_TARGET_MEMORY/);
  });

  it("legacy startChat target: never the App's shared app-class memory through a link (Riana, P2 2)", async () => {
    const link = await legacyLink('homeOrg', 'read');
    await giveConversation(link.agentId);
    const shared = await db.memory.create({
      data: { id: generateId(), urn: `home-${suffix}:shared-${generateId()}`, name: 'shared', organizationId: homeOrgId, class: 'app', appId: link.appId } as never,
    });
    await db.agentMemoryItem.create({ data: { id: generateId(), agentId: link.agentId, memoryId: shared.id, role: 'read-write' } });
    const response = await gql(link.appKey, 'mutation($agent: ID!) { startChat(agentId: $agent) { chatId } }', { agent: link.agentId });
    expect(response.errors, JSON.stringify(response)).toBeDefined();
    expect(await db.node.count({ where: { memoryId: shared.id } })).toBe(0);
  });

  it('listings follow the cap: GraphQL memories and MCP hadron_list_memories (Colin)', async () => {
    for (const [target, want] of [['foreignOrg', false], ['foreignPublic', true], ['homeOrg', true]] as const) {
      const { appId, appKey } = await legacyLink(target, 'read-write');
      const response = await gql(appKey, 'query { memories { items { id } } }', {});
      expect(response.errors).toBeUndefined();
      // #1376: a bare key lists home ORGANIZATION knowledge no longer; an App member's listing follows the cap.
      const bareWant = target === 'homeOrg' ? false : want;
      expect(response.data?.memories.items.some((m: { id: string }) => m.id === mem[target]!.id)).toBe(bareWant);
      expect((await mcpFor(appId).callToolText('hadron_list_memories', {})).includes(mem[target]!.urn)).toBe(bareWant);
      const userId = await memberOf(appId);
      expect((await mcpFor(appId, userId).callToolText('hadron_list_memories', {})).includes(mem[target]!.urn)).toBe(want);
    }
  });

  it('legacy startChat target: an App key never writes a chat into a foreign memory through a link', async () => {
    const foreign = await legacyLink('foreignOrg', 'read-write');
    // A minimal conversation, so the call reaches the target-memory choice.
    const sys = await db.memory.create({
      data: { id: generateId(), urn: `home-${suffix}:sys-${generateId()}`, name: 'sys', organizationId: homeOrgId, class: 'system' } as never,
    });
    await db.agent.update({ where: { id: foreign.agentId }, data: { systemMemoryId: sys.id } as never });
    for (const [loc, data, content] of [
      ['conversations', null, null],
      ['conversations:c', { stageOrder: ['s'], isSetup: false }, null],
      ['conversations:c:s', { promptRef: 'prompts:c:s' }, null],
      ['prompts', null, null], ['prompts:c', null, null], ['prompts:c:s', null, 'Hi.'],
    ] as const) {
      await db.node.create({ data: { id: generateId(), memoryId: sys.id, loc, name: loc.split(':').pop()!, nodeType: 'system', data: data as never, content } });
    }
    const before = await db.node.count({ where: { memoryId: mem.foreignOrg!.id } });
    const err = await resolvers.Mutation.startChat({}, { agentId: foreign.agentId }, { db, appId: foreign.appId, roles: ['READER'] } as never)
      .then(() => null, (e: Error) => e.message);
    expect(err).toMatch(/No target memory available/);
    expect(await db.node.count({ where: { memoryId: mem.foreignOrg!.id } })).toBe(before);
  });
});

describe("#1349 Slice 1 — the same-App row grants nothing extra (Vera's control; the exception stays Proposed)", () => {
  it('an App-scoped memory of App X, linked to an agent: a bare key X no longer reads it (#1376); another App installing the agent does not', async () => {
    const agent = await db.agent.create({
      data: { id: generateId(), organizationId: homeOrgId, name: 'same-app', urn: `ag-same-app-${suffix}` } as never,
    });
    const x = await createDbAppWithKey(db, 'same-app-x', homeOrgId);
    const y = await createDbAppWithKey(db, 'same-app-y', homeOrgId);
    await createDbAppAgent(db, x.app.id, agent.id);
    await createDbAppAgent(db, y.app.id, agent.id);
    const scoped = await db.memory.create({
      data: {
        id: generateId(), urn: `home-${suffix}:x-scoped`, name: 'x-scoped', organizationId: homeOrgId,
        class: 'knowledge', visibility: 'ORGANIZATION', appId: x.app.id,
      } as never,
    });
    const node = await db.node.create({ data: { id: generateId(), memoryId: scoped.id, loc: 'payroll', name: 'p', content: 'X SCOPED' } });
    await db.agentMemoryItem.create({ data: { id: generateId(), agentId: agent.id, memoryId: scoped.id, role: 'read' } });
    // #1376: a bare key no longer reads its own App-scoped memory through an item (Riana, P2 2)
    expect((await gql(x.rawKey, READ, { r: node.id })).data?.node ?? null).toBeNull();
    expect((await gql(y.rawKey, READ, { r: node.id })).data?.node ?? null).toBeNull();
  });
});
