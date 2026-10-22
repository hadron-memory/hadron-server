import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
/**
 * Spec 049 Phase 8 — Channel-addressed chat and item J, what is pinned:
 *   - channelMessages / createChannelMessage work on a custom Channel with the
 *     team-chat contract (seq allocation, mentions, replyToSeq, the watermark);
 *   - the team-chat convenience and the Channel-addressed read see the SAME
 *     messages (one core, two entry points);
 *   - a Channel the caller may not read is CHANNEL_NOT_FOUND, identically to
 *     a nonexistent one; one they may read but not post into is FORBIDDEN;
 *   - item J in BOTH directions: (a) a Worker of App A whose driver cannot
 *     write App B's host memory is refused CHANNEL_HOST_NOT_WRITABLE —
 *     deleting the memory check would turn this green; (b) a Worker of App A
 *     whose driver may write B's host memory is admitted, and the message
 *     carries authorAppId; a pure App-key session is never widened.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { ensureChannelWithRoot } from '../../../lib/channels.js';
import { waitForLockWaiters } from '../../../test/lockWait.js';

const Q = resolvers.Query as any;
const M = resolvers.Mutation as any;

let org: { id: string; urn: string };
let admin: { id: string };
let member: { id: string };
let stranger: { id: string };
let appA: { id: string; urn: string };
let appB: { id: string; urn: string };
let agent: { id: string; urn: string };
let memA: { id: string; urn: string };
let memB: { id: string; urn: string };
let workerA: { id: string };
let release: { id: string };
let teamB: { id: string };

const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] }) as Context;

/** Pause one resolved Channel snapshot so a test can replace its incarnation. */
function pausedChannelFindFirstContext(userId: string): {
  context: Context;
  reached: Promise<void>;
  release: () => void;
} {
  let signalReached!: () => void;
  let signalRelease!: () => void;
  let pending = true;
  const reached = new Promise<void>((resolve) => { signalReached = resolve; });
  const released = new Promise<void>((resolve) => { signalRelease = resolve; });
  const channel = new Proxy(db.channel, {
    get(target, prop, receiver) {
      if (prop === 'findFirst') {
        return async (...args: unknown[]) => {
          const row = await (target.findFirst as (...inner: unknown[]) => Promise<unknown>)(...args);
          if (pending) {
            pending = false;
            signalReached();
            await released;
          }
          return row;
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  const client = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'channel') return channel;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return {
    context: { db: client, userId, roles: ['READER'] } as unknown as Context,
    reached,
    release: signalRelease,
  };
}

beforeEach(async () => {
  await cleanDb(db);
  const t = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'cc', urn: `cc-${t}` } });
  const orgB = await db.organization.create({ data: { id: generateId(), name: 'cc-b', urn: `cc-b-${t}` } });
  const mk = (n: number, tag: string) => db.user.create({ data: { id: generateId(), githubId: 49600 + n, githubUsername: `cc-${tag}-${t}`, handle: `cc-${tag}-${t}` } });
  admin = await mk(1, 'admin');
  member = await mk(2, 'member');
  stranger = await mk(3, 'stranger');
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: member.id, role: 'READER' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgB.id, userId: stranger.id, role: 'ADMIN' } });
  appA = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'A', urn: `${org.urn}:a` } });
  appB = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'B', urn: `${org.urn}:b` } });
  agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'agent', urn: `${org.urn}:agent`, visibility: 'ORGANIZATION' } });
  await db.appAgent.create({ data: { appId: appA.id, agentId: agent.id } });
  await db.appAgent.create({ data: { appId: appB.id, agentId: agent.id } });
  // admin participates in both Apps; member only in A.
  await db.appMember.create({ data: { appId: appA.id, userId: admin.id, role: 'admin' } });
  await db.appMember.create({ data: { appId: appB.id, userId: admin.id, role: 'admin' } });
  await db.appMember.create({ data: { appId: appA.id, userId: member.id, role: 'member' } });
  memA = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:a-shared`, name: 'a', class: 'app', appId: appA.id, sharedMemoryOfAgentId: agent.id } });
  memB = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:b-shared`, name: 'b', class: 'app', appId: appB.id, sharedMemoryOfAgentId: agent.id } });
  workerA = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: appA.id, agentId: agent.id, name: 'Iris', slug: 'iris' } });
  await ensureChannelWithRoot(db, { memoryId: memA.id, loc: 'chats:team', name: 'team', createdBy: admin.id, asDefaultOfAppId: appA.id });
  release = (await ensureChannelWithRoot(db, { memoryId: memA.id, loc: 'chats:release', name: 'release', createdBy: admin.id })).channel;
  teamB = (await ensureChannelWithRoot(db, { memoryId: memB.id, loc: 'chats:team', name: 'team', createdBy: admin.id, asDefaultOfAppId: appB.id })).channel;
});

