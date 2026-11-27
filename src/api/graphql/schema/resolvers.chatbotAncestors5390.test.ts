/**
 * #5390 — a chatbot Agent's conversation, stage and prompt nodes get their missing container parents (`conversations`,
 * `prompts`, `prompts:<name>`) in the same write, through every server write path (GraphQL createNode, MCP
 * hadron_create_node and hadron_create_parent_node; the Git sync has its own file), the skeleton gains the two roots, and
 * the retrofit adds only what is missing. Pins: families only, Agent system memories only, option B, never overwrite or
 * revive, idempotent, counted at the owner limit, and a depth-1 parent never becomes a conversation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { retrofitAgentSkeletons } from '../../../lib/agentSkeleton.js';
import { chatbotContainerLocs, missingChatbotContainers } from '../../../lib/chatbotAncestors.js';
import { topLevelConversations } from '../../../lib/chatConversationOrder.js';
import { reloadOwnerDefaultLimitsForTests } from '../../../lib/ownerLimits/defaults.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const ORG = 'org-5390';
let orgId: string;
let userId: string;
const ctx = (): Context => ({ db, userId, roles: ['READER'] } as Context);
const mcp = () => createTestableMcpServer({ userId, roles: ['READER'], clientId: `user:${userId}` });

const liveLocs = async (memoryId: string) =>
  (await db.node.findMany({ where: { memoryId, deletedAt: null }, select: { loc: true } })).map((n) => n.loc).sort();
const nodeAt = (memoryId: string, loc: string) => db.node.findFirst({ where: { memoryId, loc } });

/** An Agent made without the resolver, so its system memory starts empty (no skeleton). */
async function bareAgent(name: string, extendsAgentId?: string): Promise<{ id: string; memoryId: string; urn: string }> {
  const urn = `${ORG}:${name}-sys`;
  const m = await db.memory.create({ data: { id: generateId(), organizationId: orgId, urn, name: `${name} System`, class: 'system', acceptsUploads: false, vectorIndexEnabled: false } });
  const a = await db.agent.create({ data: { organizationId: orgId, name, urn: `${ORG}:${name}`, systemMemoryId: m.id, visibility: 'ORGANIZATION', ...(extendsAgentId ? { extendsAgentId } : {}) } });
  return { id: a.id, memoryId: m.id, urn };
}

const create = (memoryId: string, loc: string, extra: Record<string, unknown> = {}) =>
  resolvers.Mutation.createNode(null, { input: { memoryRef: memoryId, loc, name: loc.split(':').pop(), nodeType: 'system', ...extra } } as never, ctx());

beforeEach(async () => {
  await cleanDb(db);
  reloadOwnerDefaultLimitsForTests({});
  orgId = (await db.organization.create({ data: { id: generateId(), name: ORG, urn: ORG } })).id;
  userId = (await db.user.create({ data: { id: generateId(), handle: 'u-5390', email: 'u-5390@example.test', roles: ['READER'] } })).id;
  await db.orgMember.create({ data: { organizationId: orgId, userId, role: 'OWNER' } });
});
afterEach(() => { reloadOwnerDefaultLimitsForTests({ OWNER_DEFAULT_LIMITS: '' }); });

describe('#5390 which parents a loc needs', () => {
  it.each([
    ['conversations:welcome', ['conversations']],
    ['conversations:welcome:greet', ['conversations']],
    ['prompts:welcome', ['prompts']],
    ['prompts:welcome:greet', ['prompts', 'prompts:welcome']],
    // Not the families, or not their depths: nothing.
    ['conversations', []], ['prompts', []], ['conversations:a:b:c', []], ['prompts:a:b:c', []],
    ['notes:a:b', []], ['chats:x:messages', []], ['conversations::x', []],
  ])('%s', (loc, want) => {
    expect(chatbotContainerLocs(loc)).toEqual(want);
  });
});

