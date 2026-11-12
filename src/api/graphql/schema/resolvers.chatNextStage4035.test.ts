/**
 * #4035 (Know Yourself engine S2; cor:cht:030:02 mechanism 1, ruling Q4): `next_stage` is checked against the
 * conversation's stages. The respond tool lists them; an unknown name moves nothing and comes back as
 * `rejectedNextStage`; the turn is recorded.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, chatNodeByLoc, createDbAgentOrgGrant } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { generateId } from '../../../lib/id.js';
import { serveEveryAgent } from '../../../test/servedBootPrompt.js';

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
    data: { githubId: 8035, githubUsername: 'next-stage-tester', roles: ['ADMIN'] },
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


async function engineState(chatId: string) {
  const chatNode = await chatNodeByLoc(db, chatId, { includeDeleted: true });
  return { ...(chatNode?.data as Record<string, unknown>), ...((await db.chatRootEngineState.findUnique({ where: { chatRootNodeId: chatNode!.id } }))?.state as Record<string, unknown>) };
}

const flow = (stages: string[]) => [
  { loc: 'conversations', name: 'conversations' },
  { loc: 'conversations:flow', name: 'flow', data: { stageOrder: stages, isSetup: false } },
  ...stages.map((s) => ({ loc: `conversations:flow:${s}`, name: s, data: {} })),
];
const nextStageProp = (tools: any) => tools![0].parameters.properties.next_stage;

describe('next_stage check (#4035)', () => {
  it('pin 1: an unknown next_stage leaves the stage, adds no route entry, records the turn and reports the name', async () => {
    await seedNodes(flow(['step1', 'step2']));
    const chat = await resolvers.Mutation.startChat({}, { agentId: agent.id }, userCtx(adminUser.id));
    const before = await engineState(chat.chatId);
    // loc-scope-ok: the chat id is unique to this test's one chat
    const assistantTurns = () => db.node.count({ where: { loc: { startsWith: `${chat.chatId}:messages:` }, name: { endsWith: '-assistant' } } });
    const turnsBefore = await assistantTurns();

    const result = await resolvers.Mutation.processChatResponse(
      {},
      { chatId: chat.chatId, toolResponse: { message: 'Hm', next_stage: 'nope', onTrack: true } },
      userCtx(adminUser.id),
    );

    expect(result.stageTransitioned).toBe(false);
    expect(result.newStageName).toBeNull();
    expect(result.rejectedNextStage).toBe('nope');
    const after = await engineState(chat.chatId);
    expect(after.stageName).toBe('step1');
    expect((after.routeHistory as unknown[]).length).toBe((before.routeHistory as unknown[]).length);
    expect(await assistantTurns()).toBe(turnsBefore + 1);
  });

  it('pin 2: startChat and sendChatMessage tools list exactly the conversation stages, null included', async () => {
    await seedNodes(flow(['step1', 'step2', 'step3']));
    const chat = await resolvers.Mutation.startChat({}, { agentId: agent.id }, userCtx(adminUser.id));
    const prop = nextStageProp(chat.tools);
    expect(prop.enum).toEqual(['step1', 'step2', 'step3', null]);
    for (const n of ['step1', 'step2', 'step3']) expect(prop.description).toContain(n);

    const sent = await resolvers.Mutation.sendChatMessage({}, { chatId: chat.chatId, content: 'hi' }, userCtx(adminUser.id));
    expect(nextStageProp((sent as any).tools).enum).toEqual(['step1', 'step2', 'step3', null]);
  });

  it('pin 3: the list is the pinned revision; a stage added to the draft afterwards is neither listed nor accepted', async () => {
    await seedNodes(flow(['step1', 'step2']));
    await resolvers.Mutation.createRevision({}, { agentId: agent.id }, adminCtx());
    await resolvers.Mutation.publishRevision({}, { agentId: agent.id, revisionLoc: 'revisions:rev-1', versionLabel: 'v1' }, adminCtx());
    const chat = await resolvers.Mutation.startChat({}, { agentId: agent.id }, userCtx(adminUser.id));
    await db.node.updateMany({
      where: { memoryId: systemMemory.id, loc: 'conversations:flow' },
      data: { data: { stageOrder: ['step1', 'step2', 'step3'], isSetup: false } as any },
    });
    await db.node.create({ data: { id: generateId(), memoryId: systemMemory.id, loc: 'conversations:flow:step3', name: 'step3', nodeType: 'system', data: {} as any } });

    const sent = await resolvers.Mutation.sendChatMessage({}, { chatId: chat.chatId, content: 'hi' }, userCtx(adminUser.id));
    expect(nextStageProp((sent as any).tools).enum).toEqual(['step1', 'step2', null]);
    const result = await resolvers.Mutation.processChatResponse(
      {},
      { chatId: chat.chatId, toolResponse: { message: 'x', next_stage: 'step3', onTrack: true } },
      userCtx(adminUser.id),
    );
    expect(result.rejectedNextStage).toBe('step3');
    expect(result.stageTransitioned).toBe(false);
  });

  it('pin 4 (green on main, regression): a known next_stage still moves; naming the current stage is a quiet no-op', async () => {
    await seedNodes(flow(['step1', 'step2']));
    const chat = await resolvers.Mutation.startChat({}, { agentId: agent.id }, userCtx(adminUser.id));
    const same = await resolvers.Mutation.processChatResponse(
      {}, { chatId: chat.chatId, toolResponse: { message: 'a', next_stage: 'step1', onTrack: true } }, userCtx(adminUser.id),
    );
    expect(same.stageTransitioned).toBe(false);
    expect(same.rejectedNextStage ?? null).toBeNull();
    const moved = await resolvers.Mutation.processChatResponse(
      {}, { chatId: chat.chatId, toolResponse: { message: 'b', next_stage: 'step2', onTrack: true } }, userCtx(adminUser.id),
    );
    expect(moved.stageTransitioned).toBe(true);
    expect(moved.newStageName).toBe('step2');
    expect(moved.rejectedNextStage ?? null).toBeNull();
    expect((await engineState(chat.chatId)).stageName).toBe('step2');
  });

  it('pin 6 (Baloo P2 on #4052): a shared App chat checks next_stage too; a known stage still moves', async () => {
    await seedNodes(flow(['step1', 'step2']));
    const app = await db.app.create({ data: { organizationId: orgA.id, name: 'Workspace', urn: 'test-org:workspace' } });
    await db.appMember.create({ data: { appId: app.id, userId: adminUser.id, role: 'admin' } });
    await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
    await createDbAgentOrgGrant(db, orgA.id, agent.id);
    const chat = await resolvers.Mutation.startChat({}, { agentId: agent.id, scope: 'shared' }, userCtx(adminUser.id));
    const home = await db.memory.findUniqueOrThrow({ where: { id: (await chatNodeByLoc(db, chat.chatId, { includeDeleted: true }))!.memoryId } });
    expect(home.sharedMemoryOfAgentId).toBe(agent.id);
    expect(home.userMemoryOfAgentId).toBeNull();
    expect(nextStageProp(chat.tools).enum).toEqual(['step1', 'step2', null]);

    const bad = await resolvers.Mutation.processChatResponse(
      {}, { chatId: chat.chatId, toolResponse: { message: 'x', next_stage: 'nope', onTrack: true } }, userCtx(adminUser.id),
    );
    expect(bad.stageTransitioned).toBe(false);
    expect(bad.rejectedNextStage).toBe('nope');
    const after = await engineState(chat.chatId);
    expect(after.stageName).toBe('step1');
    expect((after.routeHistory as unknown[]).length).toBe(1);

    const ok = await resolvers.Mutation.processChatResponse(
      {}, { chatId: chat.chatId, toolResponse: { message: 'y', next_stage: 'step2', onTrack: true } }, userCtx(adminUser.id),
    );
    expect(ok.stageTransitioned).toBe(true);
    expect((await engineState(chat.chatId)).stageName).toBe('step2');
  });

  it('pin 7 (#4077): a stage list that cannot be read mid-chat moves nothing, records the turn and reports the name', async () => {
    await seedNodes(flow(['step1', 'step2']));
    const chat = await resolvers.Mutation.startChat({}, { agentId: agent.id }, userCtx(adminUser.id));
    // The conversation node disappears from the script the chat reads (no published revision pins it).
    await db.node.deleteMany({ where: { memoryId: systemMemory.id, loc: 'conversations:flow' } });
    const before = await engineState(chat.chatId);
    // loc-scope-ok: the chat id is unique to this test's one chat
    const assistantTurns = () => db.node.count({ where: { loc: { startsWith: `${chat.chatId}:messages:` }, name: { endsWith: '-assistant' } } });
    const turnsBefore = await assistantTurns();

    const result = await resolvers.Mutation.processChatResponse(
      {}, { chatId: chat.chatId, toolResponse: { message: 'Hm', next_stage: 'nope', onTrack: true } }, userCtx(adminUser.id),
    );
    expect(result.stageTransitioned).toBe(false);
    expect(result.rejectedNextStage).toBe('nope');
    const after = await engineState(chat.chatId);
    expect(after.stageName).toBe(before.stageName);
    expect((after.routeHistory as unknown[]).length).toBe((before.routeHistory as unknown[]).length);
    expect(await assistantTurns()).toBe(turnsBefore + 1);
  });

  it('pin 8 (#4077): an empty stage list leaves next_stage unconstrained instead of offering an empty enum', async () => {
    const { respondToolDefinition } = await import('./resolvers.helpers.js');
    for (const names of [[], null, undefined]) {
      const prop = (respondToolDefinition({}, names as any) as any)[0].parameters.properties.next_stage;
      expect(prop.enum).toBeUndefined();
      expect(prop.description).not.toMatch(/one of:\s*\(/);
    }
    const listed = (respondToolDefinition({}, ['a']) as any)[0].parameters.properties.next_stage;
    expect(listed.enum).toEqual(['a', null]);
  });

  it('pin 5 (green on main): the probe tool carries no enum', async () => {
    const { respondToolDefinition } = await import('./resolvers.helpers.js');
    expect((respondToolDefinition({}) as any)[0].parameters.properties.next_stage.enum).toBeUndefined();
  });
});
