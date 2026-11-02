import { isRawChatNode } from '../../../services/embedding/rawChat.js';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BROKEN_INCLUDE_NOTICE as N } from '../../../lib/includes/spliceIncludes.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, chatNodeByLoc, chatNodeByLocOrThrow } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { generateId } from '../../../lib/id.js';
import { serveAgentBootPrompt, serveEveryAgent } from '../../../test/servedBootPrompt.js';
import { withChatRootLock } from '../../../lib/chatRoot.js';
import { lockAuthorityAnchors } from '../../../lib/auth/authorityAnchors.js';
import { waitForLockWaitersOfType } from '../../../test/lockWait.js';

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
let agent: { id: string; organizationId: string | null };
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

  const created = await resolvers.Mutation.createAgent(
    {},
    { orgId: orgA.id, name: 'research-agent', visibility: 'ORGANIZATION' },
    adminCtx(),
  );
  agent = created;
  // createAgent now auto-provisions the agent's class='system' memory (#518);
  // read it straight off the returned agent rather than create + attach.
  systemMemory = await db.memory.findUniqueOrThrow({
    where: { id: created.systemMemoryId! },
  });
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
  // #2712: chats are served the Agent's boot prompt; an Agent without one is refused.
  await serveEveryAgent(db);
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
      { agentRef: agent.id },
      adminCtx(),
    );
    expect(cfg?.provider).toBe('anthropic');
    expect(cfg?.apiKey).toBe('sk-ant-abc');
    expect(cfg?.model).toBe('claude-opus-4-6');
  });

  // 007-entity-id-or-urn: agentAIConfig accepts agentRef as ID or URN.
  it('agentAIConfig accepts a URN as agentRef input', async () => {
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
      { agentRef: stored.urn },
      adminCtx(),
    );
    expect(cfg?.apiKey).toBe('sk-ant-urn');
  });

  it('agentAIConfig accepts a prefixed URN (urn:agent:...) as agentRef input', async () => {
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
      { agentRef: `urn:agent:${stored.urn}` },
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
      resolvers.Query.agentAIConfig({}, { agentRef: agent.id }, userCtx(otherUser.id)),
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
    // #697 Stage 3: per-user runtime memories store a FLAT single-atom v2 urn
    // (`<org>:<opaqueId>`); the app-user scope lives in the columns, not the URN.
    expect(mem?.urn?.split(':')).toHaveLength(2);
    expect(mem?.urn).not.toContain(':app-user:');

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
    // createAgent auto-provisions a system memory (#518), so a system-memory-less
    // agent only exists as a legacy row — build one directly to hit the guard.
    const naked = await db.agent.create({
      data: { id: generateId(), name: 'naked-agent', urn: `${orgA.urn}:naked-agent`, organizationId: orgA.id },
    });
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
      { agentRef: agent.id },
      userCtx(adminUser.id),
    );
    expect(adminChats.length).toBe(2);
    expect(adminChats.map((c) => c.loc).sort()).toEqual([c1.chatId, c2.chatId].sort());

    const otherChats = await resolvers.Query.myChats(
      {},
      { agentRef: agent.id },
      userCtx(otherUser.id),
    );
    expect(otherChats.length).toBe(1);
    expect(otherChats[0].loc).toBe(c3.chatId);
  });

  it('returns an empty list when the user has no memory for the agent yet', async () => {
    const result = await resolvers.Query.myChats(
      {},
      { agentRef: agent.id },
      userCtx(adminUser.id),
    );
    expect(result).toEqual([]);
  });

  // 007-entity-id-or-urn: myChats accepts agentRef as ID or URN.
  it('accepts a URN as agentRef input', async () => {
    const c1 = await resolvers.Mutation.startChat({}, { agentId: agent.id }, userCtx(adminUser.id));
    const stored = await db.agent.findUniqueOrThrow({
      where: { id: agent.id },
      select: { urn: true },
    });
    const chats = await resolvers.Query.myChats(
      {},
      { agentRef: stored.urn },
      userCtx(adminUser.id),
    );
    expect(chats.map((c) => c.loc)).toEqual([c1.chatId]);
  });

  it('accepts a prefixed URN (urn:agent:...) as agentRef input', async () => {
    const c1 = await resolvers.Mutation.startChat({}, { agentId: agent.id }, userCtx(adminUser.id));
    const stored = await db.agent.findUniqueOrThrow({
      where: { id: agent.id },
      select: { urn: true },
    });
    const chats = await resolvers.Query.myChats(
      {},
      { agentRef: `urn:agent:${stored.urn}` },
      userCtx(adminUser.id),
    );
    expect(chats.map((c) => c.loc)).toEqual([c1.chatId]);
  });

  it('#1115: summarizationNeeded is ALWAYS null, including at the old trigger points', async () => {
    // The trigger fired at every 20th message and asked the caller to produce a
    // summary — which `saveChatSummary` then stored as a node that the model
    // reads back as an ordinary USER turn, beside the messages it summarises.
    // So the loop grew the transcript it was supposed to compress.
    //
    // Disarmed rather than removed (@Holger, 2026-09-04): hadron-portal calls
    // `saveChatSummary` and reads this field, and three hadron-docs pages
    // document it, so returning null breaks the loop at its first link without
    // a breaking schema change.
    //
    // Driven to 20 and 40 specifically — the exact counts that used to fire.
    // A test that only sent a couple of messages would pass against the old
    // code too and prove nothing.
    const start = await resolvers.Mutation.startChat(
      {},
      { agentId: agent.id },
      userCtx(adminUser.id),
    );
    let last: { summarizationNeeded?: unknown } | null = null;
    for (let i = 1; i <= 40; i += 1) {
      last = await resolvers.Mutation.sendChatMessage(
        {},
        { chatId: start.chatId, userMessage: `turn ${i}` },
        userCtx(adminUser.id),
      );
      expect(last?.summarizationNeeded ?? null).toBeNull();
    }
    // Named explicitly so the failure says which boundary broke.
    expect(last?.summarizationNeeded ?? null).toBeNull();
  }, 60_000);

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
      { agentRef: agent.id },
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
      { agentRef: agent.id },
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
      { agentRef: agent.id },
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
    // #829: a caller with NO entitlement to this chat now gets not-found
    // rather than Forbidden — the chat-loc lookup filters to the caller's
    // entitled set before selecting, so an unentitled node is invisible, not
    // merely refused. That also removes an existence oracle for chat ids. A
    // caller who IS entitled but not authorized (e.g. a reader without write
    // access) still gets Forbidden — see below.
    await expect(
      resolvers.Query.chatHistory({}, { chatId: start.chatId }, userCtx(otherUser.id)),
    ).rejects.toThrow(/not found/i);
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
    // createAgent auto-provisions the system memory (#518); read it back.
    const noAppSysMem = await db.memory.findUniqueOrThrow({
      where: { id: noAppAgent.systemMemoryId! },
    });
    // #2712: created after beforeEach served the fixture, so serve it here.
    await serveAgentBootPrompt(db, noAppAgent.id, 'Test boot prompt.');
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
    const chatNode = await chatNodeByLocOrThrow(db, start.chatId);
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
    // #829: a caller with NO entitlement to this chat now gets not-found
    // rather than Forbidden — the chat-loc lookup filters to the caller's
    // entitled set before selecting, so an unentitled node is invisible, not
    // merely refused. That also removes an existence oracle for chat ids. A
    // caller who IS entitled but not authorized (e.g. a reader without write
    // access) still gets Forbidden — see below.
    await expect(
      resolvers.Query.chatHistory({}, { chatId: start.chatId }, userCtx(otherUser.id)),
    ).rejects.toThrow(/not found/i);
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

    // Historically the chatNode's userId determined the user-message loc
    // suffix, so a value *containing* a known agent name ('juno',
    // 'mealplan') would — pre-cleanup — misclassify the message as
    // assistant. Since #914 the suffix is the ROLE (`-user`) and no
    // user-controlled string reaches the loc at all, so this mutation can no
    // longer influence classification even in principle. It is kept, and
    // asserted on below, because that structural guarantee is worth pinning:
    // it is what retires the whole hazard class for new rows, while
    // `data.role` keeps protecting legacy rows that still carry an identity
    // in their suffix.
    const chatNode = await chatNodeByLocOrThrow(db, start.chatId);
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
      // loc-scope-ok: scoped to this fixture's chat loc; the holding memory
      // is startChat's to choose.
      where: { loc: { startsWith: `${start.chatId}:messages:` , endsWith: '-user' }, deletedAt: null },
    });
    const assistantMsg = await db.node.findFirstOrThrow({
      // loc-scope-ok: as above — a fixture-unique loc suffix, not a tenant key.
      where: { loc: { endsWith: '-assistant' }, deletedAt: null },
    });
    expect((userMsg.data as { role?: string } | null)?.role).toBe('user');
    expect((assistantMsg.data as { role?: string } | null)?.role).toBe('assistant');

    // #914: the poisoned `chatData.userId` above reached the loc before, and
    // now reaches nothing. The message address carries a role, not an
    // identity, so no user-chosen string can ever again make a user turn read
    // as an assistant turn through the suffix fallback.
    expect(userMsg.loc).not.toContain('mealplan-juno-fan');
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
    // #829: a caller with NO entitlement to this chat now gets not-found
    // rather than Forbidden — the chat-loc lookup filters to the caller's
    // entitled set before selecting, so an unentitled node is invisible, not
    // merely refused. That also removes an existence oracle for chat ids. A
    // caller who IS entitled but not authorized (e.g. a reader without write
    // access) still gets Forbidden — see below.
    await expect(
      resolvers.Mutation.updateChatTitle(
        {},
        { chatId: start.chatId, title: 'hijacked' },
        userCtx(otherUser.id),
      ),
    ).rejects.toThrow(/not found/i);
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
    const chatNode = await chatNodeByLoc(db, start.chatId, { includeDeleted: true });
    expect(chatNode?.deletedAt).not.toBeNull();

    // Messages under it should be too
    const msgs = await db.node.findMany({
      // loc-scope-ok: already scoped by the chat's own unique loc prefix.
      where: { loc: { startsWith: `${start.chatId}:messages:` }, deletedAt: null },
    });
    expect(msgs.length).toBe(0);

    // And myChats shouldn't return it
    const chats = await resolvers.Query.myChats(
      {},
      { agentRef: agent.id },
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
    // #829: a caller with NO entitlement to this chat now gets not-found
    // rather than Forbidden — the chat-loc lookup filters to the caller's
    // entitled set before selecting, so an unentitled node is invisible, not
    // merely refused. That also removes an existence oracle for chat ids. A
    // caller who IS entitled but not authorized (e.g. a reader without write
    // access) still gets Forbidden — see below.
    await expect(
      resolvers.Mutation.deleteChat({}, { chatId: start.chatId }, userCtx(otherUser.id)),
    ).rejects.toThrow(/not found/i);
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

  it('keeps bare shared-chat prompt refs local even when foreign knowledge is authorized', async () => {
    const appY = await db.app.findFirstOrThrow({ where: { urn: `${orgA.urn}:research-app` } });
    const appX = await db.app.create({
      data: {
        id: generateId(), name: 'other-app', urn: `${orgA.urn}:other-app`,
        organizationId: orgA.id, appAgents: { create: { agentId: agent.id } },
      },
    });
    await db.appMember.create({ data: { appId: appY.id, userId: adminUser.id, role: 'member' } });
    await db.appMember.create({ data: { appId: appY.id, userId: otherUser.id, role: 'member' } });
    const makeKnowledge = async (appId: string | null, slug: string, content: string) => {
      const memory = await db.memory.create({
        data: {
          id: generateId(), name: slug, urn: `${orgA.urn}:${slug}`,
          organizationId: orgA.id, class: 'knowledge', visibility: 'ORGANIZATION', appId,
        } as never,
      });
      await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: slug, name: slug, content } });
      await db.agentMemoryItem.create({ data: { id: generateId(), agentId: agent.id, memoryId: memory.id, role: 'read' } });
      return memory;
    };
    await makeKnowledge(appX.id, 'x-secret', 'X ONLY');
    await makeKnowledge(appY.id, 'y-secret', 'Y ONLY');
    await makeKnowledge(null, 'global-note', 'GLOBAL');
    const invalid = await makeKnowledge(null, 'invalid-note', 'INVALID ROLE');
    await db.agentMemoryItem.update({
      where: { agentId_memoryId: { agentId: agent.id, memoryId: invalid.id } },
      data: { role: 'bogus' },
    });
    const holding = await db.memory.create({
      data: {
        id: generateId(), name: 'user-holding', urn: `${orgA.urn}:user-holding`,
        organizationId: orgA.id, class: 'knowledge', visibility: 'ORGANIZATION',
        userMemoryOfAgentId: agent.id, createdBy: adminUser.id,
      } as never,
    });
    await db.node.create({ data: { id: generateId(), memoryId: holding.id, loc: 'user-holding', name: 'user-holding', content: 'PERSONAL HOLDING' } });
    await db.agentMemoryItem.create({ data: { id: generateId(), agentId: agent.id, memoryId: holding.id, role: 'read' } });
    const owned = await db.memory.create({
      data: {
        id: generateId(), name: 'owner-note', urn: `${orgA.urn}:owner-note`,
        ownerUserId: adminUser.id, class: 'knowledge', visibility: 'PUBLIC',
      } as never,
    });
    await db.node.create({ data: { id: generateId(), memoryId: owned.id, loc: 'owner-note', name: 'owner-note', content: 'OWNER ONLY' } });
    await db.agentMemoryItem.create({ data: { id: generateId(), agentId: agent.id, memoryId: owned.id, role: 'read' } });
    await db.node.update({
      where: { loc_memoryId: { loc: 'prompts:research:scope', memoryId: systemMemory.id } },
      data: { content: '{{> x-secret}} | {{> y-secret}} | {{> global-note}} | {{> owner-note}} | {{> user-holding}} | {{> invalid-note}}' },
    });

    const start = await resolvers.Mutation.startChat(
      {}, { agentId: agent.id, scope: 'shared' }, userCtx(adminUser.id),
    );
    // #1835: readable knowledge is a retrieval context, not a bare-loc
    // namespace. No foreign partial is borrowed before a local target exists.
    // #2712: the served boot prompt leads the system message.
    const B = 'Test boot prompt.\n\n';
    expect(start.systemMessage).toBe(`${B}${N} | ${N} | ${N} | ${N} | ${N} | ${N}`);
    const chatRoot = await chatNodeByLocOrThrow(db, start.chatId);
    await db.node.create({ data: { memoryId: chatRoot.memoryId, loc: 'y-secret', name: 'Local Y', content: 'LOCAL Y' } });
    await db.node.create({ data: { memoryId: chatRoot.memoryId, loc: 'global-note', name: 'Local global', content: 'LOCAL GLOBAL' } });
    const startedAgain = await resolvers.Mutation.startChat(
      {}, { agentId: agent.id, scope: 'shared' }, userCtx(adminUser.id),
    );
    expect(startedAgain.systemMessage).toBe(`${B}${N} | LOCAL Y | LOCAL GLOBAL | ${N} | ${N} | ${N}`);
    const sent = await resolvers.Mutation.sendChatMessage(
      {}, { chatId: start.chatId, userMessage: 'hello' }, userCtx(otherUser.id),
    );
    expect(sent.systemMessage).toBe(`${B}${N} | LOCAL Y | LOCAL GLOBAL | ${N} | ${N} | ${N}`);
  });

  it('does not restore an uninstalled Agent when sending to its retained shared chat', async () => {
    const app = await db.app.findFirstOrThrow({ where: { urn: `${orgA.urn}:research-app` } });
    await db.appMember.create({ data: { appId: app.id, userId: adminUser.id, role: 'member' } });
    const start = await resolvers.Mutation.startChat(
      {}, { agentId: agent.id, scope: 'shared' }, userCtx(adminUser.id),
    );
    expect(start.systemMessage).toContain('Scope the research.');
    await db.appAgent.delete({ where: { appId_agentId: { appId: app.id, agentId: agent.id } } });

    const sent = await resolvers.Mutation.sendChatMessage(
      {}, { chatId: start.chatId, userMessage: 'after uninstall' }, userCtx(adminUser.id),
    );
    expect(sent.systemMessage).toBe('');
    expect(sent.tools).toBeNull();
  });

  it('chooses a licensed App when an earlier member App has a retained inactive install', async () => {
    const original = await db.app.findFirstOrThrow({ where: { urn: `${orgA.urn}:research-app` } });
    const second = await db.app.create({
      data: {
        id: generateId(), name: 'second-app', urn: `${orgA.urn}:second-app`,
        organizationId: orgA.id, appAgents: { create: { agentId: agent.id } },
      },
    });
    for (const app of [original, second]) {
      await db.appMember.create({ data: { appId: app.id, userId: adminUser.id, role: 'member' } });
    }
    const [inactive, active] = [original, second].sort((a, b) => a.id.localeCompare(b.id));
    await db.app.update({ where: { id: inactive.id }, data: { uninstalledAt: new Date() } });

    const start = await resolvers.Mutation.startChat(
      {}, { agentId: agent.id, scope: 'shared' }, userCtx(adminUser.id),
    );
    const chat = await chatNodeByLocOrThrow(db, start.chatId);
    const memory = await db.memory.findUniqueOrThrow({ where: { id: chat.memoryId } });
    expect(memory.appId).toBe(active.id);
  });

  it('does not restore a cross-org Agent after its App grant is revoked', async () => {
    const orgB = await db.organization.create({
      data: { id: generateId(), name: 'chat-license-b', urn: 'chat-license-b' },
    });
    const appB = await db.app.create({
      data: {
        id: generateId(), name: 'chat-license-app', urn: `${orgB.urn}:chat-license-app`,
        organizationId: orgB.id, appAgents: { create: { agentId: agent.id } },
      },
    });
    await db.appMember.create({ data: { appId: appB.id, userId: adminUser.id, role: 'member' } });
    const grant = await db.agentOrgGrant.create({
      data: { orgId: orgB.id, agentId: agent.id, activatedAt: new Date() },
    });
    const start = await resolvers.Mutation.startChat(
      {}, { agentId: agent.id, scope: 'shared' }, userCtx(adminUser.id),
    );
    expect(start.systemMessage).toContain('Scope the research.');
    await db.agentOrgGrant.update({
      where: { orgId_agentId: { orgId: grant.orgId, agentId: grant.agentId } },
      data: { revokedAt: new Date() },
    });

    const sent = await resolvers.Mutation.sendChatMessage(
      {}, { chatId: start.chatId, userMessage: 'after revocation' }, userCtx(adminUser.id),
    );
    expect(sent.systemMessage).toBe('');
    expect(sent.tools).toBeNull();
    await expect(resolvers.Mutation.startChat(
      {}, { agentId: agent.id, scope: 'shared' }, userCtx(adminUser.id),
    )).rejects.toThrow(/no longer active/);
  });

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
    const chat1 = await chatNodeByLocOrThrow(db, r1.chatId);
    const chat2 = await chatNodeByLocOrThrow(db, r2.chatId);
    expect(chat1.memoryId).toBe(chat2.memoryId);

    const sharedMem = await db.memory.findUniqueOrThrow({ where: { id: chat1.memoryId } });
    expect(sharedMem.class).toBe('app');
    // #723: flat single-atom v2 urn; the (app, agent) pairing lives in columns.
    expect(sharedMem.urn).toMatch(/^[^:]+:[^:]+-shared$/);
    expect(sharedMem.sharedMemoryOfAgentId).toBe(agent.id);

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

  // -------------------------------------------------------------------------
  // #914 — message author attribution in a group chat
  //
  // Every chat in a multi-human memory IS a group chat: a chat has no ACL of
  // its own, so read and write both fall through the host memory's per-class
  // rules (cor:acl:030:01). These tests pin both halves — that a second member
  // may post at all, and that the record says who did.
  // -------------------------------------------------------------------------

  it('#914 — a second App member may post into a chat they did not create', async () => {
    // The premise the attribution fix rests on. If this ever starts throwing,
    // participation has been narrowed and cor:acl:030:01's group-chat property
    // has been broken — which is a contract change, not a bug fix.
    await makeAppMember(`${orgA.urn}:research-app`, adminUser.id);
    await makeAppMember(`${orgA.urn}:research-app`, otherUser.id);
    const start = await resolvers.Mutation.startChat(
      {},
      { agentId: agent.id, scope: 'shared' },
      userCtx(adminUser.id),
    );

    await expect(
      resolvers.Mutation.sendChatMessage(
        {},
        { chatId: start.chatId, userMessage: 'the other member speaking' },
        userCtx(otherUser.id),
      ),
    ).resolves.toBeDefined();
  });

  it('#914 — attributes a message to its SENDER, not to the chat creator', async () => {
    await makeAppMember(`${orgA.urn}:research-app`, adminUser.id);
    await makeAppMember(`${orgA.urn}:research-app`, otherUser.id);
    const start = await resolvers.Mutation.startChat(
      {},
      { agentId: agent.id, scope: 'shared' },
      userCtx(adminUser.id),
    );
    await resolvers.Mutation.sendChatMessage(
      {},
      { chatId: start.chatId, userMessage: 'the other member speaking' },
      userCtx(otherUser.id),
    );

    const chatNode = await chatNodeByLocOrThrow(db, start.chatId);
    const messages = await db.node.findMany({
      where: {
        memoryId: chatNode.memoryId,
        loc: { startsWith: `${start.chatId}:messages:` },
        deletedAt: null,
      },
      orderBy: { seq: 'asc' },
    });
    const userMsg = messages.find((m) => m.loc.endsWith('-user'));
    expect(userMsg).toBeDefined();
    expect(isRawChatNode(userMsg!)).toBe(true);

    // The whole point: before the fix this was adminUser (the creator).
    expect(userMsg!.createdBy).toBe(otherUser.id);
    expect(userMsg!.createdBy).not.toBe(adminUser.id);
    expect((userMsg!.data as Record<string, unknown>).authorUserId).toBe(otherUser.id);

    // And the loc no longer encodes an identity at all — it carries the ROLE,
    // mirroring `-assistant`, so no reader can mistake the address for the
    // author.
    expect(userMsg!.loc).not.toContain(adminUser.id);
    expect(userMsg!.loc).not.toContain(otherUser.id);
  });

  it('#914 — two members sending at once both persist (no loc collision)', async () => {
    // Pre-#914 the loc suffix was the chat CREATOR's id — identical for every
    // sender — so two sends that derived the same msgNum collided on
    // `@@unique([loc, memoryId])` and one member's message was lost. #916 added
    // the short random component; #919 then made the counter atomic, so two
    // sends no longer derive the same msgNum in the first place.
    //
    // This test keeps the random component honest by forcing the condition the
    // allocator now prevents — it rewinds the counter so the second send
    // genuinely reuses msgNum 001. That is the backstop's only remaining job,
    // and it is why the component was kept: what must not happen, under any
    // counter state, is losing someone's message.
    await makeAppMember(`${orgA.urn}:research-app`, adminUser.id);
    await makeAppMember(`${orgA.urn}:research-app`, otherUser.id);
    const start = await resolvers.Mutation.startChat(
      {},
      { agentId: agent.id, scope: 'shared' },
      userCtx(adminUser.id),
    );

    // Driving this with real concurrency does NOT reproduce it — the two
    // calls' DB round-trips serialize in practice, so such a test passes with
    // or without the fix. Rewinding the counter between two sequential sends
    // reproduces the exact condition a race produces — two sends deriving the
    // same msgNum — deterministically.
    await resolvers.Mutation.sendChatMessage(
      {}, { chatId: start.chatId, userMessage: 'from the creator' }, userCtx(adminUser.id),
    );
    const mid = await chatNodeByLocOrThrow(db, start.chatId);
    await db.node.update({
      where: { id: mid.id },
      data: {
        data: {
          ...((mid.data as Record<string, unknown>) ?? {}),
          messageCount: 0,
        } as never,
      },
    });
    await expect(
      resolvers.Mutation.sendChatMessage(
        {}, { chatId: start.chatId, userMessage: 'from the other member' }, userCtx(otherUser.id),
      ),
    ).resolves.toBeDefined();

    const chatNode = await chatNodeByLocOrThrow(db, start.chatId);
    const userMsgs = await db.node.findMany({
      where: {
        memoryId: chatNode.memoryId,
        loc: { startsWith: `${start.chatId}:messages:`, endsWith: '-user' },
        deletedAt: null,
      },
    });
    expect(userMsgs).toHaveLength(2);
    // And each is attributed to whoever actually sent it.
    expect(new Set(userMsgs.map((m) => m.createdBy))).toEqual(
      new Set([adminUser.id, otherUser.id]),
    );
  });

  it('#914 — records the creator on the chat root, and leaves the assistant turn system-authored', async () => {
    await makeAppMember(`${orgA.urn}:research-app`, adminUser.id);
    const start = await resolvers.Mutation.startChat(
      {},
      { agentId: agent.id, scope: 'shared' },
      userCtx(adminUser.id),
    );
    await resolvers.Mutation.sendChatMessage(
      {},
      { chatId: start.chatId, userMessage: 'hello' },
      userCtx(adminUser.id),
    );
    // The assistant turn is written by processChatResponse, not by
    // sendChatMessage — without this call there is no assistant message and
    // the assertion below would silently pass on an empty find.
    await resolvers.Mutation.processChatResponse(
      {},
      {
        chatId: start.chatId,
        toolResponse: { message: 'hello back', data: null, next_stage: null },
      },
      userCtx(adminUser.id),
    );

    const chatNode = await chatNodeByLocOrThrow(db, start.chatId);
    expect(chatNode.createdBy).toBe(adminUser.id);

    // NULL on the assistant turn means "the platform wrote this"
    // (cor:dmo:010:01 admits the system as an author) — never the sending
    // user, which would assert a human wrote the model's words.
    const messages = await db.node.findMany({
      where: {
        memoryId: chatNode.memoryId,
        loc: { startsWith: `${start.chatId}:messages:` },
        deletedAt: null,
      },
    });
    const assistantMsg = messages.find((m) => m.loc.endsWith('-assistant'));
    expect(assistantMsg).toBeDefined();
    expect(isRawChatNode(assistantMsg!)).toBe(true);
    expect(assistantMsg!.createdBy).toBeNull();
  });

  // -------------------------------------------------------------------------
  // #919 — the message number is allocated atomically
  //
  // `seq` is what every transcript reader orders by, and `messageCount` also
  // drives the summarization trigger and the `chat.message_count` edge operand.
  // Both used to come from a read-modify-write spanning the whole turn.
  //
  // The lock/allocator itself is pinned deterministically in
  // src/lib/chatRoot.test.ts (an in-flight allocation is held open and the next
  // one is observed waiting). These tests assert the property END TO END: after
  // any interleaving of real chat turns, the numbers still describe the
  // transcript. Both concurrent ones were checked against the pre-fix resolver
  // and fail there — unlike #914's loc-collision case, these two turns really
  // do interleave, because each holds a transaction open across an insert.
  // -------------------------------------------------------------------------

  /** Every message row of a chat, oldest number first. */
  async function messagesOf(chatId: string) {
    const chatNode = await chatNodeByLocOrThrow(db, chatId);
    const rows = await db.node.findMany({
      where: {
        memoryId: chatNode.memoryId,
        loc: { startsWith: `${chatId}:messages:` },
        deletedAt: null,
      },
      // Same total order the production readers use — `loc` is unique per
      // memory, so it settles a `seq`+`createdAt` tie that would otherwise
      // leave the assertion at the planner's mercy.
      orderBy: [{ seq: 'asc' }, { createdAt: 'asc' }, { loc: 'asc' }],
    });
    return {
      rows,
      messageCount: ((chatNode.data as Record<string, unknown>)?.messageCount as number) ?? 0,
    };
  }

  it('#919 — two members sending at once get distinct seq, and the count matches', async () => {
    await makeAppMember(`${orgA.urn}:research-app`, adminUser.id);
    await makeAppMember(`${orgA.urn}:research-app`, otherUser.id);
    const start = await resolvers.Mutation.startChat(
      {}, { agentId: agent.id, scope: 'shared' }, userCtx(adminUser.id),
    );

    await Promise.all([
      resolvers.Mutation.sendChatMessage(
        {}, { chatId: start.chatId, userMessage: 'from the creator' }, userCtx(adminUser.id),
      ),
      resolvers.Mutation.sendChatMessage(
        {}, { chatId: start.chatId, userMessage: 'from the other member' }, userCtx(otherUser.id),
      ),
    ]);

    const { rows, messageCount } = await messagesOf(start.chatId);
    expect(rows).toHaveLength(2);
    // Distinct numbers — a shared seq leaves the two members' messages in an
    // order the reader picks arbitrarily, and differently between reads.
    expect(rows.map((m) => m.seq)).toEqual([1, 2]);
    // And the count is the real number of messages, not one short of it.
    expect(messageCount).toBe(2);
  });

  it('#919 — an assistant turn racing a send leaves the count whole', async () => {
    // The other half of the same defect: the chat root is stored as ONE blob,
    // so a turn that reads it at its start and writes it back at its end can
    // roll back a send that committed in between — count included.
    await makeAppMember(`${orgA.urn}:research-app`, adminUser.id);
    await makeAppMember(`${orgA.urn}:research-app`, otherUser.id);
    const start = await resolvers.Mutation.startChat(
      {}, { agentId: agent.id, scope: 'shared' }, userCtx(adminUser.id),
    );
    await resolvers.Mutation.sendChatMessage(
      {}, { chatId: start.chatId, userMessage: 'opening' }, userCtx(adminUser.id),
    );

    await Promise.all([
      resolvers.Mutation.processChatResponse(
        {},
        { chatId: start.chatId, toolResponse: { message: 'answering', data: null, next_stage: 'analysis' } },
        userCtx(adminUser.id),
      ),
      resolvers.Mutation.sendChatMessage(
        {}, { chatId: start.chatId, userMessage: 'interrupting' }, userCtx(otherUser.id),
      ),
    ]);

    const { rows, messageCount } = await messagesOf(start.chatId);
    expect(rows).toHaveLength(3);
    expect(rows.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(messageCount).toBe(3);
    // The turn's own change survived the switch to applying it on fresh data.
    const chatNode = await chatNodeByLocOrThrow(db, start.chatId);
    expect((chatNode.data as Record<string, unknown>).stageName).toBe('analysis');
  });

  it('#919 — a rename waits for an in-flight turn instead of restoring its count', async () => {
    // `updateChatTitle` looks nothing like a message write, but it persists the
    // whole root blob — so before it went through the serializer it could put
    // back the `messageCount` that was current when its entitlement query ran,
    // and the next send would reuse a live `seq`. Every whole-root writer has to
    // be on the same protocol, not just the ones that allocate.
    //
    // Racing the two with Promise.all does NOT reproduce this (a rename opens no
    // transaction, so the round trips serialize on their own and it passes
    // either way). Holding the chat lock open around a committed count does:
    // pre-fix the rename sails past and reverts it.
    await makeAppMember(`${orgA.urn}:research-app`, adminUser.id);
    const start = await resolvers.Mutation.startChat(
      {}, { agentId: agent.id, scope: 'shared' }, userCtx(adminUser.id),
    );
    await resolvers.Mutation.sendChatMessage(
      {}, { chatId: start.chatId, userMessage: 'opening' }, userCtx(adminUser.id),
    );
    const chatNode = await chatNodeByLocOrThrow(db, start.chatId);
    const chatRef = { id: chatNode.id, memoryId: chatNode.memoryId, loc: chatNode.loc };
    const memEnc = { id: chatNode.memoryId, isEncrypted: false };

    // A turn is mid-flight: it has raised the count to 2 and still holds the
    // lock, exactly as a send does between its insert and its commit.
    let release: () => void = () => {};
    let announceHeld: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const held = new Promise<void>((r) => { announceHeld = r; });
    const turn = withChatRootLock(db, chatRef, memEnc, async ({ chatData }) => {
      announceHeld();
      await gate;
      return { chatData: { ...chatData, messageCount: 2 }, value: null };
    });
    await held;

    let renamed = false;
    const rename = resolvers.Mutation.updateChatTitle(
      {}, { chatId: start.chatId, title: 'Renamed mid-conversation' }, userCtx(adminUser.id),
    ).then(() => { renamed = true; });

    // Pre-fix the rename completes here, on the blob it read before the turn.
    await new Promise((r) => setTimeout(r, 150));
    expect(renamed).toBe(false);

    release();
    await turn;
    await rename;

    const after = await chatNodeByLocOrThrow(db, start.chatId);
    const data = after.data as Record<string, unknown>;
    // The rename landed AND the turn's count survived it — applying to fresh
    // data is not the same as dropping the write.
    expect(data.title).toBe('Renamed mid-conversation');
    expect(data.messageCount).toBe(2);
  });

  it('#919 — mixed sequential turns number 1..N with no gaps or repeats', async () => {
    await makeAppMember(`${orgA.urn}:research-app`, adminUser.id);
    const start = await resolvers.Mutation.startChat(
      {}, { agentId: agent.id, scope: 'shared' }, userCtx(adminUser.id),
    );
    for (const turn of ['first', 'second']) {
      await resolvers.Mutation.sendChatMessage(
        {}, { chatId: start.chatId, userMessage: turn }, userCtx(adminUser.id),
      );
      await resolvers.Mutation.processChatResponse(
        {},
        { chatId: start.chatId, toolResponse: { message: `re: ${turn}`, data: null, next_stage: null } },
        userCtx(adminUser.id),
      );
    }

    const { rows, messageCount } = await messagesOf(start.chatId);
    expect(rows.map((m) => m.seq)).toEqual([1, 2, 3, 4]);
    expect(rows.map((m) => m.loc.endsWith('-assistant'))).toEqual([false, true, false, true]);
    expect(messageCount).toBe(4);
  });

  it('#919 — a summary is named and ordered from the committed count', async () => {
    await makeAppMember(`${orgA.urn}:research-app`, adminUser.id);
    const start = await resolvers.Mutation.startChat(
      {}, { agentId: agent.id, scope: 'shared' }, userCtx(adminUser.id),
    );
    await resolvers.Mutation.sendChatMessage(
      {}, { chatId: start.chatId, userMessage: 'hello' }, userCtx(adminUser.id),
    );
    await resolvers.Mutation.saveChatSummary(
      {}, { chatId: start.chatId, summary: 'they said hello' }, userCtx(adminUser.id),
    );

    const { rows, messageCount } = await messagesOf(start.chatId);
    const summary = rows.find((m) => m.tags.includes('summary'));
    expect(summary).toBeDefined();
    expect(summary!.name).toBe('001a-summary');
    // A summary does not consume a message number.
    expect(messageCount).toBe(1);
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
      {}, { agentRef: agent.id }, userCtx(adminUser.id),
    );
    const adminLocs = new Set(adminList.map((c) => c.loc));
    expect(adminLocs.has(adminPriv.chatId)).toBe(true);
    expect(adminLocs.has(adminShared.chatId)).toBe(true);
    expect(adminLocs.has(otherShared.chatId)).toBe(true);
    expect(adminLocs.has(otherPriv.chatId)).toBe(false);

    // otherUser sees: own private + both shared. NOT adminUser's private.
    const otherList = await resolvers.Query.myChats(
      {}, { agentRef: agent.id }, userCtx(otherUser.id),
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

  it("chatHistory: a caller outside the App's audience entirely cannot read a shared chat", async () => {
    await makeAppMember(`${orgA.urn}:research-app`, adminUser.id);
    // #1196 SPLIT this test. It used to assert that `otherUser` — NOT an
    // AppMember — could not read, and that was the member table standing in for
    // the audience. `otherUser` is an org CONTRIBUTOR on orgA, which owns
    // research-app, so `cor:acl:010:01` makes them an App PARTICIPANT and the
    // app-class host's audience is participation: they may read, and the next
    // test asserts that they do.
    //
    // What this test is actually about survives intact, with a caller who is
    // outside the audience by every arm: no org role, no AppMember row, not the
    // author.
    const stranger = await db.user.create({
      data: { id: generateId(), githubId: 880231, githubUsername: `stranger-${Date.now()}` },
    });
    const shared = await resolvers.Mutation.startChat(
      {}, { agentId: agent.id, scope: 'shared' }, userCtx(adminUser.id),
    );
    await resolvers.Mutation.sendChatMessage(
      {}, { chatId: shared.chatId, userMessage: 'secret family chat' }, userCtx(adminUser.id),
    );
    // #829: a caller with NO entitlement to this chat gets not-found rather
    // than Forbidden — the chat-loc lookup filters to the caller's entitled set
    // before selecting, so an unentitled node is invisible, not merely refused.
    // That also removes an existence oracle for chat ids. A caller who IS
    // entitled but not authorized (e.g. a reader without write access) still
    // gets Forbidden — see below.
    await expect(
      resolvers.Query.chatHistory(
        {}, { chatId: shared.chatId }, userCtx(stranger.id),
      ),
    ).rejects.toThrow(/not found/i);
  });

  it("chatHistory: an org CONTRIBUTOR who is not an AppMember CAN read a shared chat (#1196)", async () => {
    // The other half of the split above, asserted rather than left implied.
    // `cor:acl:010:01`: "The audience is PARTICIPATION, not the member table …
    // a gate keyed on the member row alone silently excludes [an org
    // CONTRIBUTOR+], who may already act in the App everywhere else."
    //
    // Both layers had to move for this: the shared memory gate's App fold
    // (which is what admits them) and `chatLocFilter`, whose own contract is to
    // be a SUPERSET of every chat surface's gate — it was still keyed on
    // AppMember rows and filtered them out before the real gate ran.
    await makeAppMember(`${orgA.urn}:research-app`, adminUser.id);
    const shared = await resolvers.Mutation.startChat(
      {}, { agentId: agent.id, scope: 'shared' }, userCtx(adminUser.id),
    );
    await resolvers.Mutation.sendChatMessage(
      {}, { chatId: shared.chatId, userMessage: 'team-visible' }, userCtx(adminUser.id),
    );
    const history = await resolvers.Query.chatHistory(
      {}, { chatId: shared.chatId }, userCtx(otherUser.id),
    );
    expect(history.length).toBeGreaterThan(0);
  });

  it("deleteChat: a non-author App participant can delete a shared chat (#1991)", async () => {
    await makeAppMember(`${orgA.urn}:research-app`, adminUser.id);
    await makeAppMember(`${orgA.urn}:research-app`, otherUser.id);
    const shared = await resolvers.Mutation.startChat(
      {}, { agentId: agent.id, scope: 'shared' }, userCtx(adminUser.id),
    );
    await expect(resolvers.Mutation.deleteChat({}, { chatId: shared.chatId }, userCtx(otherUser.id))).resolves.toBe(true);
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

// ---------------------------------------------------------------------------
// #1717 — the chat-by-loc writes reach only chats, and only for current writers
//
// The six chat-by-loc operations used to select ANY node at the caller's loc,
// and the five writes authorized on identity arms (author, memory creator) that
// survive losing access. A chat has no ACL of its own (cor:acl:030:01): writing
// one is writing its host memory, so a write needs current write access there.
// ---------------------------------------------------------------------------

describe('#1717 — chat-by-loc writes', () => {
  const appUrn = () => `${orgA.urn}:research-app`;
  async function member(userId: string): Promise<void> {
    const app = await db.app.findFirstOrThrow({ where: { urn: appUrn() } });
    await db.appMember.create({ data: { appId: app.id, userId, role: 'member' } });
  }
  /** A shared chat started by `author`, and its app-class host memory. */
  async function sharedChat(authorId: string) {
    const start = await resolvers.Mutation.startChat({}, { agentId: agent.id, scope: 'shared' }, userCtx(authorId));
    const root = await chatNodeByLocOrThrow(db, start.chatId);
    return { chatId: start.chatId, root, memoryId: root.memoryId };
  }
  const snapshot = async (id: string) => {
    const n = await db.node.findUniqueOrThrow({ where: { id } });
    return { data: n.data, deletedAt: n.deletedAt, content: n.content };
  };
  // Every chat-by-loc write, addressed at `chatId` as `userId`.
  const writes = (chatId: string, userId: string) => ({
    sendChatMessage: () => resolvers.Mutation.sendChatMessage({}, { chatId, userMessage: 'x' }, userCtx(userId)),
    processChatResponse: () => resolvers.Mutation.processChatResponse(
      {}, { chatId, toolResponse: { message: 'x', data: null, next_stage: null } }, userCtx(userId)),
    saveChatSummary: () => resolvers.Mutation.saveChatSummary({}, { chatId, summary: 'x' }, userCtx(userId)),
    updateChatTitle: () => resolvers.Mutation.updateChatTitle({}, { chatId, title: 'renamed' }, userCtx(userId)),
    deleteChat: () => resolvers.Mutation.deleteChat({}, { chatId }, userCtx(userId)),
  });

  it.each([
    ['updateChatTitle', false], ['deleteChat', false],
    ['updateChatTitle', true], ['deleteChat', true],
  ] as const)(
    '#1991: %s gives typed FORBIDDEN without write access (legacy creator: %s)',
    async (op, legacy) => {
      await member(adminUser.id);
      const { chatId, root, memoryId } = await sharedChat(adminUser.id);
      // READER retains visibility, but no participation/write grant. The old
      // memory-creator fallback must not confer authority on an unstamped chat.
      await db.orgMember.updateMany({ where: { organizationId: orgA.id, userId: otherUser.id }, data: { role: 'READER' } });
      if (legacy) {
        await db.memory.update({ where: { id: memoryId }, data: { createdBy: otherUser.id } });
        await db.node.update({ where: { id: root.id }, data: { createdBy: null } });
      } else {
        // Historical authorship keeps the root in the candidate set, but
        // must not grant write after participation was lost.
        await db.node.update({ where: { id: root.id }, data: { createdBy: otherUser.id } });
      }
      const before = await snapshot(root.id);
      await expect(writes(chatId, otherUser.id)[op]()).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
      expect(await snapshot(root.id)).toEqual(before);
    },
  );

  it.each(['updateChatTitle', 'deleteChat'] as const)(
    '#1991: %s admits a non-creator with current host-memory write access',
    async (op) => {
      await member(adminUser.id);
      await member(otherUser.id);
      const { chatId, root } = await sharedChat(adminUser.id);
      // The same participant can already post; provenance must not narrow it.
      await resolvers.Mutation.sendChatMessage({}, { chatId, userMessage: 'participant control' }, userCtx(otherUser.id));
      await expect(writes(chatId, otherUser.id)[op]()).resolves.toBe(true);
      const after = await snapshot(root.id);
      if (op === 'updateChatTitle') expect((after.data as Record<string, unknown>).title).toBe('renamed');
      else expect(after.deletedAt).not.toBeNull();
    },
  );

  it.each([
    ['an ordinary node the caller authored', 'notes:plan', {}],
    ['a governed review at a chat-shaped loc', 'chats:202610091200-deadbeef-review', { role: 'review' }],
    ["a chat's own :messages container", null, {}],
  ])('refuses every write against %s, leaving it unchanged', async (_label, loc, extra) => {
    await member(adminUser.id);
    await member(otherUser.id);
    const { chatId, memoryId } = await sharedChat(adminUser.id);
    const target = loc === null
      ? await db.node.findFirstOrThrow({ where: { memoryId, loc: `${chatId}:messages` } })
      : await db.node.create({ data: {
          id: generateId(), memoryId, loc, name: 'target', nodeType: 'record',
          data: { k: 1 }, createdBy: otherUser.id, ...extra,
        } });
    const before = await snapshot(target.id);
    for (const [op, run] of Object.entries(writes(target.loc, otherUser.id))) {
      await expect(run(), op).rejects.toThrow(/not found/i);
    }
    expect(await snapshot(target.id)).toEqual(before);
    // No children planted beneath it (a container's own messages excepted).
    expect(await db.node.count({
      where: { memoryId, loc: { startsWith: `${target.loc}:messages` }, createdBy: otherUser.id },
    })).toBe(0);
  });

  // The platform-admin branch of chatLocFilter builds its own AND list, so it
  // must repeat the plain-node clauses; #1690's merge assigned that list too,
  // and a clean Git merge can keep only one side's (hand-merged on #1690).
  it.each([
    ['a governed review', { role: 'review' }],
    ['a runnable node', { isRunnable: true }],
  ])('a platform admin is refused every write against %s at a chat-shaped loc, leaving it unchanged', async (_label, extra) => {
    await member(adminUser.id);
    const { memoryId } = await sharedChat(adminUser.id);
    const target = await db.node.create({ data: {
      id: generateId(), memoryId, loc: 'chats:202610091300-cafef00d-x', name: 'target', nodeType: 'record',
      data: { k: 1 }, createdBy: adminUser.id, ...extra,
    } });
    const before = await snapshot(target.id);
    const admin = userCtx(adminUser.id, { roles: ['ADMIN'] });
    const ops = {
      sendChatMessage: () => resolvers.Mutation.sendChatMessage({}, { chatId: target.loc, userMessage: 'x' }, admin),
      processChatResponse: () => resolvers.Mutation.processChatResponse(
        {}, { chatId: target.loc, toolResponse: { message: 'x', data: null, next_stage: null } }, admin),
      saveChatSummary: () => resolvers.Mutation.saveChatSummary({}, { chatId: target.loc, summary: 'x' }, admin),
      updateChatTitle: () => resolvers.Mutation.updateChatTitle({}, { chatId: target.loc, title: 'renamed' }, admin),
      deleteChat: () => resolvers.Mutation.deleteChat({}, { chatId: target.loc }, admin),
    };
    for (const [op, run] of Object.entries(ops)) {
      await expect(run(), op).rejects.toThrow(/not found/i);
    }
    expect(await snapshot(target.id)).toEqual(before);
  });

  it("refuses every write against a comment on the chat, leaving it unchanged", async () => {
    await member(adminUser.id);
    await member(otherUser.id);
    const { root } = await sharedChat(adminUser.id);
    const made = await (resolvers.Mutation as any).createComment(null, { targetRef: root.id, body: 'feedback' }, userCtx(otherUser.id));
    const c = await db.node.findUniqueOrThrow({ where: { id: made.id } });
    expect(c.nodeType).toBe('comment');
    const before = await snapshot(c.id);
    for (const [op, run] of Object.entries(writes(c.loc, otherUser.id))) {
      await expect(run(), op).rejects.toThrow(/not found/i);
    }
    expect(await snapshot(c.id)).toEqual(before);
  });

  it('a former member keeps no write power over the chat they authored', async () => {
    await member(adminUser.id);
    await member(otherUser.id);
    const { chatId, root } = await sharedChat(otherUser.id);
    await resolvers.Mutation.sendChatMessage({}, { chatId, userMessage: 'hello' }, userCtx(otherUser.id));
    // Offboarded: out of the App and out of the org.
    const app = await db.app.findFirstOrThrow({ where: { urn: appUrn() } });
    await db.appMember.delete({ where: { appId_userId: { appId: app.id, userId: otherUser.id } } });
    await db.orgMember.updateMany({ where: { organizationId: orgA.id, userId: otherUser.id }, data: { deletedAt: new Date() } });
    const before = await snapshot(root.id);
    for (const [op, run] of Object.entries(writes(chatId, otherUser.id))) {
      await expect(run(), op).rejects.toThrow();
    }
    expect(await snapshot(root.id)).toEqual(before);
    expect(await db.node.count({ where: { memoryId: root.memoryId, loc: { startsWith: `${chatId}:` }, deletedAt: { not: null } } })).toBe(0);
  });

  // Diego on #1725: the gate must hold at the write, not before it. The
  // revoker here does what removeAppMember does — takes the App and the
  // member's authority anchors exclusively, then removes the membership — and
  // the write arrives while it is still open. The write's own pre-check reads
  // the uncommitted state and passes; only a re-check after the anchor wait
  // sees the revocation.
  it.each(['sendChatMessage', 'processChatResponse', 'saveChatSummary', 'updateChatTitle', 'deleteChat'] as const)(
    '%s is refused when the membership is revoked while it waits for its lock',
    async (op) => {
      await member(adminUser.id);
      await member(otherUser.id);
      const { chatId, root } = await sharedChat(otherUser.id);
      await resolvers.Mutation.sendChatMessage({}, { chatId, userMessage: 'hello' }, userCtx(otherUser.id));
      const app = await db.app.findFirstOrThrow({ where: { urn: appUrn() } });
      const before = await snapshot(root.id);
      const messagesBefore = await db.node.count({ where: { memoryId: root.memoryId, loc: { startsWith: `${chatId}:messages:` } } });

      let outcome: unknown;
      await db.$transaction(async (tx) => {
        await lockAuthorityAnchors(tx, [{ kind: 'app', id: app.id }, { kind: 'user', id: otherUser.id }], 'exclusive');
        await tx.appMember.delete({ where: { appId_userId: { appId: app.id, userId: otherUser.id } } });
        await tx.orgMember.updateMany({ where: { organizationId: orgA.id, userId: otherUser.id }, data: { deletedAt: new Date() } });
        outcome = writes(chatId, otherUser.id)[op]().then(() => 'written', (e: unknown) => e);
        await waitForLockWaitersOfType(db, 'advisory', 1, 3_000);
      }, { timeout: 20_000 });

      expect(await outcome).toBeInstanceOf(Error);
      expect(await snapshot(root.id)).toEqual(before);
      expect(await db.node.count({ where: { memoryId: root.memoryId, loc: { startsWith: `${chatId}:messages:` } } }))
        .toBe(messagesBefore);
      expect(await db.node.count({ where: { memoryId: root.memoryId, deletedAt: { not: null } } })).toBe(0);
    },
  );

  // #1991: without any participation grant, the current platform role is
  // the only authority. Revoking it during the wait must still refuse.
  it.each(['updateChatTitle', 'deleteChat'] as const)(
    '%s is refused when the admin role is revoked while it waits for its lock',
    async (op) => {
      await member(adminUser.id);
      await member(otherUser.id);
      const { chatId, root } = await sharedChat(otherUser.id);
      const app = await db.app.findFirstOrThrow({ where: { urn: appUrn() } });
      await db.appMember.delete({ where: { appId_userId: { appId: app.id, userId: adminUser.id } } });
      await db.orgMember.updateMany({ where: { organizationId: orgA.id, userId: adminUser.id }, data: { deletedAt: new Date() } });
      const before = await snapshot(root.id);
      const asAdmin = userCtx(adminUser.id, { roles: ['ADMIN'] });
      const run = op === 'updateChatTitle'
        ? () => resolvers.Mutation.updateChatTitle({}, { chatId, title: 'renamed' }, asAdmin)
        : () => resolvers.Mutation.deleteChat({}, { chatId }, asAdmin);

      let outcome: unknown;
      await db.$transaction(async (tx) => {
        await lockAuthorityAnchors(tx, [{ kind: 'user', id: adminUser.id }], 'exclusive');
        await tx.user.update({ where: { id: adminUser.id }, data: { roles: ['READER'] } });
        outcome = run().then(() => 'written', (e: unknown) => e);
        await waitForLockWaitersOfType(db, 'advisory', 1, 3_000);
      }, { timeout: 20_000 });

      expect(await outcome).toBeInstanceOf(Error);
      expect(await snapshot(root.id)).toEqual(before);
      expect(await db.node.count({ where: { memoryId: root.memoryId, deletedAt: { not: null } } })).toBe(0);
    },
  );

  it('CONTROL: a current platform admin who is not the author still renames and deletes', async () => {
    await member(adminUser.id);
    await member(otherUser.id);
    const { chatId, root } = await sharedChat(otherUser.id);
    const app = await db.app.findFirstOrThrow({ where: { urn: appUrn() } });
    await db.appMember.delete({ where: { appId_userId: { appId: app.id, userId: adminUser.id } } });
    await db.orgMember.updateMany({ where: { organizationId: orgA.id, userId: adminUser.id }, data: { deletedAt: new Date() } });
    const asAdmin = userCtx(adminUser.id, { roles: ['ADMIN'] });
    await resolvers.Mutation.updateChatTitle({}, { chatId, title: 'by admin' }, asAdmin);
    expect(((await db.node.findUniqueOrThrow({ where: { id: root.id } })).data as Record<string, unknown>).title).toBe('by admin');
    await expect(resolvers.Mutation.deleteChat({}, { chatId }, asAdmin)).resolves.toBe(true);
  });

  it('deleteChat removes only the chat and its messages, not other rows under its loc', async () => {
    await member(adminUser.id);
    await member(otherUser.id);
    const { chatId, root, memoryId } = await sharedChat(adminUser.id);
    await resolvers.Mutation.sendChatMessage({}, { chatId, userMessage: 'hello' }, userCtx(adminUser.id));
    const foreign = await db.node.create({ data: {
      id: generateId(), memoryId, loc: `${chatId}:notes`, name: 'notes', nodeType: 'record', createdBy: otherUser.id,
    } });
    await resolvers.Mutation.deleteChat({}, { chatId }, userCtx(adminUser.id));
    expect((await db.node.findUniqueOrThrow({ where: { id: root.id } })).deletedAt).not.toBeNull();
    expect(await db.node.count({ where: { memoryId, loc: { startsWith: `${chatId}:messages` }, deletedAt: null } })).toBe(0);
    expect((await db.node.findUniqueOrThrow({ where: { id: foreign.id } })).deletedAt).toBeNull();
  });

  it('CONTROL: a current member still posts to, and the author still renames and deletes, a shared chat', async () => {
    await member(adminUser.id);
    await member(otherUser.id);
    const { chatId, root } = await sharedChat(otherUser.id);
    await resolvers.Mutation.sendChatMessage({}, { chatId, userMessage: 'from admin' }, userCtx(adminUser.id));
    await resolvers.Mutation.saveChatSummary({}, { chatId, summary: 's' }, userCtx(otherUser.id));
    await resolvers.Mutation.updateChatTitle({}, { chatId, title: 'mine' }, userCtx(otherUser.id));
    expect(((await db.node.findUniqueOrThrow({ where: { id: root.id } })).data as Record<string, unknown>).title).toBe('mine');
    await expect(resolvers.Mutation.deleteChat({}, { chatId }, userCtx(otherUser.id))).resolves.toBe(true);
  });
});