async function boundSession(userId: string, appId: string, workerId: string) {
  return db.session.create({ data: { id: generateId(), appId, userId, workerId, type: 'DEVELOPER', startedAt: new Date() } as never });
}

describe('Channel-addressed chat', () => {
  it('posts and reads a custom Channel with the team-chat contract; the convenience and the Channel read share one core', async () => {
    const first = await M.createChannelMessage({}, { channelRef: release.id, body: 'shipping @iris' }, ctx(admin.id));
    expect(first).toMatchObject({ seq: 1, mentions: ['iris'], authorUserId: admin.id, authorAppId: null });
    const second = await M.createChannelMessage({}, { channelRef: release.id, body: 'ack', replyToSeq: 1 }, ctx(admin.id));
    expect(second).toMatchObject({ seq: 2, replyToSeq: 1 });
    const page = await Q.channelMessages({}, { channelRef: release.id }, ctx(admin.id));
    expect(page.total).toBe(2);
    expect(page.items.map((m: { seq: number }) => m.seq)).toEqual([1, 2]);
    expect((await Q.channelMessages({}, { channelRef: release.id, mentionsRef: 'Iris' }, ctx(admin.id))).total).toBe(1);
    expect((await Q.channelMessages({}, { channelRef: release.id, sinceSeq: 1 }, ctx(admin.id))).items[0].seq).toBe(2);
    expect((await db.channel.findUniqueOrThrow({ where: { id: release.id } })).lastSeq).toBe(2);
    // The default team Channel through both entry points.
    await M.createTeamChatMessage({}, { appRef: appA.urn, body: 'team hello' }, ctx(admin.id));
    const teamA = await db.app.findUniqueOrThrow({ where: { id: appA.id } });
    expect((await Q.channelMessages({}, { channelRef: teamA.defaultChannelId }, ctx(admin.id))).items[0].body).toBe('team hello');
    expect((await Q.teamChatMessages({}, { appRef: appA.urn }, ctx(admin.id))).items[0].body).toBe('team hello');
    await expect(M.createChannelMessage({}, { channelRef: release.id, body: 'x', replyToSeq: 99 }, ctx(admin.id))).rejects.toMatchObject({ extensions: { code: 'TEAM_CHAT_REPLY_NOT_FOUND' } });
  });

  it('returns the newest Channel page unless a forward cursor or legacy offset is explicit', async () => {
    for (let i = 1; i <= 5; i++) await M.createChannelMessage({}, { channelRef: release.id, body: `m${i}` }, ctx(admin.id));
    const read = (args: Record<string, unknown>) => Q.channelMessages({}, { channelRef: release.id, limit: 2, ...args }, ctx(admin.id));
    expect((await read({})).items.map((m: { seq: number }) => m.seq)).toEqual([4, 5]);
    expect((await read({ sinceSeq: 0 })).items.map((m: { seq: number }) => m.seq)).toEqual([1, 2]);
    expect((await read({ offset: 0 })).items.map((m: { seq: number }) => m.seq)).toEqual([1, 2]);
    expect((await read({ beforeSeq: 4 })).items.map((m: { seq: number }) => m.seq)).toEqual([2, 3]);
  });

  it('treats `_` and `%` in Channel locs literally for reads, replies, and seq allocation (#1226)', async () => {
    const underscored = (await ensureChannelWithRoot(db, {
      memoryId: memA.id, loc: 'chats_team', name: 'underscored', createdBy: admin.id,
    })).channel;
    await db.node.create({
      data: {
        id: generateId(), memoryId: memA.id, loc: 'chatsXteam:messages:0099-sibling',
        name: 'sibling', nodeType: 'chat-message', seq: 99, content: 'not this Channel',
        data: { authorUserId: admin.id, authorName: 'sibling' },
      },
    });

    expect(await Q.channelMessages({}, { channelRef: underscored.id }, ctx(admin.id))).toMatchObject({ items: [], total: 0 });
    await expect(
      M.createChannelMessage({}, { channelRef: underscored.id, body: 'reply', replyToSeq: 99 }, ctx(admin.id)),
    ).rejects.toMatchObject({ extensions: { code: 'TEAM_CHAT_REPLY_NOT_FOUND' } });
    const first = await M.createChannelMessage({}, { channelRef: underscored.id, body: 'first' }, ctx(admin.id));
    expect(first.seq).toBe(1);
    expect((await Q.channelMessages({}, { channelRef: underscored.id }, ctx(admin.id))).items.map((m: { body: string }) => m.body)).toEqual(['first']);

    const percent = (await ensureChannelWithRoot(db, {
      memoryId: memA.id, loc: 'chats%team', name: 'percent', createdBy: admin.id,
    })).channel;
    await db.node.create({
      data: {
        id: generateId(), memoryId: memA.id, loc: 'chatsZZteam:messages:0077-sibling',
        name: 'sibling', nodeType: 'chat-message', seq: 77, content: 'not percent',
      },
    });
    const percentFirst = await M.createChannelMessage({}, { channelRef: percent.id, body: 'percent first' }, ctx(admin.id));
    expect(percentFirst.seq).toBe(1);
    expect((await Q.channelMessages({}, { channelRef: percent.id }, ctx(admin.id))).items.map((m: { body: string }) => m.body)).toEqual(['percent first']);
  });

  it('a Channel the caller may not read is CHANNEL_NOT_FOUND like a nonexistent one; readable-but-not-postable is FORBIDDEN', async () => {
    await expect(Q.channelMessages({}, { channelRef: teamB.id }, ctx(member.id))).rejects.toMatchObject({ extensions: { code: 'CHANNEL_NOT_FOUND' } });
    await expect(Q.channelMessages({}, { channelRef: 'nope' }, ctx(member.id))).rejects.toMatchObject({ extensions: { code: 'CHANNEL_NOT_FOUND' } });
    await expect(Q.channelMessages({}, { channelRef: release.id }, ctx(stranger.id))).rejects.toMatchObject({ extensions: { code: 'CHANNEL_NOT_FOUND' } });
    await expect(M.createChannelMessage({}, { channelRef: teamB.id, body: 'x' }, ctx(member.id))).rejects.toMatchObject({ extensions: { code: 'CHANNEL_NOT_FOUND' } });
    // A pure App-key principal of App A may READ its Channels but never post.
    const appKey = { db, appId: appA.id, roles: [] } as unknown as Context;
    expect((await Q.channelMessages({}, { channelRef: release.id }, appKey)).total).toBe(0);
    await expect(M.createChannelMessage({}, { channelRef: release.id, body: 'x' }, appKey)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  });

  it('item J both directions: refused when the driver cannot write the host memory; admitted, and marked, when they can', async () => {
    // (a) an admin may drive another user's session, but the session's user
    // must independently be a participant in B to author in B's host memory.
    // Deleting the memory check in resolveSessionAuthor turns this green.
    const memberSession = await boundSession(member.id, appA.id, workerA.id);
    const platformAdmin = { db, userId: admin.id, roles: ['ADMIN'] } as unknown as Context;
    await expect(
      M.createChannelMessage({}, { channelRef: teamB.id, body: 'hi from A', sessionRef: memberSession.id }, platformAdmin),
    ).rejects.toMatchObject({ extensions: { code: 'CHANNEL_HOST_NOT_WRITABLE', workerAppId: appA.id } });
    // (b) admin drives Iris (App A) and, as B's participant, may write B's host memory.
    const adminSession = await boundSession(admin.id, appA.id, workerA.id);
    const posted = await M.createChannelMessage({}, { channelRef: teamB.id, body: 'hi from A', sessionRef: adminSession.id }, ctx(admin.id));
    expect(posted).toMatchObject({ authorWorkerId: workerA.id, authorName: 'Iris', authorAppId: appA.id, sessionId: adminSession.id });
    const read = await Q.channelMessages({}, { channelRef: teamB.id }, ctx(admin.id));
    expect(read.items[0].authorAppId).toBe(appA.id);
    // Same gate through the convenience entry point (one gate, two entry points).
    const viaTeam = await M.createTeamChatMessage({}, { appRef: appB.urn, body: 'again', sessionRef: adminSession.id }, ctx(admin.id));
    expect(viaTeam.authorAppId).toBe(appA.id);
    // Same-App posts carry no authorAppId.
    const home = await M.createTeamChatMessage({}, { appRef: appA.urn, body: 'home', sessionRef: adminSession.id }, ctx(admin.id));
    expect(home.authorAppId).toBeNull();
  });
});

describe('PR #1169 review — the memory boundary and the on-behalf-of user', () => {
  it('an App-key context narrowed to an end-user session cannot read a Channel through the App-participant gate', async () => {
    const memRelease = await db.memory.findUniqueOrThrow({ where: { id: memA.id } });
    void memRelease;
    // A pure App-key principal with an end-user session: getAccessibleMemoryIds
    // narrows it to that session's memories; the team space is not among them.
    const session = await db.session.create({ data: { id: generateId(), appId: appA.id, type: 'CHATBOT', startedAt: new Date() } as never });
    const endUser = { db, appId: appA.id, sessionId: session.id, roles: [] } as unknown as Context;
    await expect(Q.channelMessages({}, { channelRef: release.id }, endUser)).rejects.toMatchObject({ extensions: { code: 'CHANNEL_NOT_FOUND' } });
  });

  it('cross-App rights are the SESSION user\'s, not the caller\'s: a platform admin driving a reader\'s session is refused', async () => {
    // Member belongs to A only. The caller's platform role cannot supply the
    // missing B participation to a session authored on the member's behalf.
    const memberSession = await boundSession(member.id, appA.id, workerA.id);
    const platformAdmin = { db, userId: admin.id, roles: ['ADMIN'] } as unknown as Context;
    await expect(
      M.createChannelMessage({}, { channelRef: teamB.id, body: 'as Iris', sessionRef: memberSession.id }, platformAdmin),
    ).rejects.toMatchObject({ extensions: { code: 'CHANNEL_HOST_NOT_WRITABLE' } });
  });

  it('a Channel deleted between resolving the target and the append is never written', async () => {
    // Simulated at the seam the race lands on: the append helper re-checks
    // the Channel row LIVE under the lock, so a stale target cannot append.
    const target = await db.channel.findUniqueOrThrow({ where: { id: release.id } });
    await M.deleteChannel({}, { ref: release.id }, ctx(admin.id));
    await expect(M.createChannelMessage({}, { channelRef: target.id, body: 'late' }, ctx(admin.id))).rejects.toMatchObject({ extensions: { code: 'CHANNEL_NOT_FOUND' } });
    expect(await db.node.count({ where: { memoryId: memA.id, loc: { startsWith: 'chats:release:messages:' } } })).toBe(0);
  });

  it('a post resolved against an old incarnation cannot land after delete + reuse (#1226)', async () => {
    await M.createChannelMessage({}, { channelRef: release.id, body: 'old' }, ctx(admin.id));
    const paused = pausedChannelFindFirstContext(admin.id);
    const stalePost = M.createChannelMessage(
      {}, { channelRef: release.id, body: 'stale late post' }, paused.context,
    );
    await paused.reached;
    await M.deleteChannel({}, { ref: release.id }, ctx(admin.id));
    const { channel: reused } = await ensureChannelWithRoot(db, {
      memoryId: memA.id, loc: 'chats:release', name: 'release', createdBy: admin.id,
    });
    paused.release();
    await expect(stalePost).rejects.toMatchObject({ extensions: { code: 'CHANNEL_NOT_FOUND' } });
    expect((await Q.channelMessages({}, { channelRef: reused.id }, ctx(admin.id))).items).toEqual([]);
  });

  it('a stale delete request cannot tombstone a newly reused incarnation (#1226)', async () => {
    const paused = pausedChannelFindFirstContext(admin.id);
    const staleDelete = M.deleteChannel({}, { ref: release.id }, paused.context);
    await paused.reached;
    await M.deleteChannel({}, { ref: release.id }, ctx(admin.id));
    const { channel: reused } = await ensureChannelWithRoot(db, {
      memoryId: memA.id, loc: 'chats:release', name: 'release', createdBy: admin.id,
    });
    paused.release();
    await expect(staleDelete).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    expect((await db.channel.findUniqueOrThrow({ where: { id: reused.id } })).deletedAt).toBeNull();
    expect((await db.node.findUniqueOrThrow({ where: { id: reused.chatRootNodeId } })).deletedAt).toBeNull();
  });
});

describe('PR #1169 review, round 2 — liveness and the convenience read', () => {
  it('an idle session cannot author (SESSION_NOT_LIVE); the team-chat convenience read is gated on the host memory too', async () => {
    // A session untouched for longer than its idle window is open but nobody is driving it.
    const stale = await db.session.create({
      data: { id: generateId(), appId: appA.id, userId: admin.id, workerId: workerA.id, type: 'DEVELOPER', startedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) } as never,
    });
    await db.session.update({ where: { id: stale.id }, data: { updatedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) } });
    await expect(M.createChannelMessage({}, { channelRef: release.id, body: 'x', sessionRef: stale.id }, ctx(admin.id))).rejects.toMatchObject({ extensions: { code: 'SESSION_NOT_LIVE' } });
    // The convenience read under an App-key context narrowed to an end-user session: empty, not the team space.
    const session = await db.session.create({ data: { id: generateId(), appId: appA.id, type: 'CHATBOT', startedAt: new Date() } as never });
    const endUser = { db, appId: appA.id, sessionId: session.id, roles: [] } as unknown as Context;
    await M.createTeamChatMessage({}, { appRef: appA.urn, body: 'team hello' }, ctx(admin.id));
    expect(await Q.teamChatMessages({}, { appRef: appA.urn }, endUser)).toEqual({ items: [], total: 0 });
    expect((await Q.teamChatMessages({}, { appRef: appA.urn }, ctx(admin.id))).total).toBe(1);
  });
});