describe('#5390 GraphQL createNode (the portal\'s Conversation Editor and wizard path)', () => {
  it('a conversation, a stage and a prompt leave no loc without its parent, and the parents are empty info nodes', async () => {
    const a = await bareAgent('ky');
    await create(a.memoryId, 'conversations:welcome', { data: { stageOrder: ['greet'] } });
    await create(a.memoryId, 'conversations:welcome:greet', { data: { promptRef: 'prompts:welcome:greet' } });
    await create(a.memoryId, 'prompts:welcome:greet', { content: 'Say hello.' });
    expect(await liveLocs(a.memoryId)).toEqual(['conversations', 'conversations:welcome', 'conversations:welcome:greet', 'prompts', 'prompts:welcome', 'prompts:welcome:greet']);
    for (const loc of ['conversations', 'prompts', 'prompts:welcome']) {
      const n = await nodeAt(a.memoryId, loc);
      expect([n!.nodeType, n!.content, n!.data]).toEqual(['info', null, null]);
    }
    expect((await nodeAt(a.memoryId, 'conversations'))!.name).toBe('Conversations');
    expect((await nodeAt(a.memoryId, 'prompts'))!.name).toBe('Prompts');
    expect((await nodeAt(a.memoryId, 'prompts:welcome'))!.name).toBe('welcome');
  });

  it('idempotent: a second conversation and prompt add no duplicate and leave an existing parent untouched', async () => {
    const a = await bareAgent('idem');
    await db.node.create({ data: { id: generateId(), memoryId: a.memoryId, loc: 'prompts', name: 'My Prompts', content: 'mine' } });
    await create(a.memoryId, 'prompts:one:s', { content: 'x' });
    await create(a.memoryId, 'prompts:one:t', { content: 'y' });
    await create(a.memoryId, 'conversations:one');
    await create(a.memoryId, 'conversations:two');
    const p = await nodeAt(a.memoryId, 'prompts');
    expect([p!.name, p!.content]).toEqual(['My Prompts', 'mine']);
    expect(await db.node.count({ where: { memoryId: a.memoryId, loc: { in: ['conversations', 'prompts', 'prompts:one'] } } })).toBe(3);
  });

  it('a stage with no conversation gets `conversations` but no empty `conversations:<name>` (chat start must not see one)', async () => {
    const a = await bareAgent('orphan');
    await create(a.memoryId, 'conversations:ghost:s1');
    expect(await liveLocs(a.memoryId)).toEqual(['conversations', 'conversations:ghost:s1']);
  });

  it('only Agent system memories: a knowledge memory and an install memory gain nothing', async () => {
    const k = await db.memory.create({ data: { id: generateId(), organizationId: orgId, urn: `${ORG}:know`, name: 'know', class: 'knowledge', vectorIndexEnabled: false } });
    await create(k.id, 'prompts:a:b');
    expect(await liveLocs(k.id)).toEqual(['prompts:a:b']);
    const a = await bareAgent('inst');
    const app = await db.app.create({ data: { id: generateId(), name: 'app-5390', urn: `${ORG}:app-5390`, organizationId: orgId } });
    const install = await db.memory.create({ data: { id: generateId(), organizationId: orgId, urn: `${ORG}:inst-install`, name: 'install', class: 'system', isInstallMemory: true, appId: app.id, installOfAgentId: a.id, acceptsUploads: false, vectorIndexEnabled: false } });
    // The shared helper every write path asks: nothing for an install memory (its node would hide the Agent's).
    expect(await missingChatbotContainers(db, install.id, ['prompts:a:b'])).toEqual([]);
    expect(await missingChatbotContainers(db, a.memoryId, ['prompts:a:b'])).toEqual(['prompts', 'prompts:a']);
  });

  it('option B: a derived Agent creates no parent its base already provides', async () => {
    const base = await bareAgent('base');
    await db.node.create({ data: { id: generateId(), memoryId: base.memoryId, loc: 'prompts', name: 'Prompts' } });
    const child = await bareAgent('child', base.id);
    await create(child.memoryId, 'prompts:c:s');
    expect(await liveLocs(child.memoryId)).toEqual(['prompts:c', 'prompts:c:s']);
  });

  it('never revives a tombstoned parent', async () => {
    const a = await bareAgent('tomb');
    await db.node.create({ data: { id: generateId(), memoryId: a.memoryId, loc: 'prompts', name: 'Gone', deletedAt: new Date() } });
    await create(a.memoryId, 'prompts:x:y');
    const t = await nodeAt(a.memoryId, 'prompts');
    expect([t!.name, t!.deletedAt !== null]).toEqual(['Gone', true]);
    expect(await liveLocs(a.memoryId)).toEqual(['prompts:x', 'prompts:x:y']);
  });

  it('the owner limit counts the parents with the node (cor:acl:150:04): two short refuses and writes nothing, enough admits', async () => {
    const a = await bareAgent('limit');
    const { OWNER_LIMIT_KEYS } = await import('../../../lib/ownerLimits/keys.js');
    const held = Number(await OWNER_LIMIT_KEYS.nodes.count(db, { organizationId: orgId }));
    const row = await db.ownerLimit.create({ data: { id: generateId(), organizationId: orgId, key: 'nodes', limitValue: held + 2, sourceType: 'manual', sourceId: 't', note: 't' } });
    // The prompt needs `prompts` and `prompts:p`: three nodes against a headroom of two.
    await expect(create(a.memoryId, 'prompts:p:s')).rejects.toMatchObject({ extensions: { code: 'OWNER_LIMIT_REACHED' } });
    expect(await liveLocs(a.memoryId)).toEqual([]);
    await db.ownerLimit.update({ where: { id: row.id }, data: { limitValue: held + 3 } });
    await create(a.memoryId, 'prompts:p:s');
    expect(await liveLocs(a.memoryId)).toEqual(['prompts', 'prompts:p', 'prompts:p:s']);
  });
});

