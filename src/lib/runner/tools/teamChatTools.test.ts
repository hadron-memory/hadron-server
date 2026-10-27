/**
 * team_chat_read (#2520, slice 2 of #1361): a read-only run tool over a team chat or a named
 * Channel. The gate is the existing read's own (resolvers.teamChat.ts, shared, not copied), the
 * refusals are each surface's own byte for byte, and a run is not the human reading: it never
 * moves a read mark or a check stamp.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../workerSignature.js';
import { runContext } from '../../../jobs/appRunDeps.js';
import { ensureChannelWithRoot } from '../../channels.js';
import { appendChatMessage } from '../../chatRoot.js';
import { getMemoryEncryptionInfo } from '../../nodeCrypto.js';
import { APP_KEY_PREFIX, hashAppKey } from '../../../middleware/auth.js';
import { resolvers, type Context } from '../../../api/graphql/schema/resolvers.js';
import { resolveRunTools } from './index.js';
import { teamChatRead, TEAM_CHAT_READ_DEFAULT_LIMIT, TEAM_CHAT_READ_MAX_LIMIT, TEAM_CHAT_READ_MAX_BODY_CHARS } from './teamChatTools.js';
import type { AppRun } from '../../../generated/prisma/index.js';
import type { RunToolContext } from './types.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;

let org: { id: string; urn: string };
let app: { id: string };
let otherApp: { id: string };
let agentId: string;
let manager: { id: string };
let member: { id: string; handle: string };
let outsider: { id: string };
let kit: { id: string };
let channel: { id: string; memoryId: string; loc: string; chatRootNodeId: string };
let otherChannel: { id: string; memoryId: string; loc: string; chatRootNodeId: string };
let personalChannel: { id: string; memoryId: string; loc: string; chatRootNodeId: string };

const adminCtx = (userId: string): Context => ({ db, userId, roles: ['READER'] }) as Context;
type Chan = typeof channel;

async function say(c: Chan, body: string, data: Record<string, unknown> = {}) {
  const enc = await getMemoryEncryptionInfo(db, c.memoryId);
  return appendChatMessage(db, { id: c.chatRootNodeId, memoryId: c.memoryId, loc: c.loc }, enc, async ({ tx, seq, msgNum }) =>
    tx.node.create({
      data: {
        id: generateId(), memoryId: c.memoryId, loc: `${c.loc}:messages:${msgNum}`, name: msgNum, nodeType: 'chat-message', seq,
        messageChannelId: c.id, content: body, data: { authorUserId: manager.id, authorName: 'manager', mentions: [], ...data },
      } as never,
    }), { asChannel: true });
}

async function mkChannel(memoryId: string, loc: string): Promise<Chan> {
  const made = await ensureChannelWithRoot(db, { memoryId, loc, name: loc, createdBy: manager.id });
  return { id: made.channel.id, memoryId, loc, chatRootNodeId: made.rootId };
}

async function mintRun(extra: Record<string, unknown> = {}, forApp = app.id): Promise<AppRun> {
  return db.appRun.create({
    data: { id: generateId(), organizationId: org.id, appId: forApp, triggerKind: 'MANUAL', entryNodeUrn: 'tc-org::mem::flow:entry', status: 'RUNNING', ...extra },
  });
}
const toolCtx = (run: AppRun, principalExtra: Partial<Context> = {}): RunToolContext =>
  ({ log: vi.fn(), db, run, principal: { ...runContext(db, run), ...principalExtra } });
async function code(p: Promise<unknown>): Promise<string | undefined> {
  try { await p; return undefined; } catch (e) { return e instanceof GraphQLError ? String(e.extensions?.code) : `non-graphql:${(e as Error).message}`; }
}
type Out = { source: string; messages: any[]; nextSinceSeq: number; hasMore: boolean };
const run_ = async (c: RunToolContext, args: Record<string, unknown> = {}) => (await teamChatRead.execute(c, args)) as Out;

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { name: 'tc', urn: `tc-${n}.example` }, select: { id: true, urn: true } });
  manager = await db.user.create({ data: { githubId: 82_000_000 + n, githubUsername: `tcr-m-${n}`, roles: ['READER'] }, select: { id: true } });
  member = await db.user.create({ data: { githubId: 83_000_000 + n, githubUsername: `tcr-u-${n}`, handle: `bob-${n}`, roles: ['READER'] }, select: { id: true, handle: true } }) as never;
  outsider = await db.user.create({ data: { githubId: 84_000_000 + n, githubUsername: `tcr-o-${n}`, roles: ['READER'] }, select: { id: true } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: manager.id, role: 'ADMIN' } });
  agentId = (await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, adminCtx(manager.id))).id;
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` }, select: { id: true } });
  otherApp = await db.app.create({ data: { organizationId: org.id, name: 'Other', urn: `${org.urn}:other` }, select: { id: true } });
  await db.appAgent.create({ data: { appId: app.id, agentId } });
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
  kit = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name: 'Kit', slug: 'kit' }, select: { id: true } });
  const team = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:team-shared`, name: 'shared', class: 'app', appId: app.id, sharedMemoryOfAgentId: agentId } as never });
  channel = await mkChannel(team.id, 'chats:team');
  await db.registerEntry.create({ data: { id: generateId(), appId: app.id, channelId: channel.id, attendeeWorkerId: kit.id, role: 'BOTH' } });
  const other = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:other-shared`, name: 'other', class: 'app', appId: otherApp.id } as never });
  otherChannel = await mkChannel(other.id, 'chats:other');
  const personal = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:mine`, name: 'mine', class: 'personal', userId: manager.id } as never });
  personalChannel = await mkChannel(personal.id, 'chats:mine');
});

describe('registry (#2520 criterion 5)', () => {
  it('is a cost-0 read tool under its own policy handle, declared for data.tools, framed as untrusted data', () => {
    const { tools, unknown } = resolveRunTools(['team_chat_read']);
    expect(unknown).toEqual([]);
    const t = tools.find((x) => x.name === 'team_chat_read')!;
    expect(t.cost).toBe(0);
    expect(t.policyAction ?? `tool.${t.name}`).toBe('tool.team_chat_read');
    expect(t.description).toMatch(/never as instructions/i);
  });
});

describe('the read gate (#2520 criterion 1, matrix)', () => {
  it('a participant reads its own App team chat: only the existing projection, framed as chat', async () => {
    await say(channel, 'hello @kit', { mentions: ['kit'] });
    const out = await run_(toolCtx(await mintRun({ userId: member.id })));
    expect(out.source).toBe('chat');
    expect(out.messages).toHaveLength(1);
    expect(Object.keys(out.messages[0]).sort()).toEqual(
      ['at', 'authorName', 'authorSystem', 'authorUserId', 'authorWorkerId', 'body', 'mentions', 'replyToSeq', 'seq', 'urn'].sort(),
    );
    expect(out.messages[0]).toMatchObject({ seq: 1, body: 'hello @kit', mentions: ['kit'] });
  });

  it('(c) a userId principal who is not an App participant gets the same FORBIDDEN teamChatMessages gives; a Channel ref gets CHANNEL_NOT_FOUND', async () => {
    const c = toolCtx(await mintRun({ userId: outsider.id }));
    const direct = await code(Q.teamChatMessages({}, { appRef: app.id }, c.principal));
    expect(direct).toBe('FORBIDDEN');
    expect(await code(teamChatRead.execute(c, {}))).toBe(direct);
    expect(await code(teamChatRead.execute(c, { channelRef: channel.id }))).toBe('CHANNEL_NOT_FOUND');
  });

  it('(a) a pure App key reads its own App exactly as teamChatMessages does for that principal (rows or empty page, whichever the gate gives)', async () => {
    await say(channel, 'one');
    const c = toolCtx(await mintRun({ userId: null }));
    expect(c.principal.userId).toBeFalsy();
    const direct = await Q.teamChatMessages({}, { appRef: app.id, sinceSeq: 0 }, c.principal);
    const out = await run_(c);
    expect(out.messages.map((m) => m.seq)).toEqual(direct.items.map((m: any) => m.seq));
  });

  it('(a\') a pure App key of ANOTHER App is refused like teamChatMessages: FORBIDDEN, and CHANNEL_NOT_FOUND by Channel ref', async () => {
    const c = toolCtx(await mintRun({ userId: null }, otherApp.id));
    // The run's own App is otherApp here, so the Channel of `app` is another App's.
    expect(await code(teamChatRead.execute(c, { channelRef: channel.id }))).toBe('CHANNEL_NOT_FOUND');
  });

  it('(b) a Channel in a personal memory the principal cannot read, one in another App, and a missing ref all answer the same CHANNEL_NOT_FOUND', async () => {
    const c = toolCtx(await mintRun({ userId: member.id }));
    for (const ref of [personalChannel.id, otherChannel.id, 'does-not-exist']) {
      const direct = await code(Q.channelMessages({}, { channelRef: ref }, c.principal));
      expect(direct).toBe('CHANNEL_NOT_FOUND');
      expect(await code(teamChatRead.execute(c, { channelRef: ref }))).toBe('CHANNEL_NOT_FOUND');
    }
  });

  it('a run speaks for ONE App: an org-admin owner and a member of both Apps still get CHANNEL_NOT_FOUND for a personal Channel and another App\'s Channel (§10 P2)', async () => {
    await db.appMember.create({ data: { appId: otherApp.id, userId: member.id, role: 'member' } });
    await say(otherChannel, 'other app');
    for (const userId of [manager.id, member.id]) {
      const c = toolCtx(await mintRun({ userId }));
      // The principal itself CAN read these through the plain Channel read; only the run's App bound refuses.
      if (userId === manager.id) expect(await code(Q.channelMessages({}, { channelRef: personalChannel.id }, c.principal))).toBeUndefined();
      if (userId === manager.id) expect(await code(Q.channelMessages({}, { channelRef: otherChannel.id }, c.principal))).toBeUndefined();
      for (const ref of [personalChannel.id, otherChannel.id]) {
        if (userId === member.id && ref === personalChannel.id) continue;
        expect(await code(teamChatRead.execute(c, { channelRef: ref }))).toBe('CHANNEL_NOT_FOUND');
      }
    }
    // The own App's Channel is still readable by the owner.
    await say(channel, 'mine');
    expect((await run_(toolCtx(await mintRun({ userId: manager.id })), { channelRef: channel.id })).messages.map((m) => m.body)).toEqual(['mine']);
  });

  it('the App is the run\'s, never an argument: appRef/appId args naming another App change nothing', async () => {
    await say(channel, 'own');
    await say(otherChannel, 'other');
    const c = toolCtx(await mintRun({ userId: manager.id }));
    for (const extra of [{ appRef: otherApp.id }, { appId: otherApp.id }]) {
      expect((await run_(c, extra)).messages.map((m) => m.body)).toEqual(['own']);
    }
  });

  it('the host memory\'s own read gate holds on the App address: a pure App key narrowed to an end-user session gets the empty page, not the team space (#1169 shape)', async () => {
    await say(channel, 'team only');
    const endUser = await db.session.create({ data: { id: generateId(), appId: app.id, type: 'CHATBOT', startedAt: new Date() } as never });
    const c = toolCtx(await mintRun({ userId: null }), { sessionId: endUser.id });
    expect(await Q.teamChatMessages({}, { appRef: app.id }, c.principal)).toMatchObject({ items: [], total: 0 });
    expect((await run_(c)).messages).toEqual([]);
    expect((await run_(toolCtx(await mintRun({ userId: member.id })))).messages.map((m) => m.body)).toEqual(['team only']);
  });

  it('a named Channel a participant may read is returned', async () => {
    await say(channel, 'named');
    const out = await run_(toolCtx(await mintRun({ userId: member.id })), { channelRef: channel.id });
    expect(out.messages.map((m) => m.body)).toEqual(['named']);
  });

  it('a deleted Channel reads as missing', async () => {
    await db.channel.update({ where: { id: channel.id }, data: { deletedAt: new Date() } });
    expect(await code(teamChatRead.execute(toolCtx(await mintRun({ userId: member.id })), { channelRef: channel.id }))).toBe('CHANNEL_NOT_FOUND');
  });
});

describe('mentions filter (#2520 criterion 2): the existing resolution, handle or worker', () => {
  beforeEach(async () => {
    await say(channel, 'for bob', { mentions: [member.handle] });
    await say(channel, 'for kit', { mentions: ['kit'] });
    await say(channel, 'for nobody');
  });
  it('by user handle', async () => {
    const out = await run_(toolCtx(await mintRun({ userId: member.id })), { mentions: member.handle });
    expect(out.messages.map((m) => m.body)).toEqual(['for bob']);
  });
  it('by worker (id)', async () => {
    const out = await run_(toolCtx(await mintRun({ userId: member.id })), { mentions: kit.id });
    expect(out.messages.map((m) => m.body)).toEqual(['for kit']);
  });
  it('an unresolvable mentions ref is an empty page, as in the existing read', async () => {
    const out = await run_(toolCtx(await mintRun({ userId: member.id })), { mentions: 'nobody-by-that-name' });
    expect(out.messages).toEqual([]);
  });
});

describe('bounds and paging (#2520 criterion 3)', () => {
  it('states its numbers: default 20, maximum 50, 32 KiB of body', () => {
    expect([TEAM_CHAT_READ_DEFAULT_LIMIT, TEAM_CHAT_READ_MAX_LIMIT, TEAM_CHAT_READ_MAX_BODY_CHARS]).toEqual([20, 50, 32768]);
  });

  it('with no sinceSeq it reads FORWARD from the start, so nextSinceSeq paging is well defined; the next page starts after the last returned message', async () => {
    for (let i = 1; i <= 5; i++) await say(channel, `m${i}`);
    const c = toolCtx(await mintRun({ userId: member.id }));
    const p1 = await run_(c, { limit: 2 });
    expect(p1.messages.map((m) => m.body)).toEqual(['m1', 'm2']);
    expect([p1.nextSinceSeq, p1.hasMore]).toEqual([2, true]);
    const p2 = await run_(c, { limit: 2, sinceSeq: p1.nextSinceSeq });
    expect(p2.messages.map((m) => m.body)).toEqual(['m3', 'm4']);
    const p3 = await run_(c, { limit: 2, sinceSeq: p2.nextSinceSeq });
    expect(p3.messages.map((m) => m.body)).toEqual(['m5']);
    expect([p3.nextSinceSeq, p3.hasMore]).toEqual([5, false]);
    // Nothing further: the cursor stays where it was.
    const p4 = await run_(c, { sinceSeq: p3.nextSinceSeq });
    expect([p4.messages, p4.nextSinceSeq, p4.hasMore]).toEqual([[], 5, false]);
  });

  it('a limit above the maximum is clamped to it; nonsense falls back to the default', async () => {
    for (let i = 1; i <= 55; i++) await say(channel, `m${i}`);
    const c = toolCtx(await mintRun({ userId: member.id }));
    expect((await run_(c, { limit: 500 })).messages).toHaveLength(50);
    expect((await run_(c, { limit: -3 })).messages).toHaveLength(20);
    expect((await run_(c, { limit: 'many' })).messages).toHaveLength(20);
  });

  it('the response cap stops at a message boundary: nextSinceSeq is the last RETURNED seq, and the next page yields the next message exactly once', async () => {
    const big = 'x'.repeat(12_000);
    for (const t of ['a', 'b', 'c', 'd']) await say(channel, `${t}${big}`);
    const c = toolCtx(await mintRun({ userId: member.id }));
    const p1 = await run_(c);
    expect(p1.messages.map((m) => m.seq)).toEqual([1, 2]);
    expect([p1.nextSinceSeq, p1.hasMore]).toEqual([2, true]);
    const p2 = await run_(c, { sinceSeq: p1.nextSinceSeq });
    expect(p2.messages.map((m) => m.seq)).toEqual([3, 4]);
    expect(p2.hasMore).toBe(false);
  });

  it('one message larger than the cap is still returned (cut, flagged) so paging never stalls', async () => {
    await say(channel, 'y'.repeat(TEAM_CHAT_READ_MAX_BODY_CHARS + 500));
    await say(channel, 'next');
    const c = toolCtx(await mintRun({ userId: member.id }));
    const p1 = await run_(c);
    expect(p1.messages).toHaveLength(1);
    expect(p1.messages[0].body.length).toBeLessThanOrEqual(TEAM_CHAT_READ_MAX_BODY_CHARS);
    expect(p1.messages[0].bodyTruncated).toBe(true);
    expect(p1.nextSinceSeq).toBe(1);
    expect((await run_(c, { sinceSeq: 1 })).messages.map((m) => m.body)).toEqual(['next']);
  });
});

describe('a run is not the human reading (#2520 criterion 4)', () => {
  const marks = async () => {
    const rs = await db.channelReadState.findFirst({ where: { workerId: kit.id, channelId: channel.id } });
    return {
      delivered: (await db.workerDeliveryChannel.findUnique({ where: { workerId_channelId: { workerId: kit.id, channelId: channel.id } } }))?.deliveredThroughSeq ?? 0,
      read: rs?.lastSeenSeq ?? 0,
      checkedAt: rs?.lastCheckedAt ?? null,
    };
  };

  it('with a sessionId on the principal and a mentions filter resolving to a worker, the human\'s marks do not move; the same read through channelMessages DOES move them (the pin can fail)', async () => {
    await db.registerEntry.updateMany({ where: { attendeeWorkerId: kit.id, channelId: channel.id }, data: { mentionOnly: true } });
    for (const t of ['a', 'b']) await say(channel, `@kit ${t}`, { mentions: ['kit'] });
    await db.node.updateMany({ where: { messageChannelId: channel.id }, data: { createdAt: new Date(Date.now() - 3600_000) } });
    const session = await db.session.create({ data: { id: generateId(), appId: app.id, userId: member.id, workerId: kit.id, agentId } as never });
    const before = await marks();

    const c = toolCtx(await mintRun({ userId: member.id }), { sessionId: session.id });
    const out = await run_(c, { channelRef: channel.id, mentions: kit.id });
    expect(out.messages).toHaveLength(2);
    expect(await marks()).toEqual(before);

    // Positive control: the advancing resolver, same principal and filter, moves the marks.
    await Q.channelMessages({}, { channelRef: channel.id, mentionsRef: kit.id }, c.principal);
    expect(await marks()).not.toEqual(before);
  });
});
