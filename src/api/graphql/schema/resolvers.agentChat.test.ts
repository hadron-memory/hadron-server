import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { generateId } from '../../../lib/id.js';

// Prevent git writes
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

let orgA: { id: string; urn: string };
let adminUser: { id: string };
let otherUser: { id: string };
let agent: { id: string; organizationId: string };
let systemMemory: { id: string };

function adminCtx(overrides: Partial<Context> = {}): Context {
  return { db, roles: ['ADMIN'], userId: adminUser.id, ...overrides };
}
function userCtx(userId: string, overrides: Partial<Context> = {}): Context {
  return { db, roles: ['READER'], userId, ...overrides };
}

// Seed: org + user + agent with a non-setup conversation and a stage
beforeEach(async () => {
  await cleanDb(db);

  orgA = await db.organization.create({
    data: { id: generateId(), name: 'org-a', urn: 'org-a' },
  });
  adminUser = await db.user.create({
    data: { githubId: 9001, githubUsername: 'admin-user', roles: ['ADMIN'] },
  });
  otherUser = await db.user.create({
    data: { githubId: 9002, githubUsername: 'other-user', roles: ['READER'] },
  });
  await db.orgMember.create({
    data: { organizationId: orgA.id, userId: adminUser.id, role: 'ADMIN' },
  });
  await db.orgMember.create({
    data: { organizationId: orgA.id, userId: otherUser.id, role: 'CONTRIBUTOR' },
  });

  // Create the agent first (so the system memory can reference it)
  agent = await resolvers.Mutation.createAgent(
    {},
    { orgId: orgA.id, name: 'research-agent', visibility: 'ORGANIZATION' },
    adminCtx(),
  );
  // Create a system memory and attach it to the agent
  systemMemory = await resolvers.Mutation.createMemory(
    {},
    { orgId: orgA.id, name: 'research-system' },
    adminCtx(),
  );
  await resolvers.Mutation.updateAgent(
    {},
    { id: agent.id, systemMemoryId: systemMemory.id },
    adminCtx(),
  );

  // Seed the system memory with conversations + stages + prompts
  const nodes = [
    { loc: 'conversations', name: 'conversations', nodeType: 'system' },
    {
      loc: 'conversations:research',
      name: 'research',
      nodeType: 'system',
      data: { stageOrder: ['scope', 'analysis'], isSetup: false },
    },
    {
      loc: 'conversations:research:scope',
      name: 'scope',
      nodeType: 'system',
      data: { promptRef: 'prompts:research:scope' },
    },
    {
      loc: 'conversations:research:analysis',
      name: 'analysis',
      nodeType: 'system',
      data: { promptRef: 'prompts:research:analysis' },
    },
    { loc: 'prompts', name: 'prompts', nodeType: 'system' },
    { loc: 'prompts:research', name: 'research', nodeType: 'system' },
    { loc: 'prompts:research:scope', name: 'scope', nodeType: 'system', content: 'Scope the research.' },
    { loc: 'prompts:research:analysis', name: 'analysis', nodeType: 'system', content: 'Analyze findings.' },
  ];
  for (const n of nodes) {
    await db.node.create({
      data: {
        id: generateId(),
        memoryId: systemMemory.id,
        loc: n.loc,
        name: n.name,
        nodeType: n.nodeType,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: ((n as any).data ?? null) as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        content: ((n as any).content ?? null) as any,
      },
    });
  }
});

// ---------------------------------------------------------------------------
// Agent AI config
// ---------------------------------------------------------------------------

