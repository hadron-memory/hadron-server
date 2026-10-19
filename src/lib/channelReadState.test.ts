import { WORKER_SIGNATURE_DEFAULTS } from './workerSignature.js';
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
import { encryptNodeFields, getMemoryEncryptionInfo } from './nodeCrypto.js';
import { generateDataKey } from './crypto.js';
import { sessionKeyCache } from './sessionKeyCache.js';
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
    verifyAutomation: vi.fn(async () => undefined),
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

async function post(body: string, mentions: string[] = [], extra: Record<string, unknown> = {}) {
  const enc = await getMemoryEncryptionInfo(db, channel.memoryId);
  const chat = { id: channel.chatRootNodeId, memoryId: channel.memoryId, loc: channel.loc };
  return appendChatMessage(
    db, chat, enc,
    async ({ tx, seq, msgNum }) =>
      tx.node.create({
        data: { id: generateId(), memoryId: channel.memoryId, loc: `${channel.loc}:messages:${msgNum}`, name: msgNum, nodeType: 'chat-message', seq, content: body, data: { mentions, ...extra } },
      }),
    { asChannel: true },
  );
}

/** A post carrying routing metadata: no authorWorkerId is a human's post. */
async function postAs(body: string, mentions: string[], authorWorkerId?: string, extra: Record<string, unknown> = {}) {
  const enc = await getMemoryEncryptionInfo(db, channel.memoryId);
  return appendChatMessage(
    db,
    { id: channel.chatRootNodeId, memoryId: channel.memoryId, loc: channel.loc },
    enc,
    async ({ tx, seq, msgNum }) =>
      tx.node.create({
        data: {
          id: generateId(), memoryId: channel.memoryId, loc: `${channel.loc}:messages:${msgNum}`, name: msgNum,
          nodeType: 'chat-message', seq, content: body,
          data: { mentions, ...(authorWorkerId ? { authorWorkerId } : {}), ...extra },
        },
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
  worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name: 'Iris', slug: 'iris' } });
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
    // #2020: a broadcast is a mention when the server stamped it at post time.
    await post('@all look', ['all'], { broadcastWakes: true });
    await post('@team look', ['team'], { broadcastWakes: true });
    await post('@someone else', ['someone']);
    // An unstamped broadcast is ordinary unread, never a mention (cor:agt:080:08/:14).
    await post('@all unstamped', ['all']);
    expect((await renderAttentionSection(db, run1)).text).toContain('3 new mentions of you since seq 0 (channel is at 6)');
    await advanceReadState(db, { agentId: agent.id, appId: app.id }, channel.id, 2);
    expect((await renderAttentionSection(db, run1)).text).toContain('2 new mentions of you since seq 2 (channel is at 6)');
  });

  it('an encrypted Channel\'s mention-only row reports new messages instead of "nothing new for you" (#1362 review)', async () => {
    // The run's entry memory stays plaintext (headless runs refuse an
    // encrypted entry); the REGISTERED Channel lives in an encrypted memory.
    const encMem = await db.memory.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:sealed`, name: 'sealed', class: 'knowledge', visibility: 'ORGANIZATION', isEncrypted: true },
    });
    sessionKeyCache.set('rs-encrypted', encMem.id, generateDataKey());
    const made = await ensureChannelWithRoot(db, { memoryId: encMem.id, loc: 'chats:sealed', name: 'sealed', createdBy: admin.id });
    await db.registerEntry.create({
      data: { id: generateId(), appId: app.id, channelId: made.channel.id, attendeeAgentId: agent.id, role: 'BOTH', mentionOnly: true },
    });
    const enc = await getMemoryEncryptionInfo(db, encMem.id);
    // Stored exactly as a real encrypted post is: the envelope becomes { __enc }.
    const sealed = encryptNodeFields({ content: '@all look', data: { mentions: ['all'] } }, enc);
    expect(sealed.data).toHaveProperty('__enc');
    await appendChatMessage(
      db,
      { id: made.rootId, memoryId: encMem.id, loc: 'chats:sealed' },
      enc,
      async ({ tx, seq, msgNum }) =>
        tx.node.create({
          data: {
            id: generateId(), memoryId: encMem.id, loc: `chats:sealed:messages:${msgNum}`, name: msgNum,
            nodeType: 'chat-message', seq, content: sealed.content, data: sealed.data as never,
          },
        }),
      { asChannel: true },
    );
    const run = await mintAppRun(db, { organizationId: org.id, appId: app.id, agentId: agent.id, userId: admin.id, triggerKind: 'MANUAL', entryNodeUrn: entry, publish: false });
    const { text } = await renderAttentionSection(db, run);
    expect(text).toContain(`- sealed (${encMem.urn}:chats:sealed): new since seq 0 (channel is at 1; encrypted, so mentions were not filtered)`);
    sessionKeyCache.clear();
  });

  it('an attendee\'s own broadcast is not attention for it; someone else\'s is (#1362 review)', async () => {
    await db.registerEntry.updateMany({ where: { appId: app.id }, data: { mentionOnly: true } });
    // Iris is cast from this run's Agent: her team-wide post is the attendee's own.
    await postAs('@all heads up', ['all'], worker.id, { broadcastWakes: true });
    const run = await mintAppRun(db, { organizationId: org.id, appId: app.id, agentId: agent.id, userId: admin.id, triggerKind: 'MANUAL', entryNodeUrn: entry, publish: false });
    expect((await renderAttentionSection(db, run)).text).toContain('nothing new for you (mention-only; channel is at 1)');
    await postAs('@all from a human', ['all'], undefined, { broadcastWakes: true });
    expect((await renderAttentionSection(db, run)).text).toContain('1 new mention of you since seq 0 (channel is at 2)');
    // #2020: an unstamped one from a human is not a mention.
    await postAs('@all quoted by a human', ['all']);
    expect((await renderAttentionSection(db, run)).text).toContain('1 new mention of you since seq 0 (channel is at 3)');
  });

  it('an unfiltered row: the attendee\'s own posts are never new to it; a human\'s or another Agent\'s are (#1388)', async () => {
    const run = await mintAppRun(db, { organizationId: org.id, appId: app.id, agentId: agent.id, userId: admin.id, triggerKind: 'MANUAL', entryNodeUrn: entry, publish: false });
    // Iris is cast from this run's Agent, and a retired sibling's posts are still its own.
    const retired = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name: 'Old', slug: 'old', retiredAt: new Date() } });
    await postAs('done with the build', [], worker.id);
    await postAs('old note', [], retired.id);
    const own = await renderAttentionSection(db, run);
    expect(own.text).toContain(`- team (${appMem.urn}:chats:team): nothing new from others since seq 0 (channel is at 2)`);
    // The checkpoint still moves past them: they are read, not pending.
    expect(own.captured.get(channel.id)).toBe(2);
    // A human's post carries no authorWorkerId, and it is news.
    await postAs('a human asks', []);
    expect((await renderAttentionSection(db, run)).text).toContain(`- team (${appMem.urn}:chats:team): new since seq 0 (channel is at 3)`);
    // So is another Agent's Worker, once the human's post has been seen.
    await advanceReadState(db, { agentId: agent.id, appId: app.id }, channel.id, 3);
    const otherAgent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'other', urn: `${org.urn}:other`, visibility: 'ORGANIZATION' } });
    const stranger = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: otherAgent.id, name: 'Zed', slug: 'zed' } });
    await postAs('mine now', [], worker.id);
    expect((await renderAttentionSection(db, run)).text).toContain('nothing new from others since seq 3 (channel is at 4)');
    // A deleted post is no news either.
    const gone = await postAs('retracted', [], stranger.id);
    await db.node.update({ where: { id: gone.inserted.id }, data: { deletedAt: new Date() } });
    expect((await renderAttentionSection(db, run)).text).toContain('nothing new from others since seq 3 (channel is at 5)');
    await postAs('from zed', [], stranger.id);
    expect((await renderAttentionSection(db, run)).text).toContain('new since seq 3 (channel is at 6)');
  });

  it('an encrypted unfiltered row says own posts were not filtered, rather than decrypting (#1388)', async () => {
    const encMem = await db.memory.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:sealed-w`, name: 'sealed-w', class: 'knowledge', visibility: 'ORGANIZATION', isEncrypted: true },
    });
    sessionKeyCache.set('rs-encrypted-w', encMem.id, generateDataKey());
    const made = await ensureChannelWithRoot(db, { memoryId: encMem.id, loc: 'chats:sealed', name: 'sealed', createdBy: admin.id });
    await db.registerEntry.create({
      data: { id: generateId(), appId: app.id, channelId: made.channel.id, attendeeAgentId: agent.id, role: 'BOTH', mentionOnly: false },
    });
    await db.channel.update({ where: { id: made.channel.id }, data: { lastSeq: 2 } });
    const run = await mintAppRun(db, { organizationId: org.id, appId: app.id, agentId: agent.id, userId: admin.id, triggerKind: 'MANUAL', entryNodeUrn: entry, publish: false });
    expect((await renderAttentionSection(db, run)).text).toContain(
      `- sealed (${encMem.urn}:chats:sealed): new since seq 0 (channel is at 2; encrypted, so your own posts were not filtered)`,
    );
    sessionKeyCache.clear();
  });

  it('a cleanly reused Channel has no phantom attention and its next message clears old cursors (#1226)', async () => {
    await post('old one');
    await post('old two');
    // An existing attendee trails the old watermark. Keeping Channel.lastSeq=2
    // after removing both messages would report phantom attention; restarting
    // message seq at 1 would let this cursor hide a future message.
    await advanceReadState(db, { agentId: agent.id, appId: app.id }, channel.id, 1);
    await M.deleteChannel({}, { ref: channel.id }, ctx(admin.id));
    await ensureChannelWithRoot(db, {
      memoryId: appMem.id,
      loc: channel.loc,
      name: 'team',
      createdBy: admin.id,
      asDefaultOfAppId: app.id,
    });

    const run = await mintAppRun(db, {
      organizationId: org.id,
      appId: app.id,
      agentId: agent.id,
      userId: admin.id,
      triggerKind: 'MANUAL',
      entryNodeUrn: entry,
      publish: false,
    });
    expect((await renderAttentionSection(db, run)).text).toContain('nothing new');

    const fresh = await post('fresh');
    expect(fresh.seq).toBe(3);
    expect((await renderAttentionSection(db, run)).text).toContain('new since seq 1 (channel is at 3)');
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

describe('PR #1168 review — the oracles and the watermark', () => {
  it('an uninstalled Agent is no attendee; an unregistered Channel is "no match"; a seq past the watermark is refused; an unreadable host never reaches the prompt', async () => {
    const loose = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'loose', urn: `${org.urn}:loose`, visibility: 'ORGANIZATION' } });
    expect(await Q.channelReadState({}, { attendeeRef: loose.urn, appRef: app.urn, channelRef: channel.id }, ctx(admin.id))).toBeNull();
    // A live Channel the attendee does not attend (no register row names it) reads as no match — and cannot be written.
    const side = (await ensureChannelWithRoot(db, { memoryId: appMem.id, loc: 'chats:side', name: 'side', createdBy: admin.id })).channel;
    await db.registerEntry.deleteMany({ where: { channelId: side.id } });
    expect(await Q.channelReadState({}, { attendeeRef: worker.id, channelRef: side.id }, ctx(admin.id))).toBeNull();
    await expect(M.advanceChannelReadState({}, { attendeeRef: agent.urn, appRef: app.urn, channelRef: side.id, seq: 0 }, appKeyCtx())).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    // The watermark bounds the cursor.
    await post('one');
    await expect(M.advanceChannelReadState({}, { attendeeRef: agent.urn, appRef: app.urn, channelRef: channel.id, seq: 5 }, appKeyCtx())).rejects.toMatchObject({ extensions: { code: 'SEQ_BEYOND_WATERMARK', lastSeq: 1 } });
    expect(await M.advanceChannelReadState({}, { attendeeRef: agent.urn, appRef: app.urn, channelRef: channel.id, seq: 1 }, appKeyCtx())).toMatchObject({ lastSeenSeq: 1 });
    // An org-owned row naming ANOTHER App's Channel: the run's principal (App-key of this App) cannot read that host,
    // so the attention section neither names it nor advances a cursor for it.
    const appB = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'B', urn: `${org.urn}:b` } });
    await db.appAgent.create({ data: { appId: appB.id, agentId: agent.id } });
    const memB = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:b-shared`, name: 'b', class: 'app', appId: appB.id, sharedMemoryOfAgentId: agent.id } });
    const foreign = (await ensureChannelWithRoot(db, { memoryId: memB.id, loc: 'chats:team', name: 'team', createdBy: admin.id, asDefaultOfAppId: appB.id })).channel;
    await db.registerEntry.create({ data: { id: generateId(), organizationId: org.id, channelId: foreign.id, role: 'BOTH' } });
    const run = await mintAppRun(db, { organizationId: org.id, appId: app.id, agentId: agent.id, triggerKind: 'MANUAL', entryNodeUrn: entry, publish: false });
    const section = await renderAttentionSection(db, run);
    expect(section.text).toContain('- team (');
    expect(section.text).not.toContain(memB.urn);
    expect(section.captured.has(foreign.id)).toBe(false);
    expect(section.captured.has(channel.id)).toBe(true);
  });
});

describe('#1171 — the Channel address on the read-state surface', () => {
  it('reads and advances the cursor by address, and an unregistered address is the same "no match"', async () => {
    const address = `hrn:node:${appMem.urn}:chats:team`;
    await post('one');
    expect(await Q.channelReadState({}, { attendeeRef: worker.id, channelRef: address }, ctx(admin.id))).toMatchObject({ lastSeenSeq: 0, channelId: channel.id });
    // The register check compares CHANNEL IDS, so the ref has to become one
    // before it is checked: a URN compared against a stored id would miss and
    // read as "not registered" — the same answer a foreign Channel gets, and
    // therefore silent.
    expect(
      await M.advanceChannelReadState({}, { attendeeRef: agent.urn, appRef: app.urn, channelRef: address, seq: 1 }, appKeyCtx()),
    ).toMatchObject({ lastSeenSeq: 1, channelId: channel.id });
    // Unregistered, unreadable and unknown addresses stay indistinguishable.
    const side = (await ensureChannelWithRoot(db, { memoryId: appMem.id, loc: 'chats:side', name: 'side', createdBy: admin.id })).channel;
    await db.registerEntry.deleteMany({ where: { channelId: side.id } });
    expect(await Q.channelReadState({}, { attendeeRef: worker.id, channelRef: `hrn:node:${appMem.urn}:chats:side` }, ctx(admin.id))).toBeNull();
    expect(await Q.channelReadState({}, { attendeeRef: worker.id, channelRef: `hrn:node:${appMem.urn}:chats:absent` }, ctx(admin.id))).toBeNull();
    expect(await Q.channelReadState({}, { attendeeRef: worker.id, channelRef: address }, ctx(stranger.id))).toBeNull();
  });
});
