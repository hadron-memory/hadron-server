/**
 * Tests for conversation transitions: hierarchical extractionSpec,
 * onTrack, goal stack, route history, edge evaluation.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, chatNodeByLoc } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { generateId } from '../../../lib/id.js';
import { serveEveryAgent } from '../../../test/servedBootPrompt.js';
import { deriveEdgeLoc } from '../../../lib/edgeLoc.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

let orgA: { id: string; urn: string };
let adminUser: { id: string };
let agent: { id: string; organizationId: string | null };
let systemMemory: { id: string };

function adminCtx(overrides: Partial<Context> = {}): Context {
  return { db, roles: ['ADMIN'], userId: adminUser.id, ...overrides };
}
function userCtx(userId: string): Context {
  return { db, roles: ['READER'], userId };
}

beforeEach(async () => {
  await cleanDb(db);

  orgA = await db.organization.create({
    data: { id: generateId(), name: 'test-org', urn: 'test-org' },
  });
  adminUser = await db.user.create({
    data: { githubId: 8001, githubUsername: 'transition-tester', roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { organizationId: orgA.id, userId: adminUser.id, role: 'ADMIN' },
  });

  const created = await resolvers.Mutation.createAgent(
    {},
    { orgId: orgA.id, name: 'sage', visibility: 'PERSONAL' },
    adminCtx(),
  );
  agent = created;
  // createAgent now auto-provisions the agent's class='system' memory (#518);
  // read it straight off the returned agent rather than create + attach.
  systemMemory = await db.memory.findUniqueOrThrow({
    where: { id: created.systemMemoryId! },
  });
  // #2712: chats are served the Agent's boot prompt; an Agent without one is refused.
  await serveEveryAgent(db);
});

// ---------------------------------------------------------------------------
// Helper: seed nodes into the system memory
// ---------------------------------------------------------------------------

async function seedNodes(
  nodes: Array<{ loc: string; name: string; nodeType?: string; data?: unknown; content?: string }>,
) {
  const created: Record<string, string> = {};
  for (const n of nodes) {
    const node = await db.node.create({
      data: {
        id: generateId(),
        memoryId: systemMemory.id,
        loc: n.loc,
        name: n.name,
        nodeType: n.nodeType ?? 'system',
        data: (n.data ?? null) as any,
        content: (n.content ?? null) as any,
      },
    });
    created[n.loc] = node.id;
  }
  return created;
}

// ---------------------------------------------------------------------------
// Hierarchical extractionSpec
// ---------------------------------------------------------------------------

describe('Hierarchical extractionSpec', () => {
  it('merges agent + conversation + stage extraction specs in the tool schema', async () => {
    // Seed: config node with agent-level spec, conversation with spec, stage with spec
    await seedNodes([
      {
        loc: 'config',
        name: 'config',
        data: {
          agentExtractionSpec: [
            { field: 'memory.language', description: 'Preferred language', shape: 'string' },
          ],
        },
      },
      { loc: 'conversations', name: 'conversations' },
      {
        loc: 'conversations:onboarding',
        name: 'onboarding',
        data: {
          stageOrder: ['welcome'],
          isSetup: false,
          extractionSpec: [
            { field: 'memory.account_type', description: 'Account type', shape: 'string' },
          ],
        },
      },
      {
        loc: 'conversations:onboarding:welcome',
        name: 'welcome',
        data: {
          promptRef: 'prompts:onboarding:welcome',
          extractionSpec: [
            { field: 'memory.name', description: "User's full name", shape: 'string' },
          ],
        },
      },
      { loc: 'prompts', name: 'prompts' },
      { loc: 'prompts:onboarding', name: 'onboarding' },
      { loc: 'prompts:onboarding:welcome', name: 'welcome', content: 'Hello!' },
    ]);

    const result = await resolvers.Mutation.startChat(
      {},
      { agentId: agent.id },
      userCtx(adminUser.id),
    );

    // The tools should contain all three extraction fields
    expect(result.tools).toBeTruthy();
    expect(result.tools).toHaveLength(1);
    const respondTool = result.tools![0];
    const props = (respondTool.parameters as any).properties;
    const dataProps = props.data.properties;

    // Agent-level
    expect(dataProps.language).toBeDefined();
    expect(dataProps.language.description).toBe('Preferred language');

    // Conversation-level
    expect(dataProps.account_type).toBeDefined();
    expect(dataProps.account_type.description).toBe('Account type');

    // Stage-level
    expect(dataProps.name).toBeDefined();
    expect(dataProps.name.description).toBe("User's full name");

    // onTrack should be in the schema
    expect(props.onTrack).toBeDefined();
    expect(props.onTrack.type).toBe('boolean');
  });

  it('stage-level fields override conversation-level on conflict', async () => {
    await seedNodes([
      { loc: 'conversations', name: 'conversations' },
      {
        loc: 'conversations:test',
        name: 'test',
        data: {
          stageOrder: ['step1'],
          isSetup: false,
          extractionSpec: [
            { field: 'memory.name', description: 'Name (conv level)', shape: 'string' },
          ],
        },
      },
      {
        loc: 'conversations:test:step1',
        name: 'step1',
        data: {
          extractionSpec: [
            { field: 'memory.name', description: 'Name (stage level)', shape: 'string' },
          ],
        },
      },
    ]);

    const result = await resolvers.Mutation.startChat(
      {},
      { agentId: agent.id },
      userCtx(adminUser.id),
    );

    const dataProps = (result.tools![0].parameters as any).properties.data.properties;
    // Stage should win
    expect(dataProps.name.description).toBe('Name (stage level)');
  });
});

// ---------------------------------------------------------------------------
// onTrack in processChatResponse
// ---------------------------------------------------------------------------

describe('onTrack in processChatResponse', () => {
  it('returns onTrack: true by default', async () => {
    await seedNodes([
      { loc: 'conversations', name: 'conversations' },
      {
        loc: 'conversations:basic',
        name: 'basic',
        data: { stageOrder: ['intro'], isSetup: false },
      },
      { loc: 'conversations:basic:intro', name: 'intro', data: {} },
    ]);

    const chat = await resolvers.Mutation.startChat(
      {},
      { agentId: agent.id },
      userCtx(adminUser.id),
    );

    const result = await resolvers.Mutation.processChatResponse(
      {},
      {
        chatId: chat.chatId,
        toolResponse: { message: 'Hello', onTrack: true },
      },
      userCtx(adminUser.id),
    );

    expect(result.onTrack).toBe(true);
    expect(result.offTrackReason).toBeNull();
  });

  it('returns onTrack: false with reason when LLM reports off-track', async () => {
    await seedNodes([
      { loc: 'conversations', name: 'conversations' },
      {
        loc: 'conversations:basic',
        name: 'basic',
        data: { stageOrder: ['intro'], isSetup: false },
      },
      { loc: 'conversations:basic:intro', name: 'intro', data: {} },
    ]);

    const chat = await resolvers.Mutation.startChat(
      {},
      { agentId: agent.id },
      userCtx(adminUser.id),
    );

    const result = await resolvers.Mutation.processChatResponse(
      {},
      {
        chatId: chat.chatId,
        toolResponse: {
          message: 'I see you want something else',
          onTrack: false,
          offTrackReason: 'User asking about billing, not onboarding',
        },
      },
      userCtx(adminUser.id),
    );

    expect(result.onTrack).toBe(false);
    expect(result.offTrackReason).toBe('User asking about billing, not onboarding');

    // Verify it's stored on the chat node
    const chatNode = await chatNodeByLoc(db, chat.chatId, { includeDeleted: true });
    const chatData = chatNode?.data as Record<string, unknown>;
    expect(chatData.lastOffTrackReason).toBe('User asking about billing, not onboarding');
  });
});

// ---------------------------------------------------------------------------
// Goal stack and route history in startChat
// ---------------------------------------------------------------------------

describe('Goal stack and route history', () => {
  it('startChat initializes goal stack and route history', async () => {
    await seedNodes([
      { loc: 'conversations', name: 'conversations' },
      {
        loc: 'conversations:onboarding',
        name: 'onboarding',
        data: {
          stageOrder: ['welcome'],
          isSetup: false,
          goalDescriptions: ['Learn about the user'],
        },
      },
      { loc: 'conversations:onboarding:welcome', name: 'welcome', data: {} },
    ]);

    const chat = await resolvers.Mutation.startChat(
      {},
      { agentId: agent.id },
      userCtx(adminUser.id),
    );

    const chatNode = await chatNodeByLoc(db, chat.chatId, { includeDeleted: true });
    const chatData = chatNode?.data as Record<string, unknown>;

    // Goal stack should have one ACTIVE entry
    const goalStack = chatData.goalStack as Array<Record<string, unknown>>;
    expect(goalStack).toHaveLength(1);
    expect(goalStack[0].description).toBe('Learn about the user');
    expect(goalStack[0].status).toBe('ACTIVE');
    expect(goalStack[0].createdBy).toBe('USER');

    // Route history should have one ENTER entry
    const routeHistory = chatData.routeHistory as Array<Record<string, unknown>>;
    expect(routeHistory).toHaveLength(1);
    expect(routeHistory[0].action).toBe('ENTER');
    expect(routeHistory[0].conversationUrn).toBe('conversations:onboarding');
    expect(routeHistory[0].nodeUrn).toBe('conversations:onboarding:welcome');
  });

  it('processChatResponse appends to route history on stage transition', async () => {
    await seedNodes([
      { loc: 'conversations', name: 'conversations' },
      {
        loc: 'conversations:flow',
        name: 'flow',
        data: { stageOrder: ['step1', 'step2'], isSetup: false },
      },
      { loc: 'conversations:flow:step1', name: 'step1', data: {} },
      { loc: 'conversations:flow:step2', name: 'step2', data: {} },
    ]);

    const chat = await resolvers.Mutation.startChat(
      {},
      { agentId: agent.id },
      userCtx(adminUser.id),
    );

    // Transition from step1 to step2
    await resolvers.Mutation.processChatResponse(
      {},
      {
        chatId: chat.chatId,
        toolResponse: { message: 'Moving on', next_stage: 'step2', onTrack: true },
      },
      userCtx(adminUser.id),
    );

    const chatNode = await chatNodeByLoc(db, chat.chatId, { includeDeleted: true });
    const chatData = chatNode?.data as Record<string, unknown>;
    const history = chatData.routeHistory as Array<Record<string, unknown>>;

    // Should have 2 entries: initial ENTER + step2 ENTER
    expect(history).toHaveLength(2);
    expect(history[1].action).toBe('ENTER');
    expect(history[1].nodeUrn).toBe('conversations:flow:step2');
    expect((history[1].trigger as any).type).toBe('STAGE_TRANSITION');
  });
});

// ---------------------------------------------------------------------------
// Edge evaluation
// ---------------------------------------------------------------------------

describe('Edge evaluation in processChatResponse', () => {
  it('follows an on_complete edge to another conversation', async () => {
    const nodeIds = await seedNodes([
      { loc: 'conversations', name: 'conversations' },
      {
        loc: 'conversations:onboarding',
        name: 'onboarding',
        data: { stageOrder: ['welcome'], isSetup: false },
      },
      { loc: 'conversations:onboarding:welcome', name: 'welcome', data: {} },
      {
        loc: 'conversations:strategy',
        name: 'strategy',
        data: { stageOrder: ['diagnose'], isSetup: false },
      },
      { loc: 'conversations:strategy:diagnose', name: 'diagnose', data: {} },
    ]);

    // Create an edge from the welcome stage to the strategy conversation
    await db.edge.create({
      data: {
        id: generateId(),
        memoryId: systemMemory.id,
        loc: deriveEdgeLoc(
          'conversations:onboarding:welcome',
          'After onboarding, move to strategy',
          'conversations:strategy',
        ),
        sourceId: nodeIds['conversations:onboarding:welcome'],
        targetId: nodeIds['conversations:strategy'],
        name: 'After onboarding, move to strategy',
        data: { timing: 'on_complete', behavior: 'transition' },
      },
    });

    const chat = await resolvers.Mutation.startChat(
      {},
      { agentId: agent.id, conversationName: 'onboarding' },
      userCtx(adminUser.id),
    );

    // Complete the welcome stage with next_stage: null (triggers edge evaluation)
    const result = await resolvers.Mutation.processChatResponse(
      {},
      {
        chatId: chat.chatId,
        toolResponse: { message: 'Welcome done', next_stage: null, onTrack: true },
      },
      userCtx(adminUser.id),
    );

    expect(result.conversationHandoff).toBe('strategy');
    expect(result.stageTransitioned).toBe(true);
    expect(result.newStageName).toBe('diagnose');

    // Verify the chat node was updated
    const chatNode = await chatNodeByLoc(db, chat.chatId, { includeDeleted: true });
    const chatData = chatNode?.data as Record<string, unknown>;
    expect(chatData.conversationName).toBe('strategy');
    expect(chatData.stageName).toBe('diagnose');
  });

  it('follows a conditional edge only when condition is met', async () => {
    const nodeIds = await seedNodes([
      { loc: 'conversations', name: 'conversations' },
      {
        loc: 'conversations:main',
        name: 'main',
        data: { stageOrder: ['check'], isSetup: false },
      },
      { loc: 'conversations:main:check', name: 'check', data: {} },
      {
        loc: 'conversations:profile',
        name: 'profile',
        data: { stageOrder: ['fill'], isSetup: false },
      },
      { loc: 'conversations:profile:fill', name: 'fill', data: {} },
    ]);

    // Conditional edge: if business_type is missing, detour to profile.
    // Uses the JSONLogic shape on Edge.condition (the column), not the
    // legacy {field, operator, value} stored in edge.data.condition.
    await db.edge.create({
      data: {
        id: generateId(),
        memoryId: systemMemory.id,
        loc: deriveEdgeLoc(
          'conversations:main:check',
          'Fill profile if missing',
          'conversations:profile',
        ),
        sourceId: nodeIds['conversations:main:check'],
        targetId: nodeIds['conversations:profile'],
        name: 'Fill profile if missing',
        condition: { missing: ['memory.business_type'] },
        data: {
          timing: 'on_complete',
          behavior: 'detour',
        },
      },
    });

    const chat = await resolvers.Mutation.startChat(
      {},
      { agentId: agent.id, conversationName: 'main' },
      userCtx(adminUser.id),
    );

    // No business_type data exists → condition should be met → edge fires
    const result = await resolvers.Mutation.processChatResponse(
      {},
      {
        chatId: chat.chatId,
        toolResponse: { message: 'Checking', next_stage: null, onTrack: true },
      },
      userCtx(adminUser.id),
    );

    expect(result.conversationHandoff).toBe('profile');
    expect(result.newStageName).toBe('fill');

    // Should have pushed a goal (detour behavior)
    const chatNode = await chatNodeByLoc(db, chat.chatId, { includeDeleted: true });
    const chatData = chatNode?.data as Record<string, unknown>;
    const goalStack = chatData.goalStack as Array<Record<string, unknown>>;
    // Original goal + detour goal
    expect(goalStack.filter((g) => g.status === 'ACTIVE')).toHaveLength(2);
  });

  it('does NOT follow a conditional edge when condition is NOT met', async () => {
    const nodeIds = await seedNodes([
      { loc: 'conversations', name: 'conversations' },
      {
        loc: 'conversations:main',
        name: 'main',
        data: { stageOrder: ['check'], isSetup: false },
      },
      { loc: 'conversations:main:check', name: 'check', data: {} },
      {
        loc: 'conversations:profile',
        name: 'profile',
        data: { stageOrder: ['fill'], isSetup: false },
      },
      { loc: 'conversations:profile:fill', name: 'fill', data: {} },
    ]);

    await db.edge.create({
      data: {
        id: generateId(),
        memoryId: systemMemory.id,
        loc: deriveEdgeLoc(
          'conversations:main:check',
          'Fill profile if missing',
          'conversations:profile',
        ),
        sourceId: nodeIds['conversations:main:check'],
        targetId: nodeIds['conversations:profile'],
        name: 'Fill profile if missing',
        condition: { missing: ['memory.business_type'] },
        data: {
          timing: 'on_complete',
          behavior: 'detour',
        },
      },
    });

    const chat = await resolvers.Mutation.startChat(
      {},
      { agentId: agent.id, conversationName: 'main' },
      userCtx(adminUser.id),
    );

    // First, populate business_type via processChatResponse data extraction
    await resolvers.Mutation.processChatResponse(
      {},
      {
        chatId: chat.chatId,
        toolResponse: {
          message: 'Got it',
          data: { business_type: 'coffee shop' },
          onTrack: true,
        },
      },
      userCtx(adminUser.id),
    );

    // Now complete the stage — business_type exists, so the condition is NOT met
    const result = await resolvers.Mutation.processChatResponse(
      {},
      {
        chatId: chat.chatId,
        toolResponse: { message: 'Done', next_stage: null, onTrack: true },
      },
      userCtx(adminUser.id),
    );

    // Edge should NOT have fired
    expect(result.conversationHandoff).toBeNull();
  });

  it('JSONLogic condition mixing message.data and chat scopes (Pong-shaped)', async () => {
    // Models the spec User Story 2 acceptance scenario: an automation
    // gates an "escalate" edge on a per-message field plus chat state.
    // Even though the resolver path is chatbot-shaped, this exercises
    // the same scopes Pong uses on email events: message.data (the
    // extracted payload) + chat (the running thread).
    const nodeIds = await seedNodes([
      { loc: 'conversations', name: 'conversations' },
      {
        loc: 'conversations:thread',
        name: 'thread',
        data: { stageOrder: ['triage'], isSetup: false },
      },
      { loc: 'conversations:thread:triage', name: 'triage', data: {} },
      {
        loc: 'conversations:escalate',
        name: 'escalate',
        data: { stageOrder: ['handoff'], isSetup: false },
      },
      { loc: 'conversations:escalate:handoff', name: 'handoff', data: {} },
    ]);

    // Edge fires when the LLM extracts urgency=high AND the chat has
    // had at least one prior message (proxy for the thread.auto_reply_count
    // semantics in Pong's actual condition).
    await db.edge.create({
      data: {
        id: generateId(),
        memoryId: systemMemory.id,
        loc: deriveEdgeLoc(
          'conversations:thread:triage',
          'Escalate to handoff',
          'conversations:escalate',
        ),
        sourceId: nodeIds['conversations:thread:triage'],
        targetId: nodeIds['conversations:escalate'],
        name: 'Escalate to handoff',
        condition: {
          and: [
            { '==': [{ var: 'message.data.urgency' }, 'high'] },
            { '>=': [{ var: 'chat.message_count' }, 1] },
          ],
        },
        data: { timing: 'on_complete', behavior: 'transition' },
      },
    });

    const chat = await resolvers.Mutation.startChat(
      {},
      { agentId: agent.id, conversationName: 'thread' },
      userCtx(adminUser.id),
    );

    // First turn: message.data.urgency = 'high', should fire the edge.
    const fired = await resolvers.Mutation.processChatResponse(
      {},
      {
        chatId: chat.chatId,
        toolResponse: {
          message: 'Caller flagged this as urgent',
          next_stage: null,
          data: { urgency: 'high' },
          onTrack: true,
        },
      },
      userCtx(adminUser.id),
    );
    expect(fired.conversationHandoff).toBe('escalate');
    expect(fired.newStageName).toBe('handoff');
  });

  it('JSONLogic condition does NOT fire when message.data is unset', async () => {
    const nodeIds = await seedNodes([
      { loc: 'conversations', name: 'conversations' },
      {
        loc: 'conversations:thread',
        name: 'thread',
        data: { stageOrder: ['triage'], isSetup: false },
      },
      { loc: 'conversations:thread:triage', name: 'triage', data: {} },
      {
        loc: 'conversations:escalate',
        name: 'escalate',
        data: { stageOrder: ['handoff'], isSetup: false },
      },
      { loc: 'conversations:escalate:handoff', name: 'handoff', data: {} },
    ]);

    await db.edge.create({
      data: {
        id: generateId(),
        memoryId: systemMemory.id,
        loc: deriveEdgeLoc(
          'conversations:thread:triage',
          'Escalate to handoff',
          'conversations:escalate',
        ),
        sourceId: nodeIds['conversations:thread:triage'],
        targetId: nodeIds['conversations:escalate'],
        name: 'Escalate to handoff',
        condition: { '==': [{ var: 'message.data.urgency' }, 'high'] },
        data: { timing: 'on_complete', behavior: 'transition' },
      },
    });

    const chat = await resolvers.Mutation.startChat(
      {},
      { agentId: agent.id, conversationName: 'thread' },
      userCtx(adminUser.id),
    );

    // No urgency in the extracted data → condition fails → no handoff.
    const result = await resolvers.Mutation.processChatResponse(
      {},
      {
        chatId: chat.chatId,
        toolResponse: { message: 'Routine check-in', next_stage: null, onTrack: true },
      },
      userCtx(adminUser.id),
    );
    expect(result.conversationHandoff).toBeNull();
  });

  it('multi-layer cascade: user-memory override wins over agent-memory default (US3)', async () => {
    // System memory carries an agent-wide default at `loc: 'data'`. The
    // per-user memory carries an override at `loc: 'data'`. The condition
    // should resolve against the user override (later layer wins).
    const nodeIds = await seedNodes([
      { loc: 'data', name: 'agent-defaults', data: { threshold: 6 } },
      { loc: 'conversations', name: 'conversations' },
      {
        loc: 'conversations:gate',
        name: 'gate',
        data: { stageOrder: ['check'], isSetup: false },
      },
      { loc: 'conversations:gate:check', name: 'check', data: {} },
      {
        loc: 'conversations:urgent',
        name: 'urgent',
        data: { stageOrder: ['handle'], isSetup: false },
      },
      { loc: 'conversations:urgent:handle', name: 'handle', data: {} },
    ]);

    // Edge: fires if memory.threshold is below 5. With agent default 6,
    // the edge should NOT fire — UNLESS the user's memory overrides
    // threshold to a value <5.
    await db.edge.create({
      data: {
        id: generateId(),
        memoryId: systemMemory.id,
        loc: deriveEdgeLoc(
          'conversations:gate:check',
          'Urgent path',
          'conversations:urgent',
        ),
        sourceId: nodeIds['conversations:gate:check'],
        targetId: nodeIds['conversations:urgent'],
        name: 'Urgent path',
        condition: { '<': [{ var: 'memory.threshold' }, 5] },
        data: { timing: 'on_complete', behavior: 'transition' },
      },
    });

    const chat = await resolvers.Mutation.startChat(
      {},
      { agentId: agent.id, conversationName: 'gate' },
      userCtx(adminUser.id),
    );

    // Locate the per-user memory startChat just provisioned and write an
    // override into its `data` node.
    const userMem = await db.memory.findFirst({
      where: { userMemoryOfAgentId: agent.id, createdBy: adminUser.id },
    });
    expect(userMem).not.toBeNull();
    expect(userMem!.id).not.toBe(systemMemory.id);

    await db.node.create({
      data: {
        id: generateId(),
        memoryId: userMem!.id,
        loc: 'data',
        name: 'user-overrides',
        nodeType: 'info',
        data: { threshold: 3 },
      },
    });

    // With override threshold=3 (3 < 5), edge fires.
    const result = await resolvers.Mutation.processChatResponse(
      {},
      {
        chatId: chat.chatId,
        toolResponse: { message: 'Routing', next_stage: null, onTrack: true },
      },
      userCtx(adminUser.id),
    );

    expect(result.conversationHandoff).toBe('urgent');
    expect(result.newStageName).toBe('handle');
  });

  it('multi-layer cascade: agent-memory default applies when user-memory has no override (US3)', async () => {
    // Same setup as above, but the user memory has no `threshold` field.
    // The cascade should resolve to the agent's default (6), and the
    // condition (<5) should fail → edge does NOT fire.
    const nodeIds = await seedNodes([
      { loc: 'data', name: 'agent-defaults', data: { threshold: 6 } },
      { loc: 'conversations', name: 'conversations' },
      {
        loc: 'conversations:gate',
        name: 'gate',
        data: { stageOrder: ['check'], isSetup: false },
      },
      { loc: 'conversations:gate:check', name: 'check', data: {} },
      {
        loc: 'conversations:urgent',
        name: 'urgent',
        data: { stageOrder: ['handle'], isSetup: false },
      },
      { loc: 'conversations:urgent:handle', name: 'handle', data: {} },
    ]);

    await db.edge.create({
      data: {
        id: generateId(),
        memoryId: systemMemory.id,
        loc: deriveEdgeLoc(
          'conversations:gate:check',
          'Urgent path',
          'conversations:urgent',
        ),
        sourceId: nodeIds['conversations:gate:check'],
        targetId: nodeIds['conversations:urgent'],
        name: 'Urgent path',
        condition: { '<': [{ var: 'memory.threshold' }, 5] },
        data: { timing: 'on_complete', behavior: 'transition' },
      },
    });

    const chat = await resolvers.Mutation.startChat(
      {},
      { agentId: agent.id, conversationName: 'gate' },
      userCtx(adminUser.id),
    );

    // Don't write any user override.
    const result = await resolvers.Mutation.processChatResponse(
      {},
      {
        chatId: chat.chatId,
        toolResponse: { message: 'Routing', next_stage: null, onTrack: true },
      },
      userCtx(adminUser.id),
    );

    expect(result.conversationHandoff).toBeNull();
  });

  it('does not evaluate edges when next_stage is set (normal transition)', async () => {
    const nodeIds = await seedNodes([
      { loc: 'conversations', name: 'conversations' },
      {
        loc: 'conversations:flow',
        name: 'flow',
        data: { stageOrder: ['a', 'b'], isSetup: false },
      },
      { loc: 'conversations:flow:a', name: 'a', data: {} },
      { loc: 'conversations:flow:b', name: 'b', data: {} },
      {
        loc: 'conversations:other',
        name: 'other',
        data: { stageOrder: ['x'], isSetup: false },
      },
      { loc: 'conversations:other:x', name: 'x', data: {} },
    ]);

    await db.edge.create({
      data: {
        id: generateId(),
        memoryId: systemMemory.id,
        loc: deriveEdgeLoc(
          'conversations:flow:a',
          'On complete, go to other',
          'conversations:other',
        ),
        sourceId: nodeIds['conversations:flow:a'],
        targetId: nodeIds['conversations:other'],
        name: 'On complete, go to other',
        data: { timing: 'on_complete', behavior: 'transition' },
      },
    });

    const chat = await resolvers.Mutation.startChat(
      {},
      { agentId: agent.id, conversationName: 'flow' },
      userCtx(adminUser.id),
    );

    // Transition within the same conversation (next_stage set → edges not evaluated)
    const result = await resolvers.Mutation.processChatResponse(
      {},
      {
        chatId: chat.chatId,
        toolResponse: { message: 'Moving', next_stage: 'b', onTrack: true },
      },
      userCtx(adminUser.id),
    );

    expect(result.conversationHandoff).toBeNull();
    expect(result.newStageName).toBe('b');
  });
});

// ---------------------------------------------------------------------------
// Fallback conversation in the goal descriptions
// ---------------------------------------------------------------------------

describe('Goal descriptions on conversations', () => {
  it('startChat uses goalDescriptions for the initial goal stack entry', async () => {
    await seedNodes([
      { loc: 'conversations', name: 'conversations' },
      {
        loc: 'conversations:mentoring',
        name: 'mentoring',
        data: {
          stageOrder: ['start'],
          isSetup: false,
          goalDescriptions: ['Help the user find a mentor'],
          goalSignals: ['I need a mentor', 'find someone to help me'],
        },
      },
      { loc: 'conversations:mentoring:start', name: 'start', data: {} },
    ]);

    const chat = await resolvers.Mutation.startChat(
      {},
      { agentId: agent.id },
      userCtx(adminUser.id),
    );

    const chatNode = await chatNodeByLoc(db, chat.chatId, { includeDeleted: true });
    const chatData = chatNode?.data as Record<string, unknown>;
    const goalStack = chatData.goalStack as Array<Record<string, unknown>>;

    expect(goalStack[0].description).toBe('Help the user find a mentor');
  });

  it('falls back to conversation name when no goalDescriptions', async () => {
    await seedNodes([
      { loc: 'conversations', name: 'conversations' },
      {
        loc: 'conversations:simple',
        name: 'simple',
        data: { stageOrder: ['only'], isSetup: false },
      },
      { loc: 'conversations:simple:only', name: 'only', data: {} },
    ]);

    const chat = await resolvers.Mutation.startChat(
      {},
      { agentId: agent.id },
      userCtx(adminUser.id),
    );

    const chatNode = await chatNodeByLoc(db, chat.chatId, { includeDeleted: true });
    const chatData = chatNode?.data as Record<string, unknown>;
    const goalStack = chatData.goalStack as Array<Record<string, unknown>>;

    expect(goalStack[0].description).toBe('simple conversation');
  });
});

// ---------------------------------------------------------------------------
// Fallback re-routing
// ---------------------------------------------------------------------------

describe('Fallback re-routing', () => {
  it('re-routes from fallback to a matching conversation on sendChatMessage', async () => {
    await seedNodes([
      { loc: 'conversations', name: 'conversations' },
      {
        loc: 'conversations:fallback',
        name: 'fallback',
        data: { stageOrder: ['no-match'], isFallback: true, isSetup: false },
      },
      { loc: 'conversations:fallback:no-match', name: 'no-match', data: {} },
      {
        loc: 'conversations:mentoring',
        name: 'mentoring',
        data: {
          stageOrder: ['start'],
          isSetup: false,
          goalDescriptions: ['Help the user find a mentor'],
          goalSignals: ['I need a mentor', 'find someone to help me'],
        },
      },
      { loc: 'conversations:mentoring:start', name: 'start', data: { promptRef: 'prompts:mentoring:start' } },
      { loc: 'prompts', name: 'prompts' },
      { loc: 'prompts:mentoring', name: 'mentoring' },
      { loc: 'prompts:mentoring:start', name: 'start', content: 'Help the user find a mentor.' },
    ]);

    // Start a chat — should land in fallback (no conversationName specified,
    // but fallback is skipped so it should find mentoring... unless mentoring
    // is the only non-setup conversation. Let's force fallback by specifying it.)
    const chat = await resolvers.Mutation.startChat(
      {},
      { agentId: agent.id, conversationName: 'fallback' },
      userCtx(adminUser.id),
    );
    expect(chat.conversationName).toBe('fallback');

    // Send a message that matches mentoring's goalSignals
    const sendResult = await resolvers.Mutation.sendChatMessage(
      {},
      { chatId: chat.chatId, userMessage: 'I need a mentor to help me grow' },
      userCtx(adminUser.id),
    );

    // The system prompt should now be from the mentoring conversation,
    // not the fallback
    expect(sendResult.systemMessage).toContain('mentor');

    // The chat node should have been updated to mentoring
    const chatNode = await chatNodeByLoc(db, chat.chatId, { includeDeleted: true });
    const chatData = chatNode?.data as Record<string, unknown>;
    expect(chatData.conversationName).toBe('mentoring');
    expect(chatData.stageName).toBe('start');

    // Route history should show the re-route
    const history = chatData.routeHistory as Array<Record<string, unknown>>;
    const reroute = history.find((h) => (h.trigger as any)?.type === 'FALLBACK_REROUTE');
    expect(reroute).toBeTruthy();
  });

  it('stays in fallback when no conversation matches', async () => {
    await seedNodes([
      { loc: 'conversations', name: 'conversations' },
      {
        loc: 'conversations:fallback',
        name: 'fallback',
        data: { stageOrder: ['no-match'], isFallback: true, isSetup: false },
      },
      { loc: 'conversations:fallback:no-match', name: 'no-match', data: {} },
    ]);

    const chat = await resolvers.Mutation.startChat(
      {},
      { agentId: agent.id, conversationName: 'fallback' },
      userCtx(adminUser.id),
    );

    // Send a short message — too short to trigger the "substantive" fallback
    const sendResult = await resolvers.Mutation.sendChatMessage(
      {},
      { chatId: chat.chatId, userMessage: 'hi' },
      userCtx(adminUser.id),
    );

    // Should still be in fallback
    const chatNode = await chatNodeByLoc(db, chat.chatId, { includeDeleted: true });
    const chatData = chatNode?.data as Record<string, unknown>;
    expect(chatData.conversationName).toBe('fallback');
  });
});