describe('Agent AI config', () => {
  it('updateAgentAIConfig encrypts the key and sets hasAiApiKey', async () => {
    const updated = await resolvers.Mutation.updateAgentAIConfig(
      {},
      { agentId: agent.id, provider: 'anthropic', apiKey: 'sk-ant-test', model: 'claude-opus-4-6' },
      adminCtx(),
    );
    expect(updated.aiProvider).toBe('anthropic');
    expect(updated.aiModel).toBe('claude-opus-4-6');
    expect(updated.aiApiKeyEncrypted).toBeTruthy();
    expect(updated.aiApiKeyEncrypted).not.toBe('sk-ant-test');

    // hasAiApiKey is a field resolver — test it via the Agent resolver
    const resolved = resolvers.Agent.hasAiApiKey({
      aiApiKeyEncrypted: updated.aiApiKeyEncrypted,
    });
    expect(resolved).toBe(true);
  });

  it('agentAIConfig returns the decrypted key to admin callers', async () => {
    await resolvers.Mutation.updateAgentAIConfig(
      {},
      { agentId: agent.id, provider: 'anthropic', apiKey: 'sk-ant-abc', model: 'claude-opus-4-6' },
      adminCtx(),
    );
    const cfg = await resolvers.Query.agentAIConfig(
      {},
      { agentId: agent.id },
      adminCtx(),
    );
    expect(cfg?.provider).toBe('anthropic');
    expect(cfg?.apiKey).toBe('sk-ant-abc');
    expect(cfg?.model).toBe('claude-opus-4-6');
  });

  // 007-entity-id-or-urn: agentAIConfig accepts agentId as ID or URN.
  it('agentAIConfig accepts a URN as agentId input', async () => {
    await resolvers.Mutation.updateAgentAIConfig(
      {},
      { agentId: agent.id, provider: 'anthropic', apiKey: 'sk-ant-urn', model: 'claude-opus-4-6' },
      adminCtx(),
    );
    const stored = await db.agent.findUniqueOrThrow({
      where: { id: agent.id },
      select: { urn: true },
    });
    const cfg = await resolvers.Query.agentAIConfig(
      {},
      { agentId: stored.urn },
      adminCtx(),
    );
    expect(cfg?.apiKey).toBe('sk-ant-urn');
  });

  it('agentAIConfig accepts a prefixed URN (urn:agent:...) as agentId input', async () => {
    await resolvers.Mutation.updateAgentAIConfig(
      {},
      { agentId: agent.id, provider: 'anthropic', apiKey: 'sk-ant-prefix', model: 'claude-opus-4-6' },
      adminCtx(),
    );
    const stored = await db.agent.findUniqueOrThrow({
      where: { id: agent.id },
      select: { urn: true },
    });
    const cfg = await resolvers.Query.agentAIConfig(
      {},
      { agentId: `urn:agent:${stored.urn}` },
      adminCtx(),
    );
    expect(cfg?.apiKey).toBe('sk-ant-prefix');
  });

  it('agentAIConfig refuses non-admin', async () => {
    await resolvers.Mutation.updateAgentAIConfig(
      {},
      { agentId: agent.id, provider: 'anthropic', apiKey: 'sk', model: 'claude-opus-4-6' },
      adminCtx(),
    );
    await expect(
      resolvers.Query.agentAIConfig({}, { agentId: agent.id }, userCtx(otherUser.id)),
    ).rejects.toThrow('Forbidden');
  });

  it('clearAgentAIConfig wipes the config', async () => {
    await resolvers.Mutation.updateAgentAIConfig(
      {},
      { agentId: agent.id, provider: 'anthropic', apiKey: 'sk', model: 'claude-opus-4-6' },
      adminCtx(),
    );
    const cleared = await resolvers.Mutation.clearAgentAIConfig(
      {},
      { agentId: agent.id },
      adminCtx(),
    );
    expect(cleared.aiProvider).toBeNull();
    expect(cleared.aiApiKeyEncrypted).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// startChat for JWT users
// ---------------------------------------------------------------------------

describe('startChat (JWT user)', () => {
  it('auto-provisions a user memory and picks the non-setup conversation', async () => {
    const result = await resolvers.Mutation.startChat(
      {},
      { agentId: agent.id },
      userCtx(adminUser.id),
    );
    expect(result.chatId).toMatch(/^chats:/);
    expect(result.conversationName).toBe('research');
    expect(result.stageName).toBe('scope');
    // System message should include the stage prompt content
    expect(result.systemMessage).toContain('Scope the research.');

    // Verify the user memory was created
    const mem = await db.memory.findFirst({
      where: { userMemoryOfAgentId: agent.id, createdBy: adminUser.id },
    });
    expect(mem).not.toBeNull();
    expect(mem?.visibility).toBe('PERSONAL');
    expect(mem?.urn).toContain(':user:');

    // Verify the chat node exists inside that memory
    const chatNode = await db.node.findFirst({
      where: { memoryId: mem!.id, loc: result.chatId },
    });
    expect(chatNode).not.toBeNull();
    expect((chatNode!.data as Record<string, unknown>).conversationName).toBe('research');
    expect((chatNode!.data as Record<string, unknown>).stageName).toBe('scope');
  });

  it('reuses the existing user memory on a second startChat', async () => {
    const r1 = await resolvers.Mutation.startChat({}, { agentId: agent.id }, userCtx(adminUser.id));
    const r2 = await resolvers.Mutation.startChat({}, { agentId: agent.id }, userCtx(adminUser.id));
    expect(r1.chatId).not.toBe(r2.chatId);

    const mems = await db.memory.findMany({
      where: { userMemoryOfAgentId: agent.id, createdBy: adminUser.id },
    });
    expect(mems.length).toBe(1);
  });

  it('gives two users separate memories on the same agent', async () => {
    await resolvers.Mutation.startChat({}, { agentId: agent.id }, userCtx(adminUser.id));
    await resolvers.Mutation.startChat({}, { agentId: agent.id }, userCtx(otherUser.id));

    const mems = await db.memory.findMany({
      where: { userMemoryOfAgentId: agent.id, deletedAt: null },
    });
    expect(mems.length).toBe(2);
    expect(new Set(mems.map((m) => m.createdBy))).toEqual(
      new Set([adminUser.id, otherUser.id]),
    );
  });

  it('throws when the agent has no system memory', async () => {
    const naked = await resolvers.Mutation.createAgent(
      {},
      { orgId: orgA.id, name: 'naked-agent' },
      adminCtx(),
    );
    await expect(
      resolvers.Mutation.startChat({}, { agentId: naked.id }, userCtx(adminUser.id)),
    ).rejects.toThrow(/system memory/);
  });
});

// ---------------------------------------------------------------------------
// myChats
// ---------------------------------------------------------------------------

describe('myChats', () => {
  it('returns the current user\'s chats only', async () => {
    // User 1 creates 2 chats
    const c1 = await resolvers.Mutation.startChat({}, { agentId: agent.id }, userCtx(adminUser.id));
    const c2 = await resolvers.Mutation.startChat({}, { agentId: agent.id }, userCtx(adminUser.id));
    // User 2 creates 1 chat
    const c3 = await resolvers.Mutation.startChat({}, { agentId: agent.id }, userCtx(otherUser.id));

    const adminChats = await resolvers.Query.myChats(
      {},
      { agentId: agent.id },
      userCtx(adminUser.id),
    );
    expect(adminChats.length).toBe(2);
    expect(adminChats.map((c) => c.loc).sort()).toEqual([c1.chatId, c2.chatId].sort());

    const otherChats = await resolvers.Query.myChats(
      {},
      { agentId: agent.id },
      userCtx(otherUser.id),
    );
    expect(otherChats.length).toBe(1);
    expect(otherChats[0].loc).toBe(c3.chatId);
  });

  it('returns an empty list when the user has no memory for the agent yet', async () => {
    const result = await resolvers.Query.myChats(
      {},
      { agentId: agent.id },
      userCtx(adminUser.id),
    );
    expect(result).toEqual([]);
  });

  // 007-entity-id-or-urn: myChats accepts agentId as ID or URN.
  it('accepts a URN as agentId input', async () => {
    const c1 = await resolvers.Mutation.startChat({}, { agentId: agent.id }, userCtx(adminUser.id));
    const stored = await db.agent.findUniqueOrThrow({
      where: { id: agent.id },
      select: { urn: true },
    });
    const chats = await resolvers.Query.myChats(
      {},
      { agentId: stored.urn },
      userCtx(adminUser.id),
    );
    expect(chats.map((c) => c.loc)).toEqual([c1.chatId]);
  });

  it('accepts a prefixed URN (urn:agent:...) as agentId input', async () => {
    const c1 = await resolvers.Mutation.startChat({}, { agentId: agent.id }, userCtx(adminUser.id));
    const stored = await db.agent.findUniqueOrThrow({
      where: { id: agent.id },
      select: { urn: true },
    });
    const chats = await resolvers.Query.myChats(
      {},
      { agentId: `urn:agent:${stored.urn}` },
      userCtx(adminUser.id),
    );
    expect(chats.map((c) => c.loc)).toEqual([c1.chatId]);
  });

  it('derives the title from the first user message', async () => {
    const start = await resolvers.Mutation.startChat(
      {},
      { agentId: agent.id },
      userCtx(adminUser.id),
    );
    await resolvers.Mutation.sendChatMessage(
      {},
      { chatId: start.chatId, userMessage: 'What is the half-life of francium-223?' },
      userCtx(adminUser.id),
    );

    const chats = await resolvers.Query.myChats(
      {},
      { agentId: agent.id },
      userCtx(adminUser.id),
    );
    expect(chats[0].title).toBe('What is the half-life of francium-223?');
  });

  it('prefers an explicit user-set title over the first message', async () => {
    const start = await resolvers.Mutation.startChat(
      {},
      { agentId: agent.id },
      userCtx(adminUser.id),
    );
    await resolvers.Mutation.sendChatMessage(
      {},
      { chatId: start.chatId, userMessage: 'First message' },
      userCtx(adminUser.id),
    );
    await resolvers.Mutation.updateChatTitle(
      {},
      { chatId: start.chatId, title: 'Francium decay research' },
      userCtx(adminUser.id),
    );

    const chats = await resolvers.Query.myChats(
      {},
      { agentId: agent.id },
      userCtx(adminUser.id),
    );
    expect(chats[0].title).toBe('Francium decay research');
  });

  it('sorts newest first by lastMessageAt', async () => {
    const c1 = await resolvers.Mutation.startChat({}, { agentId: agent.id }, userCtx(adminUser.id));
    // Small delay so timestamps differ
    await new Promise((r) => setTimeout(r, 5));
    const c2 = await resolvers.Mutation.startChat({}, { agentId: agent.id }, userCtx(adminUser.id));
    await new Promise((r) => setTimeout(r, 5));
    await resolvers.Mutation.sendChatMessage(
      {},
      { chatId: c1.chatId, userMessage: 'reviving the older chat' },
      userCtx(adminUser.id),
    );

    const chats = await resolvers.Query.myChats(
      {},
      { agentId: agent.id },
      userCtx(adminUser.id),
    );
    expect(chats[0].loc).toBe(c1.chatId);
    expect(chats[1].loc).toBe(c2.chatId);
  });
});

// ---------------------------------------------------------------------------
// chatHistory
// ---------------------------------------------------------------------------

describe('chatHistory', () => {
  it('returns messages in order with correct role attribution', async () => {
    const start = await resolvers.Mutation.startChat(
      {},
      { agentId: agent.id },
      userCtx(adminUser.id),
    );
    await resolvers.Mutation.sendChatMessage(
      {},
      { chatId: start.chatId, userMessage: 'hello' },
      userCtx(adminUser.id),
    );
    await resolvers.Mutation.processChatResponse(
      {},
      {
        chatId: start.chatId,
        toolResponse: { message: 'hi there, I am the agent', data: null, next_stage: null },
      },
      userCtx(adminUser.id),
    );

    const history = await resolvers.Query.chatHistory(
      {},
      { chatId: start.chatId },
      userCtx(adminUser.id),
    );
    expect(history.length).toBe(2);
    expect(history[0].role).toBe('user');
    expect(history[0].content).toBe('hello');
    expect(history[1].role).toBe('assistant');
    expect(history[1].content).toBe('hi there, I am the agent');
  });

  it('refuses access to another user\'s chat', async () => {
    const start = await resolvers.Mutation.startChat(
      {},
      { agentId: agent.id },
      userCtx(adminUser.id),
    );
    await expect(
      resolvers.Query.chatHistory({}, { chatId: start.chatId }, userCtx(otherUser.id)),
    ).rejects.toThrow('Forbidden');
  });
});

// ---------------------------------------------------------------------------
// updateChatTitle / deleteChat ownership
// ---------------------------------------------------------------------------

describe('chat ownership mutations', () => {
  it('updateChatTitle refuses a non-owner', async () => {
    const start = await resolvers.Mutation.startChat(
      {},
      { agentId: agent.id },
      userCtx(adminUser.id),
    );
    await expect(
      resolvers.Mutation.updateChatTitle(
        {},
        { chatId: start.chatId, title: 'hijacked' },
        userCtx(otherUser.id),
      ),
    ).rejects.toThrow('Forbidden');
  });

  it('deleteChat soft-deletes the chat and its messages', async () => {
    const start = await resolvers.Mutation.startChat(
      {},
      { agentId: agent.id },
      userCtx(adminUser.id),
    );
    await resolvers.Mutation.sendChatMessage(
      {},
      { chatId: start.chatId, userMessage: 'hello world' },
      userCtx(adminUser.id),
    );

    await resolvers.Mutation.deleteChat({}, { chatId: start.chatId }, userCtx(adminUser.id));

    // Chat node should be deletedAt-stamped
    const chatNode = await db.node.findFirst({
      where: { loc: start.chatId },
    });
    expect(chatNode?.deletedAt).not.toBeNull();

    // Messages under it should be too
    const msgs = await db.node.findMany({
      where: { loc: { startsWith: `${start.chatId}:messages:` }, deletedAt: null },
    });
    expect(msgs.length).toBe(0);

    // And myChats shouldn't return it
    const chats = await resolvers.Query.myChats(
      {},
      { agentId: agent.id },
      userCtx(adminUser.id),
    );
    expect(chats.find((c) => c.loc === start.chatId)).toBeUndefined();
  });

  it('deleteChat refuses a non-owner', async () => {
    const start = await resolvers.Mutation.startChat(
      {},
      { agentId: agent.id },
      userCtx(adminUser.id),
    );
    await expect(
      resolvers.Mutation.deleteChat({}, { chatId: start.chatId }, userCtx(otherUser.id)),
    ).rejects.toThrow('Forbidden');
  });
});