describe('#5390 MCP writers', () => {
  it('hadron_create_node adds the parents, as GraphQL does', async () => {
    const a = await bareAgent('mcp');
    const out = await mcp().callToolText('hadron_create_node', { urn: `hrn:node:${a.urn}:prompts:welcome:greet`, name: 'greet', nodeType: 'system', content: 'hi' });
    expect(out).not.toMatch(/denied|refus|error/i);
    await mcp().callToolText('hadron_create_node', { urn: `hrn:node:${a.urn}:conversations:welcome`, name: 'welcome', nodeType: 'system' });
    expect(await liveLocs(a.memoryId)).toEqual(['conversations', 'conversations:welcome', 'prompts', 'prompts:welcome', 'prompts:welcome:greet']);
  });

  it('hadron_create_parent_node at `prompts:<name>` adds `prompts`', async () => {
    const a = await bareAgent('mcp-parent');
    const out = await mcp().callToolText('hadron_create_parent_node', { urn: `hrn:node:${a.urn}:prompts:welcome`, name: 'welcome' });
    expect(out).not.toMatch(/denied|refus|error/i);
    expect(await liveLocs(a.memoryId)).toEqual(['prompts', 'prompts:welcome']);
  });
});

describe('#5390 skeleton and retrofit', () => {
  it('a new Agent starts with `conversations` and `prompts`', async () => {
    const a = await resolvers.Mutation.createAgent({}, { orgRef: orgId, name: 'fresh', visibility: 'ORGANIZATION' }, { db, roles: ['ADMIN'], userId } as never) as unknown as { systemMemoryId: string };
    const n = await nodeAt(a.systemMemoryId, 'conversations');
    expect([n!.name, n!.nodeType]).toEqual(['Conversations', 'info']);
    expect((await nodeAt(a.systemMemoryId, 'prompts'))!.name).toBe('Prompts');
  });

  it('the retrofit adds only the missing parents, reports them, and a second run adds nothing', async () => {
    const a = await bareAgent('legacy');
    // The shape that hid a live Agent's design (#5390): conversations, stages and prompts with no parents.
    for (const loc of ['conversations:welcome', 'conversations:welcome:greet', 'prompts:welcome:greet', 'prompts:concern:open']) {
      await db.node.create({ data: { id: generateId(), memoryId: a.memoryId, loc, name: loc, nodeType: 'system', content: `keep ${loc}` } });
    }
    const before = await db.node.findMany({ where: { memoryId: a.memoryId }, orderBy: { loc: 'asc' } });
    const dry = await retrofitAgentSkeletons(db, { dryRun: true });
    const first = await retrofitAgentSkeletons(db);
    const mine = first.find((r) => r.memoryId === a.memoryId)!.created;
    expect(mine).toEqual(['boot', 'boot:rules', 'processes', 'tasks', 'conversations', 'prompts', 'prompts:concern', 'prompts:welcome']);
    expect(dry.find((r) => r.memoryId === a.memoryId)!.created).toEqual(mine);
    // Nothing existing changed.
    const after = await db.node.findMany({ where: { memoryId: a.memoryId, id: { in: before.map((b) => b.id) } }, orderBy: { loc: 'asc' } });
    expect(after.map((n) => [n.loc, n.content, n.updatedAt.getTime()])).toEqual(before.map((n) => [n.loc, n.content, n.updatedAt.getTime()]));
    const second = await retrofitAgentSkeletons(db);
    expect(second.every((r) => r.created.length === 0)).toBe(true);
  });
});

describe('#5390 chat start reads the same conversations', () => {
  it('a depth-1 `conversations` or a `prompts` parent is never a conversation', () => {
    const nodes = [{ loc: 'conversations' }, { loc: 'prompts' }, { loc: 'prompts:welcome' }, { loc: 'conversations:welcome' }, { loc: 'conversations:welcome:greet' }];
    expect(topLevelConversations(nodes.filter((n) => n.loc.startsWith('conversations:'))).map((n) => n.loc)).toEqual(['conversations:welcome']);
  });
});
