/**
 * #5390 — a chatbot's conversation, stage and prompt nodes get their parent nodes.
 * Pins: the pure family rule; GraphQL createNode and MCP hadron_create_node create the missing parents in the
 * same write; `conversations:<name>` is never auto-created; idempotent; nothing outside the families or outside an
 * Agent's own unencrypted system memory; node-limit headroom counts the parents; the skeleton gains the roots;
 * the retrofit adds the `prompts:<name>` parents and is safe to run twice.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbAppWithKey } from '../test/helpers.js';
import { generateId } from './id.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from '../mcp/server.js';
import { AGENT_SKELETON, retrofitAgentSkeletons } from './agentSkeleton.js';
import { chatbotParentLocsOf, planChatbotParents } from './chatbotAncestors.js';


vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

let orgId: string;
let admin: { id: string };
let sys: { id: string; urn: string };
const gql = (): Context => ({ db, userId: admin.id, roles: [] });
const mcp = () => createTestableMcpServer({ userId: admin.id, roles: [], clientId: `user:${admin.id}` });
const locsOf = async (memoryId: string) =>
  (await db.node.findMany({ where: { memoryId, deletedAt: null }, select: { loc: true } })).map((n) => n.loc).sort();
const nodeAt = (memoryId: string, loc: string) => db.node.findFirst({ where: { memoryId, loc } });

/** An Agent whose system memory starts EMPTY (no skeleton), so only the write path can make a parent. */
async function bareAgent(name: string): Promise<{ id: string; memoryId: string; urn: string }> {
  const m = await db.memory.create({ data: { id: generateId(), organizationId: orgId, urn: `${name}-sys`, name: `${name} System`, class: 'system', acceptsUploads: false } });
  const a = await db.agent.create({ data: { organizationId: orgId, name, urn: `org-5390:${name}`, systemMemoryId: m.id, visibility: 'ORGANIZATION' } });
  return { id: a.id, memoryId: m.id, urn: m.urn };
}
const gqlCreate = (memoryRef: string, loc: string) =>
  resolvers.Mutation.createNode(null, { input: { memoryRef, loc, name: loc } } as never, gql());

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'org-5390', urn: 'org-5390' } });
  orgId = org.id;
  admin = await db.user.create({ data: { githubId: 53900, githubUsername: 'admin-5390', handle: 'admin-5390', roles: [] } });
  await db.orgMember.create({ data: { organizationId: orgId, userId: admin.id, role: 'ADMIN' } });
  const a = await bareAgent('bot');
  sys = { id: a.memoryId, urn: a.urn };
});

describe('#5390 the family rule', () => {
  it('names the container parents and never conversations:<name>', () => {
    expect(chatbotParentLocsOf('conversations:welcome')).toEqual(['conversations']);
    expect(chatbotParentLocsOf('conversations:welcome:stage')).toEqual(['conversations']);
    expect(chatbotParentLocsOf('prompts:welcome')).toEqual(['prompts']);
    expect(chatbotParentLocsOf('prompts:welcome:stage')).toEqual(['prompts', 'prompts:welcome']);
    expect(chatbotParentLocsOf('conversations')).toEqual([]);
    expect(chatbotParentLocsOf('prompts')).toEqual([]);
    expect(chatbotParentLocsOf('tasks:x')).toEqual([]);
  });
});

