/**
 * Spec 049 Phase 7 — read-state and the attention section, what is pinned:
 *   - advances are MONOTONIC and keyed on the attendee: a lower seq is a
 *     no-op, a Worker and its Agent-in-App keep separate cursors;
 *   - resolveRegister joins the cursor and the briefing block says "new
 *     since seq N" / "nothing new";
 *   - the run kernel appends the attention section after assembly — the
 *     watermark delta, never a count, never message content — and advances
 *     the cursor in the SAME write as the checkpoint, so a second run says
 *     "nothing new"; a run with no Agent gets no section;
 *   - mentionOnly rows count only new messages naming the attendee's tokens
 *     (every Worker cast from the Agent in that App);
 *   - the GraphQL read follows the briefing's gate; the WRITE (§8.7) admits
 *     only the attendee's driver — a user with a live session bound to the
 *     Worker, or the App-key principal of the attendee's App.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { ensureChannelWithRoot } from './channels.js';
import { appendChatMessage } from './chatRoot.js';
import { getMemoryEncryptionInfo } from './nodeCrypto.js';
import { advanceReadState, readStatesFor, renderAttentionSection } from './channelReadState.js';
import { renderDerivedBlocks, resolveRegister } from './resolveRegister.js';

vi.mock('./bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

import { mintAppRun, executeAppRun, type RunExecutionDeps } from '../jobs/appRuns.js';

const Q = resolvers.Query as any;
const M = resolvers.Mutation as any;

let org: { id: string; urn: string };
let admin: { id: string };
let stranger: { id: string };
let app: { id: string; urn: string };
let agent: { id: string; urn: string };
let appMem: { id: string; urn: string };
let worker: { id: string };
let channel: { id: string; loc: string; memoryId: string; chatRootNodeId: string };
let entry: string;

const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] }) as Context;
const appKeyCtx = (): Context => ({ db, appId: app.id, roles: [] }) as unknown as Context;

function deps(llm = vi.fn(async () => ({ text: 'ok', tokensIn: 10, tokensOut: 5, provider: 'anthropic', model: 'test' }))): RunExecutionDeps & { llm: typeof llm } {
  return {
    assemble: vi.fn(async () => '# Step'),
    loadNodeSpec: vi.fn(async () => ({ extractionSpec: null, hasOutput: false, tools: null })),
    resolveConfig: vi.fn(async () => ({ config: { provider: 'anthropic', model: 'test' } }) as never),
    llm,
    llmObject: vi.fn(async () => ({ object: {}, tokensIn: 1, tokensOut: 1, provider: 'anthropic', model: 'test' })),
    llmTools: vi.fn(async () => ({ text: 'x', tokensIn: 1, tokensOut: 1, provider: 'anthropic', model: 'test', toolCalls: [] })),
    writeOutput: vi.fn(async () => null),
    selectNext: vi.fn(async () => null),
  };
}

async function post(body: string, mentions: string[] = []) {
  const enc = await getMemoryEncryptionInfo(db, channel.memoryId);
  const chat = { id: channel.chatRootNodeId, memoryId: channel.memoryId, loc: channel.loc };
  return appendChatMessage(
    db, chat, enc,
    async ({ tx, seq, msgNum }) =>
      tx.node.create({
        data: { id: generateId(), memoryId: channel.memoryId, loc: `${channel.loc}:messages:${msgNum}`, name: msgNum, nodeType: 'chat-message', seq, content: body, data: { mentions } },
      }),
    { asChannel: true },
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  await cleanDb(db);
  const t = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'rs', urn: `rs-${t}` } });
  const orgB = await db.organization.create({ data: { id: generateId(), name: 'rs-b', urn: `rs-b-${t}` } });
  admin = await db.user.create({ data: { id: generateId(), githubId: 49501, githubUsername: `rs-admin-${t}` } });
  stranger = await db.user.create({ data: { id: generateId(), githubId: 49502, githubUsername: `rs-stranger-${t}` } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgB.id, userId: stranger.id, role: 'ADMIN' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'agent', urn: `${org.urn}:agent`, visibility: 'ORGANIZATION' } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await db.appMember.create({ data: { appId: app.id, userId: admin.id, role: 'admin' } });
  appMem = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:team-shared`, name: 'shared', class: 'app', appId: app.id, sharedMemoryOfAgentId: agent.id },
  });
  worker = await db.worker.create({ data: { id: generateId(), appId: app.id, agentId: agent.id, name: 'Iris', slug: 'iris' } });
  const made = await ensureChannelWithRoot(db, { memoryId: appMem.id, loc: 'chats:team', name: 'team', createdBy: admin.id, asDefaultOfAppId: app.id });
  channel = { id: made.channel.id, loc: 'chats:team', memoryId: appMem.id, chatRootNodeId: made.rootId };
  const node = await db.node.create({ data: { id: generateId(), memoryId: appMem.id, loc: 'tasks:go', name: 'go', nodeType: 'task', content: 'go', isRunnable: true } });
  entry = `hrn:node:${appMem.urn}:${node.loc}`;
});

describe('read-state', () => {
  it('advances monotonically, keyed on the attendee; the register view and the briefing block reflect it', async () => {
    expect(await advanceReadState(db, { workerId: worker.id }, channel.id, 4)).toBe(4);
    expect(await advanceReadState(db, { workerId: worker.id }, channel.id, 2)).toBe(4);
    expect(await advanceReadState(db, { workerId: worker.id }, channel.id, 7)).toBe(7);
    // The Worker's Agent-in-App keeps its own cursor.
    expect((await readStatesFor(db, { agentId: agent.id, appId: app.id }, [channel.id])).size).toBe(0);
    expect(await advanceReadState(db, { agentId: agent.id, appId: app.id }, channel.id, 1)).toBe(1);
    expect(await db.channelReadState.count()).toBe(2);
    await post('one'); await post('two');
    const view = await resolveRegister(db, { attendee: { agentId: agent.id, appId: app.id }, actor: ctx(admin.id) });
    expect(view!.rows[0].readState).toEqual({ lastSeenSeq: 1 });
    expect(renderDerivedBlocks(view)).toContain('new since seq 1 (channel is at 2)');
    await advanceReadState(db, { agentId: agent.id, appId: app.id }, channel.id, 2);
    expect(renderDerivedBlocks(await resolveRegister(db, { attendee: { agentId: agent.id, appId: app.id }, actor: ctx(admin.id) }))).toContain('nothing new (at seq 2)');
  });

  it('the kernel appends the attention section and advances the cursor with the checkpoint; a second run says nothing new; no Agent, no section', async () => {
    await post('one'); await post('two');
    const mint = () => mintAppRun(db, { organizationId: org.id, appId: app.id, agentId: agent.id, userId: admin.id, triggerKind: 'MANUAL', entryNodeUrn: entry, publish: false });
    const first = deps();
    const run1 = await mint();
    expect(await executeAppRun(db, run1.id, first)).toBe('completed');
    const prompt1 = (first.llm.mock.calls[0] as unknown[])[1] as { prompt: string };
    expect(prompt1.prompt).toContain('# Step\n\n## Channels (attention)\n');
    expect(prompt1.prompt).toContain(`- team (${appMem.urn}:chats:team): new since seq 0 (channel is at 2)`);
    expect(prompt1.prompt).not.toContain('one');
    expect((await readStatesFor(db, { agentId: agent.id, appId: app.id }, [channel.id])).get(channel.id)).toBe(2);
    const second = deps();
    const run2 = await mint();
    expect(await executeAppRun(db, run2.id, second)).toBe('completed');
    expect(((second.llm.mock.calls[0] as unknown[])[1] as { prompt: string }).prompt).toContain(`- team (${appMem.urn}:chats:team): nothing new`);
    // A run with no Agent has no attendee: no section, and nothing advanced.
    const third = deps();
    const bare = await mintAppRun(db, { organizationId: org.id, appId: app.id, userId: admin.id, triggerKind: 'MANUAL', entryNodeUrn: entry, publish: false });
    expect(await executeAppRun(db, bare.id, third)).toBe('completed');
    expect(((third.llm.mock.calls[0] as unknown[])[1] as { prompt: string }).prompt).toBe('# Step');
  });

  it('mentionOnly rows count only new messages naming the attendee\'s Workers', async () => {
    await db.registerEntry.updateMany({ where: { appId: app.id }, data: { mentionOnly: true } });
    await post('hello all');
    const run1 = await mintAppRun(db, { organizationId: org.id, appId: app.id, agentId: agent.id, userId: admin.id, triggerKind: 'MANUAL', entryNodeUrn: entry, publish: false });
    const section = await renderAttentionSection(db, run1);
    expect(section.text).toContain('nothing new for you (mention-only; channel is at 1)');
    await post('@iris look', ['iris']);
    await post('@iris again', ['iris']);
    expect((await renderAttentionSection(db, run1)).text).toContain('2 new mentions of you since seq 0 (channel is at 3)');
    await advanceReadState(db, { agentId: agent.id, appId: app.id }, channel.id, 2);
    expect((await renderAttentionSection(db, run1)).text).toContain('1 new mention of you since seq 2 (channel is at 3)');
  });

  it('GraphQL: the read follows the briefing gate; the write admits only the attendee\'s driver', async () => {
    await post('one');
    expect(await Q.channelReadState({}, { attendeeRef: worker.id, channelRef: channel.id }, ctx(admin.id))).toMatchObject({ lastSeenSeq: 0, attendeeUrn: `hrn:worker:${org.urn}:team:iris` });
    expect(await Q.channelReadState({}, { attendeeRef: worker.id, channelRef: channel.id }, ctx(stranger.id))).toBeNull();
    // A participant who is not DRIVING the Worker cannot advance it.
    await expect(M.advanceChannelReadState({}, { attendeeRef: worker.id, channelRef: channel.id, seq: 1 }, ctx(admin.id))).rejects.toThrow(/Forbidden/);
    // A live session bound to the Worker makes the user its driver.
    await db.session.create({ data: { id: generateId(), appId: app.id, userId: admin.id, workerId: worker.id, type: 'DEVELOPER', startedAt: new Date() } as never });
    expect(await M.advanceChannelReadState({}, { attendeeRef: worker.id, channelRef: channel.id, seq: 1 }, ctx(admin.id))).toMatchObject({ lastSeenSeq: 1 });
    // Monotonic: a lower seq is a no-op that returns the cursor.
    expect(await M.advanceChannelReadState({}, { attendeeRef: worker.id, channelRef: channel.id, seq: 0 }, ctx(admin.id))).toMatchObject({ lastSeenSeq: 1 });
    // The App-key principal (the relay) drives the App's attendees; a stranger never does.
    expect(await M.advanceChannelReadState({}, { attendeeRef: agent.urn, appRef: app.urn, channelRef: channel.id, seq: 1 }, appKeyCtx())).toMatchObject({ lastSeenSeq: 1 });
    await expect(M.advanceChannelReadState({}, { attendeeRef: worker.id, channelRef: channel.id, seq: 5 }, ctx(stranger.id))).rejects.toThrow();
    // A user has no driving relation to a bare Agent-in-App attendee.
    await expect(M.advanceChannelReadState({}, { attendeeRef: agent.urn, appRef: app.urn, channelRef: channel.id, seq: 2 }, ctx(admin.id))).rejects.toThrow(/Forbidden/);
  });
});
