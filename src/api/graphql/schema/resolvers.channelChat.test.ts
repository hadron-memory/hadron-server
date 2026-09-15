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

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { ensureChannelWithRoot } from '../../../lib/channels.js';

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
  workerA = await db.worker.create({ data: { id: generateId(), appId: appA.id, agentId: agent.id, name: 'Iris', slug: 'iris' } });
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
    // (a) member (an org READER) drives Iris (App A) and is a participant of B —
    // so B's Channel is readable to them and the author gate is reached — but
    // an org READER may not WRITE B's host memory: refused, with both Apps named.
    // Deleting the memory check in resolveSessionAuthor turns this green.
    const memberSession = await boundSession(member.id, appA.id, workerA.id);
    await db.appMember.create({ data: { appId: appB.id, userId: member.id, role: 'member' } });
    await expect(
      M.createChannelMessage({}, { channelRef: teamB.id, body: 'hi from A', sessionRef: memberSession.id }, ctx(member.id)),
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
    // member (org READER, participant of A and B) drives Iris; a platform
    // ADMIN posts through that session into B. The admin could write B's host
    // memory; member may not — and it is member's authorship, so it refuses.
    await db.appMember.create({ data: { appId: appB.id, userId: member.id, role: 'member' } });
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
});
