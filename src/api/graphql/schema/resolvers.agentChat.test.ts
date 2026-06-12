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
  // 008-agent-installation: personal-class memory pivots on (app_id, user_id).
  // The JWT-user startChat path resolves the App via App.agent_id matching the
  // chat agent inside the user's accessible orgs. Seed an App linking this
  // agent so personal-memory provisioning lands with class='personal'.
  await db.app.create({
    data: {
      id: generateId(),
      name: 'research-app',
      urn: `${orgA.urn}:research-app`,
      organizationId: orgA.id,
      appAgents: { create: { agentId: agent.id } },
    },
  });

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
    // 036-ai-service-config: the mutation upserts the Agent's 'default'
    // registry config; the legacy columns no longer exist.
    const config = await db.aiServiceConfig.findFirstOrThrow({
      where: { agentId: agent.id, name: 'default' },
    });
    expect(config.provider).toBe('anthropic');
    expect(config.model).toBe('claude-opus-4-6');
    expect(config.apiKeyEncrypted).toBeTruthy();
    expect(config.apiKeyEncrypted).not.toBe('sk-ant-test');

    // hasAiApiKey is a registry-backed field resolver.
    const resolved = await resolvers.Agent.hasAiApiKey(updated, {}, adminCtx());
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

  // 007-entity-id-or-urn: updateAgentAIConfig + clearAgentAIConfig
  // accept agentId as ID or URN.
  it('updateAgentAIConfig accepts a URN as agentId input', async () => {
    const stored = await db.agent.findUniqueOrThrow({
      where: { id: agent.id },
      select: { urn: true },
    });
    const updated = await resolvers.Mutation.updateAgentAIConfig(
      {},
      { agentId: stored.urn, provider: 'anthropic', apiKey: 'sk-ant-via-urn', model: 'claude-opus-4-6' },
      adminCtx(),
    );
    expect(updated.id).toBe(agent.id);
    const viaUrnConfig = await db.aiServiceConfig.findFirstOrThrow({
      where: { agentId: agent.id, name: 'default' },
    });
    expect(viaUrnConfig.provider).toBe('anthropic');
  });

  it('updateAgentAIConfig accepts a prefixed URN (urn:agent:...) as agentId input', async () => {
    const stored = await db.agent.findUniqueOrThrow({
      where: { id: agent.id },
      select: { urn: true },
    });
    const updated = await resolvers.Mutation.updateAgentAIConfig(
      {},
      { agentId: `urn:agent:${stored.urn}`, provider: 'anthropic', apiKey: 'sk-ant-via-prefix', model: 'claude-opus-4-6' },
      adminCtx(),
    );
    expect(updated.id).toBe(agent.id);
  });

  it('clearAgentAIConfig accepts a URN as agentId input', async () => {
    await resolvers.Mutation.updateAgentAIConfig(
      {},
      { agentId: agent.id, provider: 'anthropic', apiKey: 'sk', model: 'claude-opus-4-6' },
      adminCtx(),
    );
    const stored = await db.agent.findUniqueOrThrow({
      where: { id: agent.id },
      select: { urn: true },
    });
    const cleared = await resolvers.Mutation.clearAgentAIConfig(
      {},
      { agentId: stored.urn },
      adminCtx(),
    );
    expect(cleared.id).toBe(agent.id);
    const remaining = await db.aiServiceConfig.findFirst({
      where: { agentId: agent.id, name: 'default' },
    });
    expect(remaining).toBeNull();
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
    expect(await resolvers.Agent.aiProvider(cleared, {}, adminCtx())).toBeNull();
    expect(await resolvers.Agent.hasAiApiKey(cleared, {}, adminCtx())).toBe(false);
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
    expect(mem?.visibility).toBeNull();
    expect(mem?.urn).toContain(':user:');

    // Verify the chat node exists inside that memory
    const chatNode = await db.node.findFirst({
      where: { memoryId: mem!.id, loc: result.chatId },
    });
    expect(chatNode).not.toBeNull();
    expect((chatNode!.data as Record<string, unknown>).conversationName).toBe('research');
    expect((chatNode!.data as Record<string, unknown>).stageName).toBe('scope');
  });

  // Spec 019: the Tester portal endpoint passes isTestRun=true so a
  // probe doesn't silently grant an AgentSubscription as a side effect.
  // AgentSubscription was narrowed in 2026-05-12-user-installing-app to
  // the license-grant role only; the Tester is a chatbot-feature concern
  // that must not re-broaden it.
  it('isTestRun=true does NOT auto-provision an AgentSubscription', async () => {
    // Pre-condition: no subscription for (otherUser, agent) yet.
    const before = await db.agentSubscription.findUnique({
      where: { userId_agentId: { userId: otherUser.id, agentId: agent.id } },
    });
    expect(before).toBeNull();

    const result = await resolvers.Mutation.startChat(
      {},
      { agentId: agent.id, isTestRun: true },
      userCtx(otherUser.id),
    );
    // The chat itself is still created — only the cross-cutting
    // subscription side-effect is skipped.
    expect(result.chatId).toMatch(/^chats:/);

    const after = await db.agentSubscription.findUnique({
      where: { userId_agentId: { userId: otherUser.id, agentId: agent.id } },
    });
    expect(after).toBeNull();
  });

  // Control case: the default (isTestRun unset / false) still provisions.
  it('isTestRun=false (default) DOES auto-provision an AgentSubscription', async () => {
    await resolvers.Mutation.startChat({}, { agentId: agent.id }, userCtx(otherUser.id));
    const sub = await db.agentSubscription.findUnique({
      where: { userId_agentId: { userId: otherUser.id, agentId: agent.id } },
    });
    expect(sub).not.toBeNull();
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

  // 007-entity-id-or-urn: startChat accepts agentId as ID or URN.
  it('accepts a URN as agentId input', async () => {
    const stored = await db.agent.findUniqueOrThrow({
      where: { id: agent.id },
      select: { urn: true },
    });
    const result = await resolvers.Mutation.startChat(
      {},
      { agentId: stored.urn },
      userCtx(adminUser.id),
    );
    expect(result.chatId).toMatch(/^chats:/);
    // Chat node lives in a memory tied to the resolved agent ID.
    const mem = await db.memory.findFirst({
      where: { userMemoryOfAgentId: agent.id, createdBy: adminUser.id },
    });
    expect(mem).not.toBeNull();
  });

  it('accepts a prefixed URN (urn:agent:...) as agentId input', async () => {
    const stored = await db.agent.findUniqueOrThrow({
      where: { id: agent.id },
      select: { urn: true },
    });
    const result = await resolvers.Mutation.startChat(
      {},
      { agentId: `urn:agent:${stored.urn}` },
      userCtx(adminUser.id),
    );
    expect(result.chatId).toMatch(/^chats:/);
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

  // Regression: when the agent has no matching App in the caller's orgs,
  // startChat downgrades the per-user chat memory from class='personal'
  // to class='knowledge' (still bound via userMemoryOfAgentId, owned by
  // the caller). The chatHistory auth check used to only allow class
  // 'personal' or 'app', so the caller got Forbidden on their own chat.
  // The fix authorizes any userMemoryOfAgentId-bound memory via createdBy,
  // regardless of the personal-vs-knowledge label.
  it('allows the owner to read a chat in a knowledge-class user memory (no matching App)', async () => {
    // Set up an isolated agent without a matching App so the lazy-
    // provisioned per-user memory lands at class='knowledge'.
    const noAppAgent = await resolvers.Mutation.createAgent(
      {},
      { orgId: orgA.id, name: 'no-app-agent', visibility: 'ORGANIZATION' },
      adminCtx(),
    );
    const noAppSysMem = await resolvers.Mutation.createMemory(
      {},
      { orgId: orgA.id, name: 'no-app-system' },
      adminCtx(),
    );
    await resolvers.Mutation.updateAgent(
      {},
      { id: noAppAgent.id, systemMemoryId: noAppSysMem.id },
      adminCtx(),
    );
    // Seed minimal conversation + stage so startChat can find a first stage.
    const seedNodes = [
      { loc: 'conversations', name: 'conversations', nodeType: 'system' },
      {
        loc: 'conversations:default',
        name: 'default',
        nodeType: 'system',
        data: { stageOrder: ['greet'], isSetup: false },
      },
      {
        loc: 'conversations:default:greet',
        name: 'greet',
        nodeType: 'system',
        data: { promptRef: 'prompts:default:greet' },
      },
      { loc: 'prompts', name: 'prompts', nodeType: 'system' },
      { loc: 'prompts:default', name: 'default', nodeType: 'system' },
      {
        loc: 'prompts:default:greet',
        name: 'greet',
        nodeType: 'system',
        content: 'Greet the user.',
      },
    ];
    for (const n of seedNodes) {
      await db.node.create({
        data: {
          id: generateId(),
          memoryId: noAppSysMem.id,
          loc: n.loc,
          name: n.name,
          nodeType: n.nodeType,
          data: (n as any).data ?? null,
          content: (n as any).content ?? null,
        },
      });
    }

    const start = await resolvers.Mutation.startChat(
      {},
      { agentId: noAppAgent.id },
      userCtx(adminUser.id),
    );

    // Verify the holding memory is class='knowledge' — this is the case
    // the original Forbidden bug missed.
    const chatNode = await db.node.findFirstOrThrow({ where: { loc: start.chatId } });
    const holdingMem = await db.memory.findUniqueOrThrow({
      where: { id: chatNode.memoryId },
      select: { class: true, userMemoryOfAgentId: true, createdBy: true },
    });
    expect(holdingMem.class).toBe('knowledge');
    expect(holdingMem.userMemoryOfAgentId).toBe(noAppAgent.id);
    expect(holdingMem.createdBy).toBe(adminUser.id);

    await resolvers.Mutation.sendChatMessage(
      {},
      { chatId: start.chatId, userMessage: 'hi' },
      userCtx(adminUser.id),
    );

    // Owner can read.
    const history = await resolvers.Query.chatHistory(
      {},
      { chatId: start.chatId },
      userCtx(adminUser.id),
    );
    expect(history.length).toBe(1);
    expect(history[0].role).toBe('user');
    expect(history[0].content).toBe('hi');

    // Non-owner still cannot.
    await expect(
      resolvers.Query.chatHistory({}, { chatId: start.chatId }, userCtx(otherUser.id)),
    ).rejects.toThrow('Forbidden');
  });

  // Regression for Constitution Invariant #14: role detection must not
  // depend on the agent's name. The pre-cleanup code used
  // `name.includes('juno')` to mark messages as assistant — which means a
  // user message authored by a user whose handle was 'juno' (or any
  // string containing it) would be misclassified as an assistant message.
  // The cleanup writes data.role on each message node and reads from
  // there; the role no longer depends on the agent's name appearing
  // anywhere.
  it('role detection does not depend on agent-name substrings (Invariant #14)', async () => {
    const start = await resolvers.Mutation.startChat(
      {},
      { agentId: agent.id },
      userCtx(adminUser.id),
    );

    // The chatNode's userId determines the user-message loc suffix. Set
    // it to a value that *contains* known agent names ('juno', 'mealplan')
    // — pre-cleanup, this would misclassify the message as assistant.
    const chatNode = await db.node.findFirstOrThrow({
      where: { loc: start.chatId },
    });
    const data = (chatNode.data as Record<string, unknown>) ?? {};
    await db.node.update({
      where: { id: chatNode.id },
      data: { data: { ...data, userId: 'mealplan-juno-fan' } as any },
    });

    await resolvers.Mutation.sendChatMessage(
      {},
      { chatId: start.chatId, userMessage: 'I love both of those agents' },
      userCtx(adminUser.id),
    );
    await resolvers.Mutation.processChatResponse(
      {},
      {
        chatId: start.chatId,
        toolResponse: { message: 'Glad to hear it!', data: null, next_stage: null },
      },
      userCtx(adminUser.id),
    );

    const history = await resolvers.Query.chatHistory(
      {},
      { chatId: start.chatId },
      userCtx(adminUser.id),
    );
    // Without the cleanup, history[0].role would be 'assistant' because
    // the loc suffix `-mealplan-juno-fan` matches `name.includes('juno')`.
    // With data.role driving the decision, the message is correctly
    // classified as user.
    expect(history[0].role).toBe('user');
    expect(history[0].content).toBe('I love both of those agents');
    expect(history[1].role).toBe('assistant');
    expect(history[1].content).toBe('Glad to hear it!');

    // Belt-and-braces: the message nodes carry the explicit role on
    // node.data so any other consumer (the message-history reader in
    // sendChatMessage, an MCP tool, an audit query) gets the correct
    // answer without having to parse loc strings.
    const userMsg = await db.node.findFirstOrThrow({
      where: { loc: { contains: '-mealplan-juno-fan' }, deletedAt: null },
    });
    const assistantMsg = await db.node.findFirstOrThrow({
      where: { loc: { endsWith: '-assistant' }, deletedAt: null },
    });
    expect((userMsg.data as { role?: string } | null)?.role).toBe('user');
    expect((assistantMsg.data as { role?: string } | null)?.role).toBe('assistant');
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

// ---------------------------------------------------------------------------
// Spec 017 — chat scope (US1: private path + invariant gate)
// ---------------------------------------------------------------------------

describe('spec 017 — chat scope (US2 shared path)', () => {
  async function makeAppMember(appUrn: string, userId: string, role = 'member'): Promise<void> {
    const app = await db.app.findFirstOrThrow({ where: { urn: appUrn } });
    await db.appMember.create({ data: { appId: app.id, userId, role } });
  }

  it("creates a shared chat in an app-class memory, idempotent on a second call", async () => {
    await makeAppMember(`${orgA.urn}:research-app`, adminUser.id);
    const r1 = await resolvers.Mutation.startChat(
      {},
      { agentId: agent.id, scope: 'shared' },
      userCtx(adminUser.id),
    );
    const r2 = await resolvers.Mutation.startChat(
      {},
      { agentId: agent.id, scope: 'shared' },
      userCtx(adminUser.id),
    );
    expect(r1.chatId).not.toBe(r2.chatId);

    // Both chats land in the SAME app-class memory.
    const chat1 = await db.node.findFirstOrThrow({ where: { loc: r1.chatId } });
    const chat2 = await db.node.findFirstOrThrow({ where: { loc: r2.chatId } });
    expect(chat1.memoryId).toBe(chat2.memoryId);

    const sharedMem = await db.memory.findUniqueOrThrow({ where: { id: chat1.memoryId } });
    expect(sharedMem.class).toBe('app');
    expect(sharedMem.urn).toMatch(/:shared$/);

    // Only one app-class memory provisioned per App (idempotency).
    const all = await db.memory.findMany({
      where: { appId: sharedMem.appId!, class: 'app', deletedAt: null },
    });
    expect(all.length).toBe(1);

    // Chat-root carries scope='shared'.
    expect((chat1.data as Record<string, unknown>).scope).toBe('shared');
  });

  it("rejects scope='shared' when the caller has no qualifying AppMember row", async () => {
    // adminUser is NOT an AppMember here.
    await expect(
      resolvers.Mutation.startChat(
        {},
        { agentId: agent.id, scope: 'shared' },
        userCtx(adminUser.id),
      ),
    ).rejects.toThrow(/SHARED_CHAT_REQUIRES_APP_CONTEXT|not a member/);
  });

  it("rejects scope='shared' from an MCP App-key session with a distinct error code", async () => {
    // research.md Q-R2: App-key sessions are private-only in v1. The
    // rejection message must distinguish this from the no-AppMember case
    // so SC-005 callers see something actionable.
    const app = await db.app.findFirstOrThrow({
      where: { urn: `${orgA.urn}:research-app` },
    });
    await expect(
      resolvers.Mutation.startChat(
        {},
        { agentId: agent.id, scope: 'shared' },
        userCtx(adminUser.id, { appId: app.id }),
      ),
    ).rejects.toThrow(/SHARED_CHAT_NOT_AVAILABLE_FOR_APP_SESSIONS|App-key/);
  });

  it("myChats returns the union of caller's private chats and all shared chats in apps they belong to", async () => {
    await makeAppMember(`${orgA.urn}:research-app`, adminUser.id);
    await makeAppMember(`${orgA.urn}:research-app`, otherUser.id);

    // adminUser: one private, one shared
    const adminPriv = await resolvers.Mutation.startChat(
      {}, { agentId: agent.id, scope: 'private' }, userCtx(adminUser.id),
    );
    const adminShared = await resolvers.Mutation.startChat(
      {}, { agentId: agent.id, scope: 'shared' }, userCtx(adminUser.id),
    );

    // otherUser: one private, one shared
    const otherPriv = await resolvers.Mutation.startChat(
      {}, { agentId: agent.id, scope: 'private' }, userCtx(otherUser.id),
    );
    const otherShared = await resolvers.Mutation.startChat(
      {}, { agentId: agent.id, scope: 'shared' }, userCtx(otherUser.id),
    );

    // adminUser sees: own private + both shared (both are in app-class memory).
    const adminList = await resolvers.Query.myChats(
      {}, { agentId: agent.id }, userCtx(adminUser.id),
    );
    const adminLocs = new Set(adminList.map((c) => c.loc));
    expect(adminLocs.has(adminPriv.chatId)).toBe(true);
    expect(adminLocs.has(adminShared.chatId)).toBe(true);
    expect(adminLocs.has(otherShared.chatId)).toBe(true);
    expect(adminLocs.has(otherPriv.chatId)).toBe(false);

    // otherUser sees: own private + both shared. NOT adminUser's private.
    const otherList = await resolvers.Query.myChats(
      {}, { agentId: agent.id }, userCtx(otherUser.id),
    );
    const otherLocs = new Set(otherList.map((c) => c.loc));
    expect(otherLocs.has(otherPriv.chatId)).toBe(true);
    expect(otherLocs.has(otherShared.chatId)).toBe(true);
    expect(otherLocs.has(adminShared.chatId)).toBe(true);
    expect(otherLocs.has(adminPriv.chatId)).toBe(false);

    // Returned scope field is populated correctly.
    const adminPrivRow = adminList.find((c) => c.loc === adminPriv.chatId);
    const adminSharedRow = adminList.find((c) => c.loc === adminShared.chatId);
    expect(adminPrivRow?.scope).toBe('private');
    expect(adminSharedRow?.scope).toBe('shared');
  });

  it("chatHistory: non-author AppMember can read a shared chat's messages", async () => {
    await makeAppMember(`${orgA.urn}:research-app`, adminUser.id);
    await makeAppMember(`${orgA.urn}:research-app`, otherUser.id);
    const shared = await resolvers.Mutation.startChat(
      {}, { agentId: agent.id, scope: 'shared' }, userCtx(adminUser.id),
    );
    // adminUser posts a message
    await resolvers.Mutation.sendChatMessage(
      {}, { chatId: shared.chatId, userMessage: 'hi family' }, userCtx(adminUser.id),
    );
    // otherUser reads the chat history (they're an AppMember, not the author)
    const history = await resolvers.Query.chatHistory(
      {}, { chatId: shared.chatId }, userCtx(otherUser.id),
    );
    expect(history.length).toBeGreaterThan(0);
  });

  it("chatHistory: non-AppMember cannot read a shared chat's messages", async () => {
    await makeAppMember(`${orgA.urn}:research-app`, adminUser.id);
    // otherUser is intentionally NOT an AppMember of research-app.
    const shared = await resolvers.Mutation.startChat(
      {}, { agentId: agent.id, scope: 'shared' }, userCtx(adminUser.id),
    );
    await resolvers.Mutation.sendChatMessage(
      {}, { chatId: shared.chatId, userMessage: 'secret family chat' }, userCtx(adminUser.id),
    );
    await expect(
      resolvers.Query.chatHistory(
        {}, { chatId: shared.chatId }, userCtx(otherUser.id),
      ),
    ).rejects.toThrow('Forbidden');
  });

  it("deleteChat: only the chat author can delete a shared chat, not any AppMember", async () => {
    await makeAppMember(`${orgA.urn}:research-app`, adminUser.id);
    await makeAppMember(`${orgA.urn}:research-app`, otherUser.id);
    const shared = await resolvers.Mutation.startChat(
      {}, { agentId: agent.id, scope: 'shared' }, userCtx(adminUser.id),
    );
    // otherUser is an AppMember but not the chat author → cannot delete.
    await expect(
      resolvers.Mutation.deleteChat({}, { chatId: shared.chatId }, userCtx(otherUser.id)),
    ).rejects.toThrow('Forbidden');
    // adminUser (the author) → can delete.
    const result = await resolvers.Mutation.deleteChat(
      {}, { chatId: shared.chatId }, userCtx(adminUser.id),
    );
    expect(result).toBe(true);
  });
});

describe('spec 017 — chat scope (US1 private path)', () => {
  it('startChat creates a chat with data.scope="private" in a personal-class memory', async () => {
    const result = await resolvers.Mutation.startChat(
      {},
      { agentId: agent.id },
      userCtx(adminUser.id),
    );

    // The holding memory is personal-class for a JWT-user private chat.
    const memory = await db.memory.findFirst({
      where: { userMemoryOfAgentId: agent.id, createdBy: adminUser.id },
    });
    expect(memory).not.toBeNull();
    expect(memory!.class).toBe('personal');

    // The chat-root node carries the scope as data.scope='private'.
    const chatNode = await db.node.findFirst({
      where: { memoryId: memory!.id, loc: result.chatId },
    });
    expect(chatNode).not.toBeNull();
    expect((chatNode!.data as Record<string, unknown>).scope).toBe('private');
  });

  it('sendChatMessage rejects a chat-root whose data.scope contradicts the holding memory class', async () => {
    // Start a real private chat first (so memory + chat-root are real).
    const start = await resolvers.Mutation.startChat(
      {},
      { agentId: agent.id },
      userCtx(adminUser.id),
    );
    const memory = await db.memory.findFirst({
      where: { userMemoryOfAgentId: agent.id, createdBy: adminUser.id },
    });
    const chatNode = await db.node.findFirstOrThrow({
      where: { memoryId: memory!.id, loc: start.chatId },
    });

    // Corrupt the chat-root: claim scope=shared while the memory is
    // personal-class. The validate gate inside sendChatMessage MUST
    // catch this before doing any chat work.
    const corruptedData = { ...(chatNode.data as Record<string, unknown>), scope: 'shared' };
    await db.node.update({
      where: { id: chatNode.id },
      data: { data: corruptedData as never },
    });

    await expect(
      resolvers.Mutation.sendChatMessage(
        {},
        { chatId: start.chatId, userMessage: 'hello' },
        userCtx(adminUser.id),
      ),
    ).rejects.toThrow(/CHAT_MEMORY_OUT_OF_SCOPE|scope=shared/);
  });

  it('sendChatMessage tolerates a pre-feature chat with no data.scope (migration window)', async () => {
    // Simulate a chat created before the feature shipped: a chat-root
    // in personal-class memory with no `scope` field. The validator
    // accepts this when allowMissingScope is set (which sendChatMessage
    // passes for the duration of the migration window — FR-017/T036).
    const start = await resolvers.Mutation.startChat(
      {},
      { agentId: agent.id },
      userCtx(adminUser.id),
    );
    const memory = await db.memory.findFirst({
      where: { userMemoryOfAgentId: agent.id, createdBy: adminUser.id },
    });
    const chatNode = await db.node.findFirstOrThrow({
      where: { memoryId: memory!.id, loc: start.chatId },
    });
    const dataWithoutScope = { ...(chatNode.data as Record<string, unknown>) };
    delete dataWithoutScope.scope;
    await db.node.update({
      where: { id: chatNode.id },
      data: { data: dataWithoutScope as never },
    });

    // Should NOT throw — pre-feature chats are tolerated until backfill.
    const result = await resolvers.Mutation.sendChatMessage(
      {},
      { chatId: start.chatId, userMessage: 'still works' },
      userCtx(adminUser.id),
    );
    expect(result).toBeDefined();
  });
});