describe('#1540 — authoring through a live session keeps it live', () => {
  const H = 60 * 60 * 1000;
  // Only Date is faked: the server's own clock (Session.updatedAt, the
  // liveness cutoff) moves, while Prisma and pg keep their real timers.
  afterEach(() => vi.useRealTimers());

  async function bindAt(t0: Date) {
    return db.session.create({
      data: { id: generateId(), appId: appA.id, userId: admin.id, workerId: workerA.id, type: 'DEVELOPER', startedAt: t0 } as never,
    });
  }
  const post = (sessionId: string, body: string) =>
    M.createChannelMessage({}, { channelRef: release.id, body, sessionRef: sessionId }, ctx(admin.id));

  it('a session that posts inside its window is still live past startedAt + window', async () => {
    const t0 = new Date();
    const session = await bindAt(t0);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(t0.getTime() + 20 * H));
    await post(session.id, 'at 20h');
    expect((await db.session.findUniqueOrThrow({ where: { id: session.id } })).updatedAt!.getTime())
      .toBeGreaterThanOrEqual(t0.getTime() + 20 * H);
    vi.setSystemTime(new Date(t0.getTime() + 30 * H)); // past startedAt + 24h, inside 24h of the last post
    await expect(post(session.id, 'at 30h')).resolves.toBeTruthy();
  });

  it("a post through a Channel the driver may write does NOT heartbeat a worker whose App they no longer drive (Codex-worker P1)", async () => {
    // The worker lives in a user-owned App that `stranger` does not
    // participate in (owner-only); `stranger` still ADMINs org B, so may write
    // a free-standing Channel's host memory there and the post is authorized.
    const strangerUser = await db.user.findUniqueOrThrow({ where: { id: stranger.id }, select: { handle: true } });
    const adminUser = await db.user.findUniqueOrThrow({ where: { id: admin.id }, select: { handle: true } });
    const orgB = await db.orgMember.findFirstOrThrow({ where: { userId: stranger.id }, select: { organizationId: true } });
    const appU = await db.app.create({ data: { id: generateId(), ownerUserId: admin.id, name: 'U', urn: `${adminUser.handle}:u` } });
    const workerU = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: appU.id, agentId: agent.id, name: 'Kit', slug: 'kit' } });
    const memK = await db.memory.create({ data: { id: generateId(), organizationId: orgB.organizationId, urn: `${strangerUser.handle}-k`, name: 'k', class: 'knowledge' } });
    const free = (await ensureChannelWithRoot(db, { memoryId: memK.id, loc: 'chats:k', name: 'k', createdBy: stranger.id })).channel;
    const before = new Date(Date.now() - 2 * H);
    const session = await db.session.create({
      data: { id: generateId(), appId: appU.id, userId: stranger.id, workerId: workerU.id, type: 'DEVELOPER', startedAt: before } as never,
    });
    await db.session.update({ where: { id: session.id }, data: { updatedAt: before } });

    await M.createChannelMessage({}, { channelRef: free.id, body: 'cross-App', sessionRef: session.id }, ctx(stranger.id));
    expect((await db.session.findUniqueOrThrow({ where: { id: session.id } })).updatedAt!.getTime()).toBe(before.getTime());
  });

  it('control: a genuinely silent session is still refused, and the refusal names a remedy that exists', async () => {
    const t0 = new Date();
    const session = await bindAt(t0);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(t0.getTime() + 30 * H));
    const refused = post(session.id, 'too late');
    await expect(refused).rejects.toMatchObject({ extensions: { code: 'SESSION_NOT_LIVE' } });
    await expect(refused).rejects.toThrow(/hadron team session start --as|hadron_start_session/);
    // A refused post does not revive it either.
    await expect(post(session.id, 'still too late')).rejects.toMatchObject({ extensions: { code: 'SESSION_NOT_LIVE' } });
  });

  describe('#1617 B — the name-holder resumes their own lapsed session (Holger, 2026-10-05)', () => {
    const hold = () => db.worker.update({ where: { id: workerA.id }, data: { heldByUserId: admin.id, heldAt: new Date() } });
    const lapsedSession = async () => {
      const t0 = new Date();
      const session = await bindAt(t0);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(t0.getTime() + 30 * H));
      return session;
    };
    const heartbeat = async (id: string) =>
      (await db.session.findUniqueOrThrow({ where: { id } })).updatedAt!.getTime();

    it('a post through it resumes it under the SAME id, and it reads live again', async () => {
      await hold();
      const session = await lapsedSession();
      await expect(post(session.id, 'back after a quiet night')).resolves.toBeTruthy();
      expect(await heartbeat(session.id)).toBe(Date.now());
      await expect(post(session.id, 'and again')).resolves.toBeTruthy();
    });

    it('a read through it resumes it too', async () => {
      await hold();
      const session = await lapsedSession();
      await Q.channelMessages({}, { channelRef: release.id, sinceSeq: 0 }, { ...ctx(admin.id), sessionId: session.id });
      expect(await heartbeat(session.id)).toBe(Date.now());
    });

    it('is refused when the caller does not hold the name', async () => {
      const session = await lapsedSession();
      await expect(post(session.id, 'not mine to resume')).rejects.toMatchObject({ extensions: { code: 'SESSION_NOT_LIVE' } });
      expect(await heartbeat(session.id)).toBeLessThan(Date.now() - 24 * H);
    });

    it('is refused while ANOTHER session on that worker is live', async () => {
      await hold();
      const session = await lapsedSession();
      await bindAt(new Date()); // a second, live stint on the same worker
      await expect(post(session.id, 'two at once')).rejects.toMatchObject({ extensions: { code: 'SESSION_NOT_LIVE' } });
    });

    it('never extends a hard expiry promised at session start', async () => {
      await hold();
      const session = await lapsedSession();
      await db.session.update({ where: { id: session.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      // #1036 / R5: this is a promised end, not a resumable idle lapse.
      await expect(post(session.id, 'past my deadline')).rejects.toMatchObject({ extensions: { code: 'SESSION_ENDED' } });
    });

    it('DY-5: a post through a DORMANT session is refused SESSION_NOT_LIVE with reason DORMANT', async () => {
      await hold();
      const t0 = new Date();
      const session = await bindAt(t0);
      const before = await heartbeat(session.id);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(t0.getTime() + 91 * 24 * H));
      await expect(post(session.id, 'back after a season')).rejects.toMatchObject({
        extensions: { code: 'SESSION_NOT_LIVE', reason: 'DORMANT' },
      });
      expect(await heartbeat(session.id)).toBe(before);
    });

    it('#1625 P2-1: a post refused INSIDE the append transaction resumes nothing', async () => {
      await hold();
      const session = await lapsedSession();
      const before = await heartbeat(session.id);
      await expect(
        M.createChannelMessage({}, { channelRef: release.id, body: 'reply to nothing', sessionRef: session.id, replyToSeq: 9999 }, ctx(admin.id)),
      ).rejects.toMatchObject({ extensions: { code: 'TEAM_CHAT_REPLY_NOT_FOUND' } });
      expect(await heartbeat(session.id)).toBe(before);
    });

    it('#1625 P2-3: a hard expiry that passes during the Worker lock wait refuses the resume', async () => {
      await hold();
      const session = await lapsedSession();
      const before = await heartbeat(session.id);
      let unblock!: () => void;
      const gate = new Promise<void>((r) => { unblock = r; });
      let locked!: () => void;
      const lockedNow = new Promise<void>((r) => { locked = r; });
      const blocker = db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM workers WHERE id = ${workerA.id} FOR UPDATE`;
        locked();
        await gate;
        // Raw SQL, so the test's own write does not bump `updatedAt` (Prisma's @updatedAt).
        await tx.$executeRaw`UPDATE sessions SET expires_at = now() WHERE id = ${session.id}`;
      }, { timeout: 20_000 });
      await lockedNow;
      const attempt = post(session.id, 'racing my own deadline').catch((e: unknown) => e);
      await waitForLockWaiters(db, 1); // the resume is parked on the Worker lock, pre-check already passed
      unblock();
      await blocker;
      expect(await attempt).toMatchObject({ extensions: { code: 'SESSION_NOT_LIVE' } });
      expect(await heartbeat(session.id)).toBe(before);
    });

    it('#1625 P2-3: losing the hold during the lock wait refuses the resume', async () => {
      await hold();
      const session = await lapsedSession();
      let unblock!: () => void;
      const gate = new Promise<void>((r) => { unblock = r; });
      let locked!: () => void;
      const lockedNow = new Promise<void>((r) => { locked = r; });
      const blocker = db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM workers WHERE id = ${workerA.id} FOR UPDATE`;
        locked();
        await gate;
        await tx.worker.update({ where: { id: workerA.id }, data: { heldByUserId: null, heldAt: null } });
      }, { timeout: 20_000 });
      await lockedNow;
      const attempt = post(session.id, 'released under me').catch((e: unknown) => e);
      await waitForLockWaiters(db, 1);
      unblock();
      await blocker;
      expect(await attempt).toMatchObject({ extensions: { code: 'SESSION_NOT_LIVE' } });
    });

    it('a platform admin driving SOMEONE ELSE\'s lapsed session cannot resume it (ownership leg of (ii))', async () => {
      await hold();
      const session = await lapsedSession();
      const platformAdmin = { db, userId: stranger.id, roles: ['ADMIN'] } as Context;
      const attempt = M.createChannelMessage({}, { channelRef: release.id, body: 'not my stint', sessionRef: session.id }, platformAdmin);
      await expect(attempt).rejects.toBeTruthy();
      expect(await heartbeat(session.id)).toBeLessThan(Date.now() - 24 * H);
    });

    it('a post refused for another reason resumes nothing', async () => {
      await hold();
      const session = await lapsedSession();
      const before = await heartbeat(session.id);
      await db.worker.update({ where: { id: workerA.id }, data: { retiredAt: new Date() } });
      await expect(post(session.id, 'retired')).rejects.toMatchObject({ extensions: { code: 'WORKER_RETIRED' } });
      expect(await heartbeat(session.id)).toBe(before);
    });
  });
});

