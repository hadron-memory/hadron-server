import { WORKER_SIGNATURE_DEFAULTS } from './workerSignature.js';
/** #1353 — loss-safe compact attention, worker-owned reads and switchover. */

import { buildSchema, parse, validate } from 'graphql';
import { readFileSync } from 'node:fs';
import { typeDefs } from '../api/graphql/schema/typeDefs.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, suspendChatSeqUniqueness } from '../test/helpers.js';
import { generateId } from './id.js';
import { ensureChannelWithRoot } from './channels.js';
import { appendChatMessage } from './chatRoot.js';
import { getMemoryEncryptionInfo } from './nodeCrypto.js';
import { sessionKeyCache } from './sessionKeyCache.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { locateTeamChatChannel } from '../api/graphql/schema/resolvers.teamChat.js';
import type { AuthContext } from '../middleware/auth.js';
import { resumableOwnWorkerIds } from './teamAttention.js';

vi.mock('./bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

// #2138 §3.1: an own-session read of the team channel creates the row (lastCheckedAt) at seq 0, so "unread" is a position of 0.
const seenSeq = async (workerId: string, channelId: string) =>
  (await db.channelReadState.findFirst({ where: { workerId, channelId } }))?.lastSeenSeq ?? 0;

const Q = resolvers.Query as any;
const M = resolvers.Mutation as any;

let org: { id: string; urn: string };
let user: { id: string };
let otherUser: { id: string };
let app: { id: string; urn: string };
let otherApp: { id: string; urn: string };
let agent: { id: string };
let memory: { id: string; urn: string };
let channel: { id: string; memoryId: string; loc: string; chatRootNodeId: string };
let worker: { id: string; name: string };
let sessionId: string;


const userCtx = (extra: Partial<Context> = {}): Context => ({ db, userId: user.id, roles: ['READER'], ...extra }) as Context;

async function post(body: string, options: { authorWorkerId?: string; mentions?: string[]; broadcastWakes?: boolean } = {}) {
  const enc = await getMemoryEncryptionInfo(db, channel.memoryId);
  return appendChatMessage(
    db,
    { id: channel.chatRootNodeId, memoryId: channel.memoryId, loc: channel.loc },
    enc,
    async ({ tx, seq, msgNum }) => tx.node.create({
      data: {
        id: generateId(),
        memoryId: channel.memoryId,
        loc: `${channel.loc}:messages:${msgNum}`,
        name: msgNum,
        nodeType: 'chat-message',
        seq,
        messageChannelId: channel.id,
        content: body,
        data: {
          mentions: options.mentions ?? [],
          ...(options.authorWorkerId ? { authorWorkerId: options.authorWorkerId } : {}),
          ...(options.broadcastWakes !== undefined ? { broadcastWakes: options.broadcastWakes } : {}),
        },
      },
    }),
    { asChannel: true },
  );
}

async function addWorker(name: string) {
  const made = await db.worker.create({
    data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name, slug: name.toLowerCase() },
  });
  await db.registerEntry.create({
    data: { id: generateId(), appId: app.id, channelId: channel.id, attendeeWorkerId: made.id, role: 'BOTH' },
  });
  const madeSession = await db.session.create({
    data: { id: generateId(), appId: app.id, userId: user.id, workerId: made.id, agentId: agent.id, type: 'DEVELOPER', startedAt: new Date() },
  });
  return { ...made, sessionId: madeSession.id };
}

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'attention', urn: `attention-${suffix}.com` } });
  user = await db.user.create({ data: { id: generateId(), githubId: 1353001, githubUsername: `attention-${suffix}` } });
  otherUser = await db.user.create({ data: { id: generateId(), githubId: 1353002, githubUsername: `other-${suffix}` } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: otherUser.id, role: 'ADMIN' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Pilot', urn: `${org.urn}:pilot` } });
  otherApp = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Other', urn: `${org.urn}:other` } });
  agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team`, visibility: 'ORGANIZATION' } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await db.appMember.create({ data: { appId: app.id, userId: user.id, role: 'admin' } });
  memory = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: `${org.urn}:pilot-shared`,
      name: 'shared',
      class: 'app',
      appId: app.id,
      sharedMemoryOfAgentId: agent.id,
    },
  });
  worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name: 'Dara', slug: 'dara' } });
  const made = await ensureChannelWithRoot(db, {
    memoryId: memory.id,
    loc: 'chats:team',
    name: 'team',
    createdBy: user.id,
    asDefaultOfAppId: app.id,
  });
  channel = { id: made.channel.id, memoryId: memory.id, loc: 'chats:team', chatRootNodeId: made.rootId };
  await db.registerEntry.create({
    data: { id: generateId(), appId: app.id, channelId: channel.id, attendeeWorkerId: worker.id, role: 'BOTH' },
  });
  sessionId = generateId();
  await db.session.create({
    data: { id: sessionId, appId: app.id, userId: user.id, workerId: worker.id, agentId: agent.id, type: 'DEVELOPER', startedAt: new Date() },
  });
});

afterEach(() => {
  delete process.env.TEAM_ATTENTION_TOKEN_SECRET;
  sessionKeyCache.clear();
});

describe('worker-owned ordinary reads', () => {
  it('#1628 exposes the opt-out on the GraphQL team-chat read, defaulting true (and, since #2181, on the pinned channelMessages)', () => {
    const schema = buildSchema(typeDefs);
    const field = schema.getQueryType()!.getFields().teamChatMessages;
    expect(field.args.find((arg) => arg.name === 'advanceReadState')?.defaultValue).toBe(true);
    expect(validate(schema, parse('{ teamChatMessages(appRef: "x", advanceReadState: false) { total } }'))).toEqual([]);
    // #2181: a pinned page must be able to defer its acknowledgement too (the client contract of hadron-cli#957).
    expect(schema.getQueryType()!.getFields().channelMessages.args.find((arg) => arg.name === 'advanceReadState')?.defaultValue).toBe(true);
    expect(validate(schema, parse('{ channelMessages(channelRef: "x", beforeSeq: 2, expectedIncarnation: 1, advanceReadState: false) { total } }')))
      .toEqual([]);
    // Older-server refusal is a validation error naming exactly the new field/argument.
    const oldSchema = buildSchema(typeDefs.replace('advanceReadState: Boolean = true', ''));
    expect(validate(oldSchema, parse('{ teamChatMessages(appRef: "x", advanceReadState: false) { total } }'))[0].message)
      .toBe('Unknown argument "advanceReadState" on field "Query.teamChatMessages".');
  });

  it('#1628 defers acknowledgement while preserving returned messages and attributed usage', async () => {
    await post('deferred read');
    const ctx = userCtx({ sessionId });
    const page = await Q.teamChatMessages({}, { appRef: app.id, sinceSeq: 0, advanceReadState: false }, ctx);
    expect(page.items.map((m: { seq: number }) => m.seq)).toEqual([1]);
    expect(await seenSeq(worker.id, channel.id)).toBe(0); // #2138: a read may stamp lastCheckedAt, but moves no read position
    await vi.waitFor(async () => {
      const reads = await db.usageEvent.findMany({ where: { type: 'read', memoryId: memory.id } });
      expect(reads).toHaveLength(1);
      expect(reads[0]).toMatchObject({ sessionId, userId: user.id, nodeId: page.items[0].nodeId });
    });
    await M.markOwnTeamChatRead({}, { appRef: app.id, channelRef: channel.id, sessionRef: sessionId, seq: 1 }, userCtx());
    expect(await db.channelReadState.findFirst({ where: { workerId: worker.id, channelId: channel.id } }))
      .toMatchObject({ lastSeenSeq: 1 });
  });

  it.each([undefined, null, true])('#1628 preserves automatic acknowledgement for %s', async (advanceReadState) => {
    await post('normal read');
    await Q.teamChatMessages({}, { appRef: app.id, sinceSeq: 0, advanceReadState }, userCtx({ sessionId }));
    expect(await db.channelReadState.findFirst({ where: { workerId: worker.id, channelId: channel.id } }))
      .toMatchObject({ lastSeenSeq: 1 });
  });

  it('does not mark a partial newest page as a contiguous read', async () => {
    for (let i = 1; i <= 5; i++) await post(`message ${i}`);
    const ctx = userCtx({ sessionId });
    const latest = await Q.channelMessages({}, { channelRef: channel.id, limit: 2 }, ctx);
    expect(latest.items.map((m: { seq: number }) => m.seq)).toEqual([4, 5]);
    expect(await seenSeq(worker.id, channel.id)).toBe(0); // #2138: a read may stamp lastCheckedAt, but moves no read position

    await Q.channelMessages({}, { channelRef: channel.id, sinceSeq: 0, limit: 2 }, ctx);
    expect(await db.channelReadState.findFirst({ where: { workerId: worker.id, channelId: channel.id } })).toMatchObject({ lastSeenSeq: 2 });
  });

  it('#3759 a teamHeadRefs read is a partial window and never advances the read cursor; an empty list is not a filter', async () => {
    for (let i = 1; i <= 3; i++) await post(`message ${i}`);
    const head = worker.id;
    await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name: 'Report', slug: 'report', reportsToWorkerId: head } });
    const ctx = userCtx({ sessionId });
    await Q.channelMessages({}, { channelRef: channel.id, sinceSeq: 0, limit: 50, teamHeadRefs: [head] }, ctx);
    await Q.teamChatMessages({}, { appRef: app.id, sinceSeq: 0, limit: 50, teamHeadRefs: [head] }, ctx);
    expect(await seenSeq(worker.id, channel.id)).toBe(0);
    await Q.channelMessages({}, { channelRef: channel.id, sinceSeq: 0, limit: 50, teamHeadRefs: [] }, ctx);
    expect(await seenSeq(worker.id, channel.id)).toBe(3);
  });

  it('does not mark a cursor-less tail even when the whole chat fits', async () => {
    await post('only message');
    const page = await Q.channelMessages({}, { channelRef: channel.id }, userCtx({ sessionId }));
    expect(page.items.map((m: { seq: number }) => m.seq)).toEqual([1]);
    expect(await seenSeq(worker.id, channel.id)).toBe(0); // #2138: a read may stamp lastCheckedAt, but moves no read position
  });

  it('a partial page ending inside a legacy duplicate seq stops one short (#1362 review)', async () => {
    await post('one');
    await post('two, first of a pre-#919 duplicate pair');
    // The backfilled sibling: same seq, written outside the allocator —
    // plantable only with #992's constraint aside (see the helper).
    await suspendChatSeqUniqueness(db);
    await db.node.create({
      data: {
        id: generateId(), memoryId: channel.memoryId, loc: `${channel.loc}:messages:002-dup`, name: '002-dup',
        nodeType: 'chat-message', seq: 2, content: 'two, the unread sibling', createdAt: new Date(Date.now() + 1000),
      },
    });
    const ctx = userCtx({ sessionId });
    const page = await Q.channelMessages({}, { channelRef: channel.id, sinceSeq: 0, beforeSeq: null, mentionsRef: null, limit: 2, offset: 0 }, ctx);
    expect(page.items.map((m: { seq: number }) => m.seq)).toEqual([1, 2]);
    // Advancing to 2 would hide the sibling from every later read and count.
    expect(await db.channelReadState.findFirst({ where: { workerId: worker.id, channelId: channel.id } })).toMatchObject({ lastSeenSeq: 1 });
    // Reading the rest finishes the pair, and the cursor then reaches the head.
    await Q.channelMessages({}, { channelRef: channel.id, sinceSeq: 1, beforeSeq: null, mentionsRef: null, limit: 50, offset: 0 }, ctx);
    expect(await db.channelReadState.findFirst({ where: { workerId: worker.id, channelId: channel.id } })).toMatchObject({ lastSeenSeq: 2 });
  });

  it('advances only contiguous, unfiltered forward pages and preserves every unsafe window', async () => {
    for (let i = 1; i <= 5; i++) await post(`message ${i}`);
    const ctx = userCtx({ sessionId });

    // A partial forward page proves only that page was consumed.
    await Q.channelMessages({}, { channelRef: channel.id, sinceSeq: 0, beforeSeq: null, mentionsRef: null, limit: 2, offset: 0 }, ctx);
    expect(await db.channelReadState.findFirst({ where: { workerId: worker.id, channelId: channel.id } })).toMatchObject({ lastSeenSeq: 2 });

    // Starting ahead of the stored cursor leaves a gap; backward, offset and
    // filtered windows likewise cannot prove the missing interval was read.
    await Q.channelMessages({}, { channelRef: channel.id, sinceSeq: 4, beforeSeq: null, mentionsRef: null, limit: 50, offset: 0 }, ctx);
    await Q.channelMessages({}, { channelRef: channel.id, sinceSeq: null, beforeSeq: 5, mentionsRef: null, limit: 2, offset: 0 }, ctx);
    await Q.channelMessages({}, { channelRef: channel.id, sinceSeq: 2, beforeSeq: null, mentionsRef: null, limit: 2, offset: 1 }, ctx);
    await Q.channelMessages({}, { channelRef: channel.id, sinceSeq: 2, beforeSeq: null, mentionsRef: worker.id, limit: 50, offset: 0 }, ctx);
    expect(await db.channelReadState.findFirst({ where: { workerId: worker.id, channelId: channel.id } })).toMatchObject({ lastSeenSeq: 2 });

    // The complete contiguous remainder reaches the captured head.
    await Q.channelMessages({}, { channelRef: channel.id, sinceSeq: 2, beforeSeq: null, mentionsRef: null, limit: 50, offset: 0 }, ctx);
    expect(await db.channelReadState.findFirst({ where: { workerId: worker.id, channelId: channel.id } })).toMatchObject({ lastSeenSeq: 5 });
  });

  it('an empty visible result may cross tombstones, while count-only and outside-pilot reads stay read-only', async () => {
    const tombstone = await post('deleted before read');
    await db.node.updateMany({
      where: { memoryId: channel.memoryId, nodeType: 'chat-message', seq: tombstone.seq },
      data: { deletedAt: new Date() },
    });
    const ctx = userCtx({ sessionId });

    await Q.channelMessages({}, { channelRef: channel.id, sinceSeq: 0, beforeSeq: null, mentionsRef: null, limit: 0, offset: 0 }, ctx);
    expect(await seenSeq(worker.id, channel.id)).toBe(0); // #2138: a read may stamp lastCheckedAt, but moves no read position
    await Q.channelMessages({}, { channelRef: channel.id, sinceSeq: 0, beforeSeq: null, mentionsRef: null, limit: 50, offset: 0 }, ctx);
    expect(await db.channelReadState.findFirst({ where: { workerId: worker.id, channelId: channel.id } })).toMatchObject({ lastSeenSeq: 1 });

    await db.channelReadState.deleteMany();
    // #1353: the pilot allowlist is gone — the boundary is the caller's OWN
    // live Worker session. A session id that no longer exists captures
    // nothing (the lost-participation shape).
    await db.session.delete({ where: { id: sessionId } });
    await Q.channelMessages({}, { channelRef: channel.id, sinceSeq: 0, beforeSeq: null, mentionsRef: null, limit: 50, offset: 0 }, ctx);
    expect(await seenSeq(worker.id, channel.id)).toBe(0); // #2138: a read may stamp lastCheckedAt, but moves no read position
  });

  it('derives the cursor owner App from the Worker session for a registered free-standing Channel', async () => {
    const externalMemory = await db.memory.create({
      data: {
        id: generateId(),
        ownerUserId: user.id,
        urn: `${org.urn}:external-${Date.now()}`,
        name: 'external',
        class: 'knowledge',
      },
    });
    const external = await ensureChannelWithRoot(db, {
      memoryId: externalMemory.id,
      loc: 'chats:external',
      name: 'external',
      createdBy: user.id,
    });
    await db.registerEntry.create({
      data: { id: generateId(), appId: app.id, channelId: external.channel.id, attendeeWorkerId: worker.id, role: 'BOTH' },
    });
    const enc = await getMemoryEncryptionInfo(db, externalMemory.id);
    await appendChatMessage(
      db,
      { id: external.rootId, memoryId: externalMemory.id, loc: 'chats:external' },
      enc,
      async ({ tx, seq, msgNum }) => tx.node.create({
        data: {
          id: generateId(),
          memoryId: externalMemory.id,
          loc: `chats:external:messages:${msgNum}`,
          name: msgNum,
          nodeType: 'chat-message',
          seq,
          content: 'registered outside the pilot App',
        },
      }),
      { asChannel: true },
    );

    await Q.channelMessages(
      {},
      { channelRef: external.channel.id, sinceSeq: 0, beforeSeq: null, mentionsRef: null, limit: 50, offset: 0 },
      userCtx({ sessionId }),
    );
    expect(await db.channelReadState.findFirst({ where: { workerId: worker.id, channelId: external.channel.id } })).toMatchObject({ lastSeenSeq: 1 });
  });
});

// #3082: this block drove the MCP tools hadron_team_chat_read / hadron_channel_read / hadron_team_chat_mark_read, which are disabled
// on MCP. The same rules are pinned here on the resolvers those tools delegated to (teamChatMessages, channelMessages,
// markOwnTeamChatRead), with the Worker session presented as the request's session (ctx.sessionId), as the transport did.
// Removed without a replacement: 'a blank explicit session is no session' (the MCP wrapper's argument trimming of a disabled
// tool; a resolver never sees a blank session) and the two hadron_server_info capability tests ('stops advertising the
// capability...', 'lists the tools for any user principal...'): no team capability is advertised any more, pinned by
// the 'no team capability is advertised' test in src/mcp/server.mcpTeamCut3082.test.ts.
describe('worker session reads and mark-read (resolver level; was the MCP parity block)', () => {
  const asSession = (sid: string) => userCtx({ sessionId: sid });

  it('an explicit-session team-chat read advances the Channel it read, not a newer App default (#1362 review)', async () => {
    // `channel` is the App's OLDEST team-space root, which is what the
    // convenience read serves. Make a newer team-space root the App default.
    const other = await db.memory.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:pilot-other`, name: 'other', class: 'app', appId: app.id },
    });
    const newer = await ensureChannelWithRoot(db, { memoryId: other.id, loc: 'chats:team', name: 'team', createdBy: user.id });
    await db.app.update({ where: { id: app.id }, data: { defaultChannelId: newer.channel.id } });
    await db.registerEntry.create({
      data: { id: generateId(), appId: app.id, channelId: newer.channel.id, attendeeWorkerId: worker.id, role: 'BOTH' },
    });
    await db.channel.update({ where: { id: newer.channel.id }, data: { lastSeq: 7 } });
    await post('one');
    await post('two');

    const read = await Q.teamChatMessages({}, { appRef: app.id, sinceSeq: 0 }, asSession(sessionId));
    expect(read.items.map((m: any) => m.body)).toContain('two');
    expect(await db.channelReadState.findFirst({ where: { workerId: worker.id, channelId: channel.id } }))
      .toMatchObject({ lastSeenSeq: 2 });
    expect(await db.channelReadState.findFirst({ where: { workerId: worker.id, channelId: newer.channel.id } })).toBeNull();
  });

  it('the Channel the convenience read serves (not a newer App default) is the one a mark-read must name (#1362 review)', async () => {
    const other = await db.memory.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:pilot-other2`, name: 'other2', class: 'app', appId: app.id },
    });
    const newer = await ensureChannelWithRoot(db, { memoryId: other.id, loc: 'chats:team', name: 'team', createdBy: user.id });
    await db.app.update({ where: { id: app.id }, data: { defaultChannelId: newer.channel.id } });
    await db.registerEntry.create({
      data: { id: generateId(), appId: app.id, channelId: newer.channel.id, attendeeWorkerId: worker.id, role: 'BOTH' },
    });
    await db.channel.update({ where: { id: newer.channel.id }, data: { lastSeq: 7 } });
    await post('one');
    await post('two');

    // The MCP tool resolved an omitted channel this way; the resolver takes the name, and the located channel is the oldest root.
    const served = await locateTeamChatChannel(userCtx(), app.id);
    expect(served?.channelId).toBe(channel.id);
    const out = await M.markOwnTeamChatRead({}, { appRef: app.id, sessionRef: sessionId, channelRef: served!.channelId, seq: 2 }, userCtx());
    expect(out).toMatchObject({ channelId: channel.id, lastSeenSeq: 2 });
    expect(await db.channelReadState.findFirst({ where: { workerId: worker.id, channelId: channel.id } }))
      .toMatchObject({ lastSeenSeq: 2 });
    expect(await db.channelReadState.findFirst({ where: { workerId: worker.id, channelId: newer.channel.id } })).toBeNull();
  });

  it('a monitor read never advances the Worker cursor, even with the session bound to the request (#1362 review)', async () => {
    await post('first');
    await post('second');
    // The monitor read is advanceReadState:false: only an explicit acknowledge moves the cursor.
    const monitored = await Q.teamChatMessages({}, { appRef: app.id, advanceReadState: false }, asSession(sessionId));
    expect(monitored.items.map((m: any) => m.body)).toContain('second');
    expect(await seenSeq(worker.id, channel.id)).toBe(0); // #2138: a read may stamp lastCheckedAt, but moves no read position

    // Control: an ordinary read on the same session does advance it.
    await Q.teamChatMessages({}, { appRef: app.id, sinceSeq: 0 }, asSession(sessionId));
    expect(await db.channelReadState.findFirst({ where: { workerId: worker.id, channelId: channel.id } }))
      .toMatchObject({ lastSeenSeq: 2 });
  });

  it('ordinary reads own the cursor and the explicit mark-read door covers filtered reads', async () => {
    await post('@dara first', { mentions: ['dara'] });
    await post('second');

    await Q.teamChatMessages({}, { appRef: app.id, mentionsRef: worker.id }, asSession(sessionId));
    expect(await seenSeq(worker.id, channel.id)).toBe(0); // #2138: a read may stamp lastCheckedAt, but moves no read position

    const marked = await M.markOwnTeamChatRead({}, { appRef: app.id, sessionRef: sessionId, channelRef: channel.id, seq: 1 }, userCtx());
    expect(marked).toMatchObject({ lastSeenSeq: 1 });

    await expect(M.markOwnTeamChatRead({}, { appRef: app.id, sessionRef: sessionId, channelRef: '   ', seq: 2 }, userCtx()))
      .rejects.toMatchObject({ extensions: { code: 'CHANNEL_NOT_FOUND' } });
    expect(await db.channelReadState.findFirst({ where: { workerId: worker.id, channelId: channel.id } })).toMatchObject({ lastSeenSeq: 1 });

    const markedDefault = await M.markOwnTeamChatRead({}, { appRef: app.id, sessionRef: sessionId, channelRef: channel.id, seq: 2 }, userCtx());
    expect(markedDefault).toMatchObject({ channelId: channel.id, lastSeenSeq: 2 });

    await Q.teamChatMessages({}, { appRef: app.id, sinceSeq: 1 }, asSession(sessionId));
    expect(await db.channelReadState.findFirst({ where: { workerId: worker.id, channelId: channel.id } })).toMatchObject({ lastSeenSeq: 2 });
  });

  it('exposes the same pilot-gated, session-pinned mark-read door through GraphQL', async () => {
    await post('one');
    await post('two');
    const marked = await M.markOwnTeamChatRead(
      {},
      { appRef: app.urn, sessionRef: sessionId, channelRef: channel.id, seq: 1 },
      userCtx(),
    );
    expect(marked).toEqual({ workerId: worker.id, channelId: channel.id, lastSeenSeq: 1, channelIncarnation: 1, cursorIncarnation: 1 });

    await expect(M.markOwnTeamChatRead(
      {},
      { appRef: app.id, sessionRef: sessionId, channelRef: channel.id, seq: 3 },
      userCtx(),
    )).rejects.toMatchObject({ extensions: { code: 'SEQ_BEYOND_WATERMARK', lastSeq: 2 } });

    // #1353: no allowlist — the boundary is own-session. Another user's
    // context cannot mark this session's cursor (SESSION_NOT_LIVE).
    await expect(M.markOwnTeamChatRead(
      {},
      { appRef: app.id, sessionRef: sessionId, channelRef: channel.id, seq: 2 },
      { db, userId: otherUser.id, roles: ['READER'] } as Context,
    )).rejects.toMatchObject({ extensions: { code: 'SESSION_NOT_LIVE' } });
  });

  it('a read presenting one Worker session advances only that Worker, not another Worker of the App', async () => {
    const iris = await addWorker('Iris');
    await post('one message for both');

    await Q.channelMessages({}, { channelRef: channel.id, sinceSeq: 0 }, asSession(iris.sessionId));
    expect(await seenSeq(worker.id, channel.id)).toBe(0); // #2138: a read may stamp lastCheckedAt, but moves no read position
    expect(await db.channelReadState.findFirst({ where: { workerId: iris.id, channelId: channel.id } })).toMatchObject({ lastSeenSeq: 1 });

    await db.channelReadState.deleteMany();
    await Q.teamChatMessages({}, { appRef: app.id, sinceSeq: 0 }, asSession(iris.sessionId));
    expect(await seenSeq(worker.id, channel.id)).toBe(0); // #2138: a read may stamp lastCheckedAt, but moves no read position
    expect(await db.channelReadState.findFirst({ where: { workerId: iris.id, channelId: channel.id } })).toMatchObject({ lastSeenSeq: 1 });
  });

  it('does not advance a former Worker after its user loses App participation', async () => {
    const independentMemory = await db.memory.create({
      data: {
        id: generateId(), organizationId: org.id, urn: `${org.urn}:independent`,
        name: 'independent', class: 'knowledge', visibility: 'ORGANIZATION',
      },
    });
    const made = await ensureChannelWithRoot(db, {
      memoryId: independentMemory.id, loc: 'chats:independent', name: 'independent', createdBy: user.id,
    });
    const independent = made.channel;
    await db.registerEntry.create({
      data: { id: generateId(), appId: app.id, channelId: independent.id, attendeeWorkerId: worker.id, role: 'WATCH' },
    });
    const enc = await getMemoryEncryptionInfo(db, independentMemory.id);
    await appendChatMessage(
      db,
      { id: made.rootId, memoryId: independentMemory.id, loc: 'chats:independent' },
      enc,
      async ({ tx, seq, msgNum }) => tx.node.create({
        data: {
          id: generateId(), memoryId: independentMemory.id,
          loc: `chats:independent:messages:${msgNum}`, name: msgNum,
          nodeType: 'chat-message', seq, content: 'still readable',
        },
      }),
      { asChannel: true },
    );

    await db.appMember.delete({ where: { appId_userId: { appId: app.id, userId: user.id } } });
    await db.orgMember.updateMany({
      where: { organizationId: org.id, userId: user.id }, data: { role: 'READER' },
    });
    const read = await Q.channelMessages({}, { channelRef: independent.id, sinceSeq: 0 }, asSession(sessionId));
    expect(read.items.map((m: any) => m.body)).toContain('still readable');
    expect(await db.channelReadState.findFirst({ where: { workerId: worker.id, channelId: independent.id } }))
      .toBeNull();
  });

  it('does not advance a Worker whose App belongs to a soft-deleted org', async () => {
    const independentMemory = await db.memory.create({
      data: {
        id: generateId(), organizationId: org.id, urn: `${org.urn}:independent`,
        name: 'independent', class: 'knowledge', visibility: 'ORGANIZATION',
      },
    });
    const made = await ensureChannelWithRoot(db, {
      memoryId: independentMemory.id, loc: 'chats:independent', name: 'independent', createdBy: user.id,
    });
    const independent = made.channel;
    await db.registerEntry.create({
      data: { id: generateId(), appId: app.id, channelId: independent.id, attendeeWorkerId: worker.id, role: 'WATCH' },
    });
    const enc = await getMemoryEncryptionInfo(db, independentMemory.id);
    await appendChatMessage(
      db,
      { id: made.rootId, memoryId: independentMemory.id, loc: 'chats:independent' },
      enc,
      async ({ tx, seq, msgNum }) => tx.node.create({
        data: {
          id: generateId(), memoryId: independentMemory.id,
          loc: `chats:independent:messages:${msgNum}`, name: msgNum,
          nodeType: 'chat-message', seq, content: 'still readable',
        },
      }),
      { asChannel: true },
    );

    // Soft delete stamps the org only: the App row and every membership stay.
    await db.organization.update({ where: { id: org.id }, data: { deletedAt: new Date() } });
    await expect(Q.channelMessages({}, { channelRef: independent.id, sinceSeq: 0 }, asSession(sessionId)))
      .rejects.toMatchObject({ extensions: { code: 'CHANNEL_NOT_FOUND' } });
    expect(await db.channelReadState.findFirst({ where: { workerId: worker.id, channelId: independent.id } }))
      .toBeNull();
    // The pilot door (the explicit mark, since #2027 S11 retired the poll) answers
    // a deleted org's App exactly like an absent one.
    const error = await M.markOwnTeamChatRead({}, { appRef: app.id, sessionRef: sessionId, channelRef: channel.id, seq: 1 }, userCtx()).catch((e: unknown) => e);
    expect(error).toMatchObject({ message: 'App not found.', extensions: { code: 'APP_NOT_FOUND' } });
  });

  it('refuses markOwnTeamChatRead while impersonating even within the App organization (#4507)', async () => {
    await db.worker.update({ where: { id: worker.id }, data: { heldByUserId: user.id, heldAt: new Date() } });
    // Both actor and subject are org ADMIN; the subject is an App admin and holds the worker. This exercises resolvePilotApp's impersonation guard.
    expect(await db.orgMember.findFirst({ where: { organizationId: org.id, userId: otherUser.id }, select: { role: true } })).toEqual({ role: 'ADMIN' });
    expect(await db.orgMember.findFirst({ where: { organizationId: org.id, userId: user.id }, select: { role: true } })).toEqual({ role: 'ADMIN' });
    expect(await db.appMember.findFirst({ where: { appId: app.id, userId: user.id }, select: { role: true } })).toEqual({ role: 'admin' });
    expect(await db.worker.findUnique({ where: { id: worker.id }, select: { heldByUserId: true } })).toEqual({ heldByUserId: user.id });
    await post('unread');
    const args = { appRef: app.id, sessionRef: sessionId, channelRef: channel.id, seq: 1 };
    const impersonationSessionId = '00000000000000000000000000004507';
    const impersonation = { orgId: org.id, actorUserId: otherUser.id, sessionId: impersonationSessionId, expiresAt: new Date(Date.now() + 60_000) };
    // Pin the specific resolvePilotApp guard as well as the observable refusal below.
    const source = readFileSync(new URL('./teamAttention.ts', import.meta.url), 'utf8');
    const pilotGuard = source.slice(source.indexOf('async function resolvePilotApp('), source.indexOf('let id:', source.indexOf('async function resolvePilotApp(')));
    expect(pilotGuard).toMatch(/if\s*\(\s*!ctx\.userId\s*\|\|\s*ctx\.impersonation\s*\)\s*fail\([^\n]*'FORBIDDEN'/);
    await expect(M.markOwnTeamChatRead({}, args, userCtx({ impersonation })))
      .rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    expect(await db.channelReadState.findFirst({ where: { workerId: worker.id, channelId: channel.id } })).toBeNull();
    await expect(M.markOwnTeamChatRead({}, args, userCtx())).resolves.toBeDefined();
    expect(await seenSeq(worker.id, channel.id)).toBe(1);
  });

  it('conceals an existing App from a non-participant exactly like an absent App (the pilot door)', async () => {
    // The concealment half resolvePilotApp still owes its pin after S11 retired
    // the poll that used to carry it: a LIVE App the caller is no participant of
    // (here: another org's App, so neither the AppMember nor the org arm admits
    // them) and a nonexistent one must be indistinguishable on the mark path too.
    const strangerOrgId = generateId();
    const strangerOrg = await db.organization.create({
      data: { id: strangerOrgId, name: 'stranger', urn: `stranger-${strangerOrgId}.com` },
    });
    const stranger = await db.app.create({
      data: { id: generateId(), organizationId: strangerOrg.id, name: 'Stranger', urn: `${strangerOrg.urn}:stranger` },
    });
    const mark = (appRef: string) =>
      M.markOwnTeamChatRead({}, { appRef, sessionRef: sessionId, channelRef: channel.id, seq: 1 }, userCtx()).catch((e: unknown) => e);
    const [existingError, absentError] = await Promise.all([mark(stranger.id), mark(generateId())]);
    expect(existingError).toMatchObject({ message: 'App not found.', extensions: { code: 'APP_NOT_FOUND' } });
    expect(absentError).toMatchObject({ message: 'App not found.', extensions: { code: 'APP_NOT_FOUND' } });
    expect(String(existingError)).toBe(String(absentError));
  });

  it('a convenience read of a registered cross-App team Channel uses the Worker session pilot', async () => {
    await db.appAgent.create({ data: { appId: otherApp.id, agentId: agent.id } });
    await db.appMember.create({ data: { appId: otherApp.id, userId: user.id, role: 'admin' } });
    const otherMemory = await db.memory.create({
      data: {
        id: generateId(), organizationId: org.id, urn: `${org.urn}:other-shared`,
        name: 'other-shared', class: 'app', appId: otherApp.id, sharedMemoryOfAgentId: agent.id,
      },
    });
    const made = await ensureChannelWithRoot(db, {
      memoryId: otherMemory.id, loc: 'chats:team', name: 'other team',
      createdBy: user.id, asDefaultOfAppId: otherApp.id,
    });
    await db.registerEntry.create({
      data: { id: generateId(), appId: app.id, channelId: made.channel.id, attendeeWorkerId: worker.id, role: 'WATCH' },
    });
    const enc = await getMemoryEncryptionInfo(db, otherMemory.id);
    await appendChatMessage(
      db,
      { id: made.rootId, memoryId: otherMemory.id, loc: 'chats:team' },
      enc,
      async ({ tx, seq, msgNum }) => tx.node.create({
        data: {
          id: generateId(), memoryId: otherMemory.id,
          loc: `chats:team:messages:${msgNum}`, name: msgNum,
          nodeType: 'chat-message', seq, content: 'cross-App team message',
        },
      }),
      { asChannel: true },
    );

    const page = await Q.teamChatMessages({}, { appRef: otherApp.id, sinceSeq: 0 }, userCtx({ sessionId }));
    expect(page.total).toBe(1);
    expect(await db.channelReadState.findFirst({ where: { workerId: worker.id, channelId: made.channel.id } }))
      .toMatchObject({ lastSeenSeq: 1 });
  });

  it('returns successful transcripts when the best-effort cursor write fails', async () => {
    await post('the transcript survives');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const queryRaw = vi.spyOn(db, '$queryRaw').mockRejectedValue(new Error('cursor store unavailable'));
    try {
      const channelRead = await Q.channelMessages({}, { channelRef: channel.id, sinceSeq: 0 }, asSession(sessionId));
      expect(channelRead.items.map((m: any) => m.body)).toContain('the transcript survives');

      const teamRead = await Q.teamChatMessages({}, { appRef: app.id, sinceSeq: 0 }, asSession(sessionId));
      expect(teamRead.items.map((m: any) => m.body)).toContain('the transcript survives');
      expect(await seenSeq(worker.id, channel.id)).toBe(0); // #2138: a read may stamp lastCheckedAt, but moves no read position
      // Footer omission diagnostics may also warn; pin the two cursor failures
      // this test induces without coupling to independent best-effort features.
      const cursorWarnings = warn.mock.calls.filter(([message]) =>
        message === '[channelMessages] pilot read-state advance failed:' ||
        message === '[teamChatMessages] pilot read-state advance failed:',
      );
      expect(cursorWarnings.map(([message]) => message)).toEqual([
        '[channelMessages] pilot read-state advance failed:',
        '[teamChatMessages] pilot read-state advance failed:',
      ]);
    } finally {
      queryRaw.mockRestore();
      warn.mockRestore();
    }
  });
});

describe('#1540 — a mark-read through a live session keeps it live', () => {
  const H = 60 * 60 * 1000;
  afterEach(() => vi.useRealTimers());

  it.each([false, true])('#1628 an empty read keeps an eligible session live with advancement %s', async (advanceReadState) => {
    const t0 = (await db.session.findUniqueOrThrow({ where: { id: sessionId } })).startedAt;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(t0.getTime() + 20 * H));
    const page = await Q.teamChatMessages({}, { appRef: app.id, sinceSeq: 0, advanceReadState }, userCtx({ sessionId }));
    expect(page.items).toEqual([]);
    expect((await db.session.findUniqueOrThrow({ where: { id: sessionId } })).updatedAt!.getTime())
      .toBe(t0.getTime() + 20 * H);
    expect(await seenSeq(worker.id, channel.id)).toBe(0); // #2138: a read may stamp lastCheckedAt, but moves no read position
    await post('later message');
    vi.setSystemTime(new Date(t0.getTime() + 30 * H));
    await expect(M.markOwnTeamChatRead({}, { appRef: app.id, channelRef: channel.id, sessionRef: sessionId, seq: 1 }, userCtx()))
      .resolves.toMatchObject({ lastSeenSeq: 1 });
  });

  it('marking read inside the window keeps the session live past startedAt + window', async () => {
    const t0 = (await db.session.findUniqueOrThrow({ where: { id: sessionId } })).startedAt;
    await post('one');
    await post('two');
    // Only Date is faked: the server's own clock moves, Prisma's timers do not.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(t0.getTime() + 20 * H));
    await M.markOwnTeamChatRead({}, { appRef: app.urn, sessionRef: sessionId, channelRef: channel.id, seq: 1 }, userCtx());
    vi.setSystemTime(new Date(t0.getTime() + 30 * H));
    await expect(M.markOwnTeamChatRead({}, { appRef: app.urn, sessionRef: sessionId, channelRef: channel.id, seq: 2 }, userCtx()))
      .resolves.toMatchObject({ lastSeenSeq: 2 });
  });

  it('a read that does not advance the cursor (newest page, mention filter) still keeps the session live (Codex P1)', async () => {
    const t0 = (await db.session.findUniqueOrThrow({ where: { id: sessionId } })).startedAt;
    await post('one');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(t0.getTime() + 20 * H));
    // The newest-page default and a mentions filter both return before any cursor advance.
    await Q.teamChatMessages({}, { appRef: app.urn }, userCtx({ sessionId }));
    await Q.teamChatMessages({}, { appRef: app.urn, sinceSeq: 0, mentionsRef: worker.name }, userCtx({ sessionId }));
    vi.setSystemTime(new Date(t0.getTime() + 30 * H));
    await expect(M.markOwnTeamChatRead({}, { appRef: app.urn, sessionRef: sessionId, channelRef: channel.id, seq: 1 }, userCtx()))
      .resolves.toMatchObject({ lastSeenSeq: 1 });
  });

  it('#1617 B: the name-holder\'s mark-read RESUMES a lapsed session, and the routing set still carries the worker', async () => {
    await db.worker.update({ where: { id: worker.id }, data: { heldByUserId: user.id, heldAt: new Date() } });
    const t0 = (await db.session.findUniqueOrThrow({ where: { id: sessionId } })).startedAt;
    await post('@dara while you were away', { mentions: ['dara'] });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(t0.getTime() + 30 * H));
    // Lapsed, but resumable: the routing set still carries the worker, and
    // observing it resumes nothing.
    expect([...(await resumableOwnWorkerIds(userCtx(), { userId: user.id, appId: app.id, now: new Date() }))]).toEqual([worker.id]);
    expect((await db.session.findUniqueOrThrow({ where: { id: sessionId } })).updatedAt!.getTime()).toBeLessThan(Date.now() - 24 * H);
    // The worker's own mark-read is the act that resumes it.
    await expect(M.markOwnTeamChatRead({}, { appRef: app.urn, sessionRef: sessionId, channelRef: channel.id, seq: 1 }, userCtx()))
      .resolves.toMatchObject({ lastSeenSeq: 1 });
    expect((await db.session.findUniqueOrThrow({ where: { id: sessionId } })).updatedAt!.getTime()).toBe(Date.now());
  });

  it('control: a session nobody drove for a whole window still cannot mark read', async () => {
    const t0 = (await db.session.findUniqueOrThrow({ where: { id: sessionId } })).startedAt;
    await post('one');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(t0.getTime() + 30 * H));
    await expect(M.markOwnTeamChatRead({}, { appRef: app.urn, sessionRef: sessionId, channelRef: channel.id, seq: 1 }, userCtx()))
      .rejects.toMatchObject({ extensions: { code: 'SESSION_NOT_LIVE' } });
  });
});

describe('#2138 §3.1 — channel checks: lastCheckedAt', () => {
  const checkedAt = async (workerId: string, channelId: string) =>
    (await db.channelReadState.findFirst({ where: { workerId, channelId } }))?.lastCheckedAt ?? null;

  it('an EMPTY read of the team channel through the worker\'s own session is a check, and moves no position', async () => {
    expect(await checkedAt(worker.id, channel.id)).toBeNull();
    const page = await Q.teamChatMessages({}, { appRef: app.id, sinceSeq: 0 }, userCtx({ sessionId }));
    expect(page.items).toEqual([]);
    expect(await checkedAt(worker.id, channel.id)).toBeInstanceOf(Date);
    expect(await seenSeq(worker.id, channel.id)).toBe(0);
  });

  it('a read that defers its acknowledgement (advanceReadState:false) and a filtered mentions read both check', async () => {
    await post('one');
    await Q.teamChatMessages({}, { appRef: app.id, sinceSeq: 0, advanceReadState: false }, userCtx({ sessionId }));
    const first = await checkedAt(worker.id, channel.id);
    expect(first).toBeInstanceOf(Date);
    await db.channelReadState.updateMany({ where: { workerId: worker.id }, data: { lastCheckedAt: new Date('2026-01-01T00:00:00Z') } });
    await Q.teamChatMessages({}, { appRef: app.id, sinceSeq: 0, mentionsRef: worker.id }, userCtx({ sessionId }));
    expect((await checkedAt(worker.id, channel.id))!.getTime()).toBeGreaterThan(new Date('2026-01-01T00:00:00Z').getTime());
  });

  it('a bare mark-read (nothing new) is a check; a refused mark-read (beyond the watermark) is not', async () => {
    await expect(M.markOwnTeamChatRead({}, { appRef: app.id, channelRef: channel.id, sessionRef: sessionId, seq: 99 }, userCtx())).rejects.toThrow();
    expect(await checkedAt(worker.id, channel.id)).toBeNull();
    await M.markOwnTeamChatRead({}, { appRef: app.id, channelRef: channel.id, sessionRef: sessionId, seq: 0 }, userCtx());
    expect(await checkedAt(worker.id, channel.id)).toBeInstanceOf(Date);
  });

  it('a read by a person (no worker session) checks nothing', async () => {
    await Q.teamChatMessages({}, { appRef: app.id, sinceSeq: 0 }, userCtx());
    expect(await db.channelReadState.count({ where: { lastCheckedAt: { not: null } } })).toBe(0);
  });

  it("another worker's read stamps only that worker", async () => {
    const iris = await addWorker('Iris');
    await Q.teamChatMessages({}, { appRef: app.id, sinceSeq: 0 }, userCtx({ sessionId: iris.sessionId }));
    expect(await checkedAt(iris.id, channel.id)).toBeInstanceOf(Date);
    expect(await checkedAt(worker.id, channel.id)).toBeNull();
  });

  it('a read of another channel does not count', async () => {
    const other = await ensureChannelWithRoot(db, { memoryId: memory.id, loc: 'chats:ops', name: 'ops', createdBy: user.id });
    await db.registerEntry.create({ data: { id: generateId(), appId: app.id, channelId: other.channel.id, attendeeWorkerId: worker.id, role: 'BOTH' } });
    await M.markOwnTeamChatRead({}, { appRef: app.id, channelRef: other.channel.id, sessionRef: sessionId, seq: 0 }, userCtx());
    expect(await checkedAt(worker.id, other.channel.id)).toBeNull();
    expect(await checkedAt(worker.id, channel.id)).toBeNull();
  });

  it('#2013: a stamped @all post appears in the worker\'s own mentions read (the mentions-from-mark read)', async () => {
    const iris = await addWorker('Iris');
    await post('everyone: standup moved', { authorWorkerId: iris.id, mentions: ['all'], broadcastWakes: true });
    await post('plain chatter, no tag');
    const page = await Q.teamChatMessages({}, { appRef: app.id, sinceSeq: 0, mentionsRef: worker.id }, userCtx({ sessionId }));
    expect(page.items.map((m: { seq: number }) => m.seq)).toEqual([1]);
  });

  describe('channel.check.miss (log-only diagnostics)', () => {
    const misses = () => db.appLogEntry.findMany({ where: { message: 'channel.check.miss' }, orderBy: { createdAt: 'asc' } });

    it('a counted check logs nothing', async () => {
      await Q.teamChatMessages({}, { appRef: app.id, sinceSeq: 0 }, userCtx({ sessionId }));
      expect(await checkedAt(worker.id, channel.id)).toBeInstanceOf(Date);
      expect(await misses()).toEqual([]);
    });

    it('a request that NAMED a session the server refused logs BINDING_REFUSED (reason and route only) and changes nothing else', async () => {
      await post('one');
      const page = await Q.teamChatMessages({}, { appRef: app.id, sinceSeq: 0 }, userCtx({ sessionBindingRefused: true }));
      expect(page.items.map((m: { seq: number }) => m.seq)).toEqual([1]);
      expect(await checkedAt(worker.id, channel.id)).toBeNull();
      const logs = await misses();
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({ appId: app.id, level: 'WARN', sessionId: null, detail: { reason: 'BINDING_REFUSED', via: 'read' } });
      expect(Object.keys(logs[0].detail as object).sort()).toEqual(['reason', 'via']); // no worker, channel or content
    });

    it('a session that is not the caller\'s own live worker session logs SESSION_NOT_OWN_LIVE, carrying that session id', async () => {
      await db.session.update({ where: { id: sessionId }, data: { endedAt: new Date() } });
      await Q.teamChatMessages({}, { appRef: app.id, sinceSeq: 0 }, userCtx({ sessionId }));
      expect(await checkedAt(worker.id, channel.id)).toBeNull();
      const logs = await misses();
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({ sessionId, detail: { reason: 'SESSION_NOT_OWN_LIVE', via: 'read' } });
    });

    it("a worker of another App reading this App's team channel logs CROSS_APP and stamps nothing", async () => {
      const foreign = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: otherApp.id, agentId: agent.id, name: 'Foreign', slug: 'foreign' } });
      await db.registerEntry.create({ data: { id: generateId(), appId: otherApp.id, channelId: channel.id, attendeeWorkerId: foreign.id, role: 'BOTH' } });
      const foreignSession = await db.session.create({ data: { id: generateId(), appId: otherApp.id, userId: user.id, workerId: foreign.id, agentId: agent.id, type: 'DEVELOPER', startedAt: new Date() } });
      await Q.channelMessages({}, { channelRef: channel.id, sinceSeq: 0, beforeSeq: null, mentionsRef: null, limit: 20, offset: 0 }, userCtx({ sessionId: foreignSession.id }));
      expect(await checkedAt(foreign.id, channel.id)).toBeNull();
      const logs = await misses();
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({ sessionId: foreignSession.id, detail: { reason: 'CROSS_APP', via: 'read' } });
    });

    it('a dead session reading an ordinary (non-team) channel logs nothing either: only the team channel can miss', async () => {
      const other = await ensureChannelWithRoot(db, { memoryId: memory.id, loc: 'chats:ops2', name: 'ops2', createdBy: user.id });
      await db.registerEntry.create({ data: { id: generateId(), appId: app.id, channelId: other.channel.id, attendeeWorkerId: worker.id, role: 'BOTH' } });
      await db.session.update({ where: { id: sessionId }, data: { endedAt: new Date() } });
      await Q.channelMessages({}, { channelRef: other.channel.id, sinceSeq: 0, beforeSeq: null, mentionsRef: null, limit: 20, offset: 0 }, userCtx({ sessionId }));
      expect(await misses()).toEqual([]);
    });

    it('a read of an ordinary (non-team) channel logs nothing even though it stamps nothing', async () => {
      const other = await ensureChannelWithRoot(db, { memoryId: memory.id, loc: 'chats:ops', name: 'ops', createdBy: user.id });
      await db.registerEntry.create({ data: { id: generateId(), appId: app.id, channelId: other.channel.id, attendeeWorkerId: worker.id, role: 'BOTH' } });
      await Q.channelMessages({}, { channelRef: other.channel.id, sinceSeq: 0, beforeSeq: null, mentionsRef: null, limit: 20, offset: 0 }, userCtx({ sessionId }));
      expect(await misses()).toEqual([]);
    });
  });
});
