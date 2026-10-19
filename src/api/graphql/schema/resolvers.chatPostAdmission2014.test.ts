/** Worker post admission: #2014/#2015, through the real shared resolver. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { ensureChannelWithRoot } from '../../../lib/channels.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const M = resolvers.Mutation as any;
let userId: string, appId: string, workerId: string, sessionId: string;
let channels: string[];
const ctx = (): Context => ({ db, userId, roles: ['READER'] });
const post = (body: string, channelRef = channels[0], extra: Record<string, unknown> = {}) =>
  M.createChannelMessage({}, { channelRef, body, sessionRef: sessionId, ...extra }, ctx());
async function failure(p: Promise<unknown>): Promise<GraphQLError> {
  try { await p; throw new Error('post unexpectedly accepted'); } catch (e) { expect(e).toBeInstanceOf(GraphQLError); return e as GraphQLError; }
}
beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'admission', urn: 'admission2014.example' } });
  const user = await db.user.create({ data: { githubId: 201401, githubUsername: 'admission', handle: 'admission-human', roles: ['READER'] } });
  userId = user.id;
  await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'ADMIN' } });
  const agent = await db.agent.create({ data: { name: 'engineer', urn: 'admission2014.example:engineer', organizationId: org.id } });
  const app = await db.app.create({ data: { name: 'Team', urn: 'admission2014.example:team', organizationId: org.id } });
  appId = app.id;
  await db.appAgent.create({ data: { appId, agentId: agent.id } });
  await db.appMember.create({ data: { appId, userId, role: 'owner' } });
  const memory = await db.memory.create({ data: { name: 'shared', urn: 'admission2014.example:shared', class: 'app', appId, organizationId: org.id, sharedMemoryOfAgentId: agent.id } });
  channels = [];
  for (const loc of ['chats:team', 'chats:ops']) channels.push((await ensureChannelWithRoot(db, { memoryId: memory.id, loc, name: loc, createdBy: userId, ...(channels.length === 0 ? { asDefaultOfAppId: appId } : {}) })).channel.id);
  const worker = await db.worker.create({ data: { appId, agentId: agent.id, name: 'Dorian', slug: 'dorian' } });
  workerId = worker.id;
  sessionId = generateId();
  await db.session.create({ data: { id: sessionId, appId, userId, agentId: agent.id, workerId } });
});
const messages = () => db.node.findMany({ where: { nodeType: 'chat-message', createdByWorkerId: workerId }, orderBy: { seq: 'asc' } });
const counters = () => db.channel.findMany({ where: { id: { in: channels } }, select: { id: true, lastSeq: true, lastMessageAt: true }, orderBy: { id: 'asc' } });

describe('worker admission #2014/#2015', () => {
  it('refuses an exact same-channel duplicate with earlier seq, before rate, without any allocation write', async () => {
    const first = await post('already landed');
    const before = await counters();
    const error = await failure(post('already landed'));
    expect(error.extensions).toMatchObject({ code: 'TEAM_CHAT_DUPLICATE', earlierSeq: first.seq });
    expect(error.message).toContain(`#${first.seq}`);
    expect(await counters()).toEqual(before);
    expect(await messages()).toHaveLength(1);
    expect(await db.agentTeamEvent.count({ where: { type: 'post-limit.exceeded' } })).toBe(0);
  });
  it('admits ten across channels and refuses eleven with one durable rate alarm, no seq advance', async () => {
    for (let i = 0; i < 10; i++) await post(`unique ${i}`, channels[i % 2]);
    const before = await counters();
    for (let i = 0; i < 2; i++) {
      const e = await failure(post(`eleventh ${i}`));
      expect(e.extensions).toMatchObject({ code: 'TEAM_CHAT_RATE_LIMITED', limit: 'minute', max: 10, windowSeconds: 60 });
      expect(e.extensions.retryAfterSeconds).toBeGreaterThan(0);
    }
    expect(await counters()).toEqual(before);
    expect(await messages()).toHaveLength(10);
    expect(await db.agentTeamEvent.findMany({ where: { type: 'post-limit.exceeded' } })).toMatchObject([{ appId, taskId: null, subjectWorkerId: workerId, severity: 'alarm' }]);
  });
  it('serializes concurrent cross-channel posts at ten accepted and one alarm', async () => {
    const results = await Promise.allSettled(Array.from({ length: 14 }, (_, i) => post(`parallel ${i}`, channels[i % 2])));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(10);
    for (const r of results) if (r.status === 'rejected') expect(r.reason.extensions.code).toBe('TEAM_CHAT_RATE_LIMITED');
    expect(await db.agentTeamEvent.count({ where: { type: 'post-limit.exceeded' } })).toBe(1);
  });
  it('compares exact bodies and reply identity; other channel and deleted originals do not block', async () => {
    const first = await post('same');
    await post('same ', channels[0]);
    await post('same', channels[1]);
    await post('same', channels[0], { replyToSeq: first.seq });
    const reply = await post('reply', channels[0], { replyToSeq: first.seq });
    expect((await failure(post('reply', channels[0], { replyToSeq: first.seq }))).extensions.earlierSeq).toBe(reply.seq);
    await db.node.update({ where: { id: first.nodeId }, data: { deletedAt: new Date() } });
    await post('same');
  });
});
