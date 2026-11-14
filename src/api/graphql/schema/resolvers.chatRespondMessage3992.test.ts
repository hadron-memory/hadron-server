/**
 * #3992 — processChatResponse refuses a missing / null / non-string `message` (cor:cht:020:01 step 2, rev 34) with
 * BAD_USER_INPUT BEFORE any write; an empty or whitespace-only string is accepted and recorded as sent.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, chatNodeByLocOrThrow } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { generateId } from '../../../lib/id.js';
import { serveEveryAgent } from '../../../test/servedBootPrompt.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

let alice: { id: string };
let agent: { id: string };
const ctxFor = (userId: string): Context => ({ db, roles: ['READER'], userId });

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'org-3992', urn: 'org-3992' } });
  alice = await db.user.create({ data: { githubId: 39921, githubUsername: 'alice-3992', roles: ['READER'] } });
  const admin = await db.user.create({ data: { githubId: 39920, githubUsername: 'admin-3992', roles: ['ADMIN'] } });
  for (const u of [admin, alice]) {
    await db.orgMember.create({ data: { organizationId: org.id, userId: u.id, role: u === admin ? 'ADMIN' : 'CONTRIBUTOR' } });
  }
  agent = await resolvers.Mutation.createAgent({}, { orgId: org.id, name: 'intake-agent', visibility: 'ORGANIZATION' }, { db, roles: ['ADMIN'], userId: admin.id });
  const systemMemoryId = (agent as unknown as { systemMemoryId: string }).systemMemoryId;
  const nodes: Array<{ loc: string; data?: unknown; content?: string }> = [
    { loc: 'config', data: { agentExtractionSpec: [{ field: 'memory.region' }] } },
    { loc: 'conversations' },
    { loc: 'conversations:intake', data: { stageOrder: ['scope', 'wrap'], isSetup: false } },
    { loc: 'conversations:intake:scope', data: { promptRef: 'prompts:intake:scope' } },
    { loc: 'conversations:intake:wrap', data: { promptRef: 'prompts:intake:scope' } },
    { loc: 'prompts' },
    { loc: 'prompts:intake' },
    { loc: 'prompts:intake:scope', content: 'region={{region}}' },
  ];
  for (const n of nodes) {
    await db.node.upsert({
      where: { loc_memoryId: { loc: n.loc, memoryId: systemMemoryId } },
      update: { data: (n.data ?? undefined) as never, content: n.content ?? undefined },
      create: { id: generateId(), memoryId: systemMemoryId, loc: n.loc, name: n.loc.split(':').pop()!, nodeType: 'system', data: (n.data ?? null) as never, content: n.content ?? null },
    });
  }
  // #4046: these turn tests start through a licensed App, never an App-less non-manager read.
  await db.app.create({ data: { name: 'Turn fixture', urn: 'org-3992:chat-app', organizationId: org.id,
    appAgents: { create: { agentId: agent.id } } } });
  await serveEveryAgent(db);
});

const startChat = () => resolvers.Mutation.startChat({}, { agentId: agent.id, scope: 'private' }, ctxFor(alice.id));
const respond = (chatId: string, toolResponse: Record<string, unknown>) =>
  resolvers.Mutation.processChatResponse({}, { chatId, toolResponse }, ctxFor(alice.id));

async function state(chatId: string) {
  const chat = await chatNodeByLocOrThrow(db, chatId);
  const data = await db.node.findFirst({ where: { memoryId: chat.memoryId, loc: 'data', deletedAt: null } });
  const assistants = await db.node.count({ where: { memoryId: chat.memoryId, loc: { startsWith: `${chatId}:messages:` } } });
  const root = (await db.node.findUniqueOrThrow({ where: { id: chat.id } })).data as Record<string, unknown>;
  const revisions = data ? await db.nodeRevision.count({ where: { nodeId: data.id } }) : 0;
  // #3496: the operational counter moved out of revisioned root data; stage remains there.
  const counter = await db.chatRootCounter.findUniqueOrThrow({ where: { chatRootNodeId: chat.id }, select: { messageCount: true } });
  expect(root).not.toHaveProperty('messageCount');
  // #3992 (Juliet F1): the AUTHORITATIVE engine state (incl. routeHistory) lives in chat_root_engine_states, not in the
  // legacy root mirror, so a pre-write refusal must leave it byte-identical too.
  const engine = await db.chatRootEngineState.findUnique({ where: { chatRootNodeId: chat.id }, select: { state: true } });
  return { memoryId: chat.memoryId, assistants, count: counter.messageCount, stage: root.stageName, data: data?.data ?? null, revisions, engineState: engine?.state ?? null };
}


const refusal = (p: Promise<unknown>) => p.then(() => null, (e) => e as { extensions?: Record<string, any>; message: string });

describe('#3992 — respond `message` must be a JSON string, refused before any write', () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ['missing', { onTrack: true, data: { region: 'EU' }, next_stage: 'wrap' }],
    ['null', { message: null, onTrack: true, data: { region: 'EU' }, next_stage: 'wrap' }],
    ['number', { message: 42, onTrack: true, data: { region: 'EU' }, next_stage: 'wrap' }],
    ['object', { message: { text: 'secret-model-text' }, onTrack: true, data: { region: 'EU' }, next_stage: 'wrap' }],
  ];
  for (const [label, payload] of bad) {
    it(`${label}: BAD_USER_INPUT naming the field, nothing written, no partialTurn, no echo`, async () => {
      const { chatId } = await startChat();
      const before = await state(chatId);
      const e = await refusal(respond(chatId, payload));
      expect(e).not.toBeNull();
      expect(e?.extensions?.code).toBe('BAD_USER_INPUT');
      expect(e?.message).toMatch(/message/);
      expect(e?.message).toMatch(/string/);
      expect(e?.message).not.toMatch(/secret-model-text|42/);
      expect(e?.extensions).not.toHaveProperty('partialTurn');
      expect(await state(chatId)).toEqual(before);
    });
  }

  for (const [label, message] of [['empty', ''], ['whitespace-only', '  \n '], ['valid', 'hello']] as const) {
    it(`control: ${label} string is recorded as sent`, async () => {
      const { chatId } = await startChat();
      const before = await state(chatId);
      await respond(chatId, { message, onTrack: true });
      const after = await state(chatId);
      expect(after.assistants).toBe(before.assistants + 1);
      expect(Number(after.count)).toBe(Number(before.count) + 1);
      const msg = await db.node.findFirstOrThrow({ where: { memoryId: after.memoryId, loc: { startsWith: `${chatId}:messages:` }, name: { endsWith: '-assistant' } } });
      expect(msg.content ?? '').toBe(message);
    });
  }

  it('control: the snapshot sees the authoritative engine state move on a valid stage change (oracle is reachable)', async () => {
    const { chatId } = await startChat();
    const before = await state(chatId);
    await respond(chatId, { message: 'moving on', onTrack: true, next_stage: 'wrap' });
    const after = await state(chatId);
    expect(after.engineState).not.toEqual(before.engineState);
  });
});