describe('#5390 GraphQL createNode', () => {
  it('a conversation, stage and prompt leave no loc whose container parent is missing', async () => {
    await gqlCreate(sys.id, 'conversations:welcome');
    await gqlCreate(sys.id, 'conversations:welcome:ask');
    await gqlCreate(sys.id, 'prompts:welcome:ask');
    expect(await locsOf(sys.id)).toEqual(['conversations', 'conversations:welcome', 'conversations:welcome:ask', 'prompts', 'prompts:welcome', 'prompts:welcome:ask']);
  });

  it('a stage written without its conversation leaves NO conversations:<name> node', async () => {
    await gqlCreate(sys.id, 'conversations:ghost:ask');
    expect(await locsOf(sys.id)).toEqual(['conversations', 'conversations:ghost:ask']);
    expect(await nodeAt(sys.id, 'conversations:ghost')).toBeNull();
  });

  it('is idempotent and never touches an existing parent', async () => {
    await db.node.create({ data: { id: generateId(), memoryId: sys.id, loc: 'prompts', name: 'My Prompts', content: 'keep me' } });
    await gqlCreate(sys.id, 'prompts:a:one');
    await gqlCreate(sys.id, 'prompts:a:two');
    const parent = await nodeAt(sys.id, 'prompts');
    expect([parent!.name, parent!.content]).toEqual(['My Prompts', 'keep me']);
    expect(await db.node.count({ where: { memoryId: sys.id, loc: 'prompts:a' } })).toBe(1);
  });

  it('does not revive a tombstoned parent', async () => {
    await db.node.create({ data: { id: generateId(), memoryId: sys.id, loc: 'conversations', name: 'Gone', deletedAt: new Date() } });
    await gqlCreate(sys.id, 'conversations:c');
    expect((await nodeAt(sys.id, 'conversations'))!.deletedAt).not.toBeNull();
  });

  it('creates nothing outside the families, or in a memory that is not an Agent system memory', async () => {
    await gqlCreate(sys.id, 'tasks:x');
    expect(await locsOf(sys.id)).toEqual(['tasks:x']);
    const k = await db.memory.create({ data: { id: generateId(), organizationId: orgId, urn: 'know-5390', name: 'know', class: 'knowledge' } });
    await gqlCreate(k.id, 'conversations:c:s');
    expect(await locsOf(k.id)).toEqual(['conversations:c:s']);
  });

  it('an install memory gets no parents either', async () => {
    const a = await db.agent.findFirstOrThrow({ where: { systemMemoryId: sys.id } });
    const { app } = await createDbAppWithKey(db, 'app-5390', orgId);
    const m = await db.memory.create({ data: { id: generateId(), organizationId: orgId, urn: 'inst-5390', name: 'inst', class: 'system', appId: app.id, installOfAgentId: a.id, isInstallMemory: true } });
    await db.$transaction(async (tx) => {
      expect(await planChatbotParents(tx, m.id, 'prompts:a:b')).toEqual([]);
      expect((await planChatbotParents(tx, sys.id, 'prompts:a:b')).map((p) => p.loc)).toEqual(['prompts', 'prompts:a']);
    });
  });

  it('an encrypted system memory is skipped', async () => {
    await db.memory.update({ where: { id: sys.id }, data: { isEncrypted: true } });
    await gqlCreate(sys.id, 'prompts:a:b').catch(() => undefined);
    expect(await nodeAt(sys.id, 'prompts')).toBeNull();
  });
});

describe('#5390 MCP hadron_create_node', () => {
  it('creates the same parents in the same write', async () => {
    const out = await mcp().callToolText('hadron_create_node', { urn: `hrn:node:${sys.urn}:prompts:welcome:ask`, name: 'ask' });
    expect(out).not.toMatch(/error|refus/i);
    expect(await locsOf(sys.id)).toEqual(['prompts', 'prompts:welcome', 'prompts:welcome:ask']);
  });
});

describe('#5390 node-limit headroom counts the parents', () => {
  it('a create that would add its parents past the owner\'s limit is refused whole', async () => {
    await db.ownerLimit.create({ data: { id: generateId(), organizationId: orgId, key: 'nodes', limitValue: 2, sourceType: 'manual', sourceId: 't', note: 't' } });
    await expect(gqlCreate(sys.id, 'prompts:a:b')).rejects.toThrow();
    expect(await locsOf(sys.id)).toEqual([]);
  });
});

describe('#5390 the skeleton and the retrofit', () => {
  it('the skeleton gains conversations and prompts', () => {
    expect(AGENT_SKELETON.map((n) => n.loc)).toEqual(expect.arrayContaining(['conversations', 'prompts']));
  });

  it('the retrofit adds the missing parents of existing prompts, reports them, and a second pass adds none', async () => {
    await db.node.createMany({ data: [
      { id: generateId(), memoryId: sys.id, loc: 'conversations:welcome', name: 'w' },
      { id: generateId(), memoryId: sys.id, loc: 'prompts:welcome:ask', name: 'p' },
    ] });
    const first = await retrofitAgentSkeletons(db);
    expect(first.find((r) => r.memoryId === sys.id)!.created).toEqual(expect.arrayContaining(['conversations', 'prompts', 'prompts:welcome']));
    expect(await nodeAt(sys.id, 'conversations:welcome')).not.toBeNull();
    expect(await nodeAt(sys.id, 'prompts:welcome:ask')).not.toBeNull();
    expect((await nodeAt(sys.id, 'conversations:welcome'))!.name).toBe('w');
    const second = await retrofitAgentSkeletons(db);
    expect(second.every((r) => r.created.length === 0)).toBe(true);
  });
});
