/**
 * #3514 — processChatResponse commits the assistant message and counter, then judges the extraction, then (only if
 * that passes) advances the stage. When the authoring gate refuses the extraction the call errors, and nothing used
 * to tell the caller that the message and counter had already committed. The refusal now carries a typed, additive
 * `extensions.partialTurn` report. Chip's five wire cases are the oracle (issue #3514); the gate's own semantics
 * (codes, untouched target, no revision) are pinned unchanged.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, chatNodeByLocOrThrow } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
import { generateId } from '../../../lib/id.js';
import { serveEveryAgent } from '../../../test/servedBootPrompt.js';
import { reportPartialTurn } from '../../../lib/chatPartialTurn.js';
import { AuthoringAttestationError } from '../../../lib/authoringAttestation.js';
import { GraphQLError } from 'graphql';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

let alice: { id: string };
let agent: { id: string };
const ctxFor = (userId: string): Context => ({ db, roles: ['READER'], userId });

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'org-3514', urn: 'org-3514' } });
  alice = await db.user.create({ data: { githubId: 35141, githubUsername: 'alice-3514', roles: ['READER'] } });
  const admin = await db.user.create({ data: { githubId: 35140, githubUsername: 'admin-3514', roles: ['ADMIN'] } });
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
  await serveEveryAgent(db);
});

const startChat = () => resolvers.Mutation.startChat({}, { agentId: agent.id, scope: 'private' }, ctxFor(alice.id));
const respond = (chatId: string, toolResponse: Record<string, unknown>) =>
  resolvers.Mutation.processChatResponse({}, { chatId, toolResponse }, ctxFor(alice.id));

async function state(chatId: string) {
  const chat = await chatNodeByLocOrThrow(db, chatId);
  const data = await db.node.findFirst({ where: { memoryId: chat.memoryId, loc: 'data', deletedAt: null } });
  const assistants = await db.node.count({ where: { memoryId: chat.memoryId, loc: { startsWith: `${chatId}:messages:` }, name: { endsWith: '-assistant' } } });
  const root = (await db.node.findUniqueOrThrow({ where: { id: chat.id } })).data as Record<string, unknown>;
  const revisions = data ? await db.nodeRevision.count({ where: { nodeId: data.id } }) : 0;
  return { memoryId: chat.memoryId, assistants, count: root.messageCount, stage: root.stageName, data: data?.data ?? null, revisions };
}

/** Seed the data node, then govern it: role `guide` with a required author task (runnable unless told otherwise). */
async function governed(chatId: string, opts: { runnable?: boolean } = {}) {
  const { memoryId } = await state(chatId);
  await db.node.updateMany({ where: { memoryId, loc: 'data' }, data: { role: 'guide' } });
  const task = await db.node.create({ data: { id: generateId(), memoryId, loc: 'author-task', name: 'Author task', isRunnable: opts.runnable !== false, content: 'how' } });
  const config = await db.memoryConfig.upsert({ where: { memoryId }, update: {}, create: { id: generateId(), memoryId } });
  await db.nodeRoleRule.create({ data: { id: generateId(), configId: config.id, role: 'guide', authorTaskId: task.id, authorTaskRequired: true } });
}

const refusal = (p: Promise<unknown>) => p.then(() => null, (e) => e as { extensions?: Record<string, any>; message: string });
const PARTIAL = (code: string) => ({
  persisted: ['ASSISTANT_MESSAGE', 'MESSAGE_COUNTER'],
  refused: [{ component: 'EXTRACTION', code }],
  notRun: ['STAGE_PROGRESSION'],
});