describe('#1171 — the Channel address on the chat surface', () => {
  it('posts and reads by address, and the address is what tells two Channels named `team` apart', async () => {
    // memA and memB BOTH host a Channel named `team` at `chats:team` — the
    // measurement the issue was filed on. The name cannot separate them and
    // the loc cannot either; only the memory-qualified address can.
    const addressA = `hrn:node:${memA.urn}:chats:team`;
    const addressB = `hrn:node:${memB.urn}:chats:team`;
    expect(addressA).not.toBe(addressB);

    const posted = await M.createChannelMessage({}, { channelRef: addressA, body: 'by address' }, ctx(admin.id));
    expect(posted.seq).toBe(1);
    const page = await Q.channelMessages({}, { channelRef: addressA }, ctx(admin.id));
    expect(page.items.map((m: { body: string }) => m.body)).toEqual(['by address']);
    // …and it landed in A, not in the identically-named B.
    expect((await Q.channelMessages({}, { channelRef: addressB }, ctx(admin.id))).total).toBe(0);
    const teamA = await db.app.findUniqueOrThrow({ where: { id: appA.id } });
    expect((await Q.channelMessages({}, { channelRef: teamA.defaultChannelId }, ctx(admin.id))).items[0].body).toBe('by address');

    // The address a read emits is the one the refs accept (round trip).
    const row = await Q.channel({}, { ref: teamA.defaultChannelId }, ctx(admin.id));
    expect(await (resolvers as any).Channel.chatRootUrn(row, {}, ctx(admin.id))).toBe(addressA);
  });

  it('an unreadable Channel and an address naming nothing are CHANNEL_NOT_FOUND, identically', async () => {
    // The id form's posture, re-derived for the new form: the widening adds an
    // address, never a way to learn a Channel exists (cor:api:140:02).
    const addressB = `hrn:node:${memB.urn}:chats:team`;
    for (const ref of [addressB, `hrn:node:${memA.urn}:chats:absent`, `hrn:mem:${memA.urn}:chats:team`, `${memA.urn}:notes:nothing`]) {
      await expect(Q.channelMessages({}, { channelRef: ref }, ctx(member.id))).rejects.toMatchObject({ extensions: { code: 'CHANNEL_NOT_FOUND' } });
      await expect(M.createChannelMessage({}, { channelRef: ref, body: 'x' }, ctx(member.id))).rejects.toMatchObject({ extensions: { code: 'CHANNEL_NOT_FOUND' } });
    }
    // And a reader who MAY read B still cannot be told the difference between
    // "wrong address" and "not yours" by the message either.
    await expect(Q.channelMessages({}, { channelRef: `hrn:node:${memB.urn}:chats:team` }, ctx(stranger.id))).rejects.toMatchObject({ extensions: { code: 'CHANNEL_NOT_FOUND' } });
    expect(await db.node.count({ where: { memoryId: memB.id, loc: { startsWith: 'chats:team:messages:' } } })).toBe(0);
  });
});