describe('#3514 — the refused extraction reports what the turn did and did not do', () => {
  async function seeded() {
    const chat = await startChat();
    await respond(chat.chatId, { message: 'first', data: { region: 'EU' }, onTrack: true });
    return chat.chatId;
  }

  it('case 2: a changed extraction with no claim keeps its code and now names the persisted, refused and not-run parts', async () => {
    const chatId = await seeded();
    await governed(chatId);
    const before = await state(chatId);
    const e = await refusal(respond(chatId, { message: 'second', data: { region: 'US' }, next_stage: 'wrap', onTrack: true }));
    expect(e?.extensions).toMatchObject({ code: 'AUTHORING_ATTESTATION_MISSING', role: 'guide', partialTurn: PARTIAL('AUTHORING_ATTESTATION_MISSING') });
    const after = await state(chatId);
    expect(after.assistants).toBe(before.assistants + 1);
    expect(after.count).toBe(Number(before.count) + 1);
    expect(after.stage).toBe(before.stage);
    expect(after.data).toEqual(before.data);
    expect(after.revisions).toBe(before.revisions);
  });

  it('case 3: a required task that is not runnable is AUTHOR_TASK_BROKEN with the same report; gate semantics unchanged', async () => {
    const chatId = await seeded();
    await governed(chatId, { runnable: false });
    const before = await state(chatId);
    const e = await refusal(respond(chatId, { message: 'second', data: { region: 'US' }, next_stage: 'wrap', onTrack: true }));
    expect(e?.extensions).toMatchObject({ code: 'AUTHOR_TASK_BROKEN', partialTurn: PARTIAL('AUTHOR_TASK_BROKEN') });
    const after = await state(chatId);
    expect([after.assistants, after.count, after.stage]).toEqual([before.assistants + 1, Number(before.count) + 1, before.stage]);
    expect(after.data).toEqual(before.data);
  });

  const SUCCESS_KEYS = ['chatEnded', 'conversationHandoff', 'displayMessage', 'newStageName', 'offTrackReason', 'onTrack', 'stageTransitioned'];

  it('case 1: no role requirement, the extraction changes data: success, shape unchanged, no report', async () => {
    const chatId = await seeded();
    const ok = await respond(chatId, { message: 'x', data: { region: 'US' }, next_stage: 'wrap', onTrack: true });
    expect(Object.keys(ok).sort()).toEqual(SUCCESS_KEYS);
    expect(ok).toMatchObject({ stageTransitioned: true, newStageName: 'wrap' });
    expect((await state(chatId)).data).toMatchObject({ region: 'US' });
  });

  it('case 4: a governed target but the extraction equals what is stored: success, nothing written', async () => {
    const chatId = await seeded();
    await governed(chatId);
    const before = await state(chatId);
    const ok = await respond(chatId, { message: 'x', data: { region: 'EU' }, next_stage: 'wrap', onTrack: true });
    expect(Object.keys(ok).sort()).toEqual(SUCCESS_KEYS);
    expect(ok).toMatchObject({ stageTransitioned: true });
    expect((await state(chatId)).data).toEqual(before.data);
  });

  it('case 5: a governed target and a message-only turn: success, stage advances', async () => {
    const chatId = await seeded();
    await governed(chatId);
    const ok = await respond(chatId, { message: 'x', next_stage: 'wrap', onTrack: true });
    expect(Object.keys(ok).sort()).toEqual(SUCCESS_KEYS);
    expect(ok).toMatchObject({ stageTransitioned: true });
  });

  it('the report adds no disclosure: only the fixed component names and the existing refusal code, no ids, task or revision', async () => {
    const chatId = await seeded();
    await governed(chatId);
    const e = await refusal(respond(chatId, { message: 'second', data: { region: 'US' }, onTrack: true }));
    const partial = e?.extensions?.partialTurn;
    expect(Object.keys(partial).sort()).toEqual(['notRun', 'persisted', 'refused']);
    expect(Object.keys(partial.refused[0]).sort()).toEqual(['code', 'component']);
    const task = await db.node.findUniqueOrThrow({ where: { loc_memoryId: { loc: 'author-task', memoryId: (await state(chatId)).memoryId } } });
    expect(JSON.stringify(e?.extensions)).not.toContain(task.id);
    expect(Object.keys(e!.extensions!).sort()).toEqual(['code', 'partialTurn', 'role']);
  });

  it('an error that is not an extraction refusal carries no report', async () => {
    const e = await refusal(respond(`no-such-chat-${generateId()}`, { message: 'x', data: { region: 'US' } }));
    expect(e).not.toBeNull();
    expect(e?.extensions?.partialTurn).toBeUndefined();
  });

  it('reportPartialTurn labels only the authoring gate\'s typed refusal; any other error passes through as the same object', () => {
    const labelled = (() => { try { reportPartialTurn(new AuthoringAttestationError('AUTHORING_ATTESTATION_MISSING', 'guide')); } catch (e) { return e as GraphQLError; } })();
    expect(labelled?.extensions).toEqual({ code: 'AUTHORING_ATTESTATION_MISSING', role: 'guide', partialTurn: PARTIAL('AUTHORING_ATTESTATION_MISSING') });
    for (const other of [new Error('lock timeout'), new GraphQLError('other', { extensions: { code: 'BAD_USER_INPUT' } })]) {
      let caught: unknown;
      try { reportPartialTurn(other); } catch (e) { caught = e; }
      expect(caught).toBe(other);
      expect((caught as GraphQLError).extensions?.partialTurn).toBeUndefined();
    }
  });

  it('the SDL says the report exists and that repeating the call may append another assistant message', () => {
    const doc = typeDefs.slice(typeDefs.indexOf('Process the LLM'), typeDefs.indexOf('processChatResponse(chatId'));
    expect(doc).toContain('partialTurn');
    expect(doc).toMatch(/may append another assistant message/);
    expect(doc).toMatch(/not atomic/i);
  });
});
