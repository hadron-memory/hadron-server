/** Worker post admission: #2014/#2015, through the real shared resolver. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { createServer } from '../../../server.js';
import { mintUserApiKey } from '../../../middleware/auth.js';
import * as admission from '../../../lib/chatPostAdmission.js';
import { observeTransactionBackend, waitForAdvisoryWaiter } from '../../../test/advisoryWaiter.js';
import { wakeDueOwners } from '../../../lib/agentTasks/stall.js';

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
  vi.restoreAllMocks();
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
  for (const loc of ['chats:team', 'ops']) channels.push((await ensureChannelWithRoot(db, { memoryId: memory.id, loc, name: loc, createdBy: userId, ...(channels.length === 0 ? { asDefaultOfAppId: appId } : {}) })).channel.id);
  const worker = await db.worker.create({ data: { appId, agentId: agent.id, name: 'Dorian', slug: 'dorian' } });
  workerId = worker.id;
  sessionId = generateId();
  await db.session.create({ data: { id: sessionId, appId, userId, agentId: agent.id, workerId } });
});
const messages = () => db.node.findMany({ where: { nodeType: 'chat-message', createdByWorkerId: workerId }, orderBy: { seq: 'asc' } });
const counters = () => db.channel.findMany({ where: { id: { in: channels } }, select: { id: true, lastSeq: true, lastMessageAt: true, chatRoot: { select: { data: true } } }, orderBy: { id: 'asc' } });

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

/** Seed accepted history at a controlled time without waiting an hour or bypassing the next real admission. */
async function seedHistory(count: number, at: Date) {
  const first = await post('seed');
  const base = await db.node.findUniqueOrThrow({ where: { id: first.nodeId } });
  await db.node.update({ where: { id: base.id }, data: { createdAt: at } });
  await db.node.createMany({ data: Array.from({ length: count - 1 }, (_, i) => ({
    id: generateId(), memoryId: base.memoryId, messageChannelId: channels[0],
    loc: `${base.loc}-history-${i}`, name: `history ${i}`, nodeType: 'chat-message',
    seq: i + 2, content: `history ${i}`, createdByWorkerId: workerId, createdAt: at,
  })) });
  return base;
}

describe('cutoffs, identity, atomicity and clocks', () => {
  const at = new Date('2030-01-01T12:00:00.000Z');
  it('60/61 rolling hour; exact hour boundary frees capacity', async () => {
    await seedHistory(60, new Date(at.getTime() - 120_000));
    vi.spyOn(admission, 'chatPostAdmissionTime').mockResolvedValue(at);
    const e = await failure(post('sixty first'));
    expect(e.extensions).toMatchObject({ code: 'TEAM_CHAT_RATE_LIMITED', limit: 'hour', max: 60, retryAfterSeconds: 3480 });
    vi.spyOn(admission, 'chatPostAdmissionTime').mockResolvedValue(new Date(at.getTime() + 3_480_000));
    await post('at exact hour cutoff');
  });
  it('counts a 59.999s post, excludes exact 60s, and persists admission time', async () => {
    await seedHistory(10, new Date(at.getTime() - 59_999));
    vi.spyOn(admission, 'chatPostAdmissionTime').mockResolvedValue(at);
    expect((await failure(post('blocked'))).extensions.code).toBe('TEAM_CHAT_RATE_LIMITED');
    vi.spyOn(admission, 'chatPostAdmissionTime').mockResolvedValue(new Date(at.getTime() + 1));
    const accepted = await post('cutoff');
    expect(accepted.at).toEqual(new Date(at.getTime() + 1));
    expect((await db.node.findUniqueOrThrow({ where: { id: accepted.nodeId } })).createdAt).toEqual(accepted.at);
  });
  it('duplicate exact ten-minute cutoff, newer duplicate, and quota precedence', async () => {
    const first = await post('exact duplicate');
    await db.node.update({ where: { id: first.nodeId }, data: { createdAt: new Date(at.getTime() - 600_000) } });
    vi.spyOn(admission, 'chatPostAdmissionTime').mockResolvedValue(at);
    await post('exact duplicate');
    expect((await failure(post('exact duplicate'))).extensions.code).toBe('TEAM_CHAT_DUPLICATE');
    for (let i = 0; i < 9; i++) await post(`quota ${i}`);
    expect((await failure(post('exact duplicate'))).extensions.code).toBe('TEAM_CHAT_DUPLICATE');
    expect(await db.workerPostLimitEpisode.count()).toBe(0);
  });
  it('worker count survives rebinding; genuine explicit human and system posts remain outside worker guards', async () => {
    for (let i = 0; i < 10; i++) await post(`bound ${i}`);
    const previous = await db.session.findUniqueOrThrow({ where: { id: sessionId } });
    sessionId = generateId();
    await db.session.create({ data: { id: sessionId, appId, agentId: previous.agentId, userId, workerId } });
    expect((await failure(post('new session'))).extensions.code).toBe('TEAM_CHAT_RATE_LIMITED');
    for (let i = 0; i < 12; i++) await M.createChannelMessage({}, { channelRef: channels[0], body: 'human repeat', asMe: true }, ctx());
    const { postSystemNotice } = await import('./resolvers.teamChat.js');
    expect(await postSystemNotice(db, appId, 'system')).toBe(true);
    expect(await db.agentTeamEvent.count({ where: { type: 'post-limit.exceeded' } })).toBe(1);
  });
  it('duplicate candidates never disclose a prior seq to a foreign or ended-session caller', async () => {
    await post('private prior');
    const foreign = await db.user.create({ data: { githubId: 201402, githubUsername: 'foreign', handle: 'foreign', roles: ['READER'] } });
    const e = await failure(M.createChannelMessage({}, { channelRef: channels[0], body: 'private prior', sessionRef: sessionId }, { ...ctx(), userId: foreign.id }));
    expect(e.extensions.code).not.toBe('TEAM_CHAT_DUPLICATE');
    expect(e.extensions.earlierSeq).toBeUndefined();
    await db.session.update({ where: { id: sessionId }, data: { endedAt: new Date() } });
    expect((await failure(post('private prior'))).extensions.code).toBe('SESSION_ENDED');
  });
  it('real worker lock wait stamps the accepted row after release, not transaction start', async () => {
    let unlock!: () => void, locked!: () => void;
    const held = new Promise<void>(r => { locked = r; });
    const release = new Promise<void>(r => { unlock = r; });
    const holder = db.$transaction(async tx => { await admission.lockChatPostWorker(tx, workerId); locked(); await release; }, { timeout: 10_000 });
    await held;
    const observed = observeTransactionBackend(db);
    const operation = M.createChannelMessage({}, { channelRef: channels[0], body: 'after wait', sessionRef: sessionId }, { ...ctx(), db: observed.db });
    const pid = await observed.backendFor(operation);
    let releasedAt: Date;
    try {
      await waitForAdvisoryWaiter(db, { pid, key: { form: 'hashed-bigint', value: `chat-post-limit:${workerId}` } });
      await db.$executeRaw`SELECT pg_sleep(1.5)`;
      const [row] = await db.$queryRaw<{ at: Date }[]>`SELECT date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC') AS at`;
      releasedAt = row!.at;
    } finally { unlock(); }
    await holder;
    const result = await operation;
    expect(result.at.getTime()).toBeGreaterThanOrEqual(releasedAt!.getTime());
  });
  it('alarm insert failure rolls everything back; retry creates the durable episode/event/schedule once', async () => {
    for (let i = 0; i < 10; i++) await post(`failure ${i}`);
    const before = await counters();
    await db.$executeRawUnsafe(`CREATE FUNCTION fail_rate_alarm_2014() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type = 'post-limit.exceeded' THEN RAISE EXCEPTION 'injected rate alarm failure'; END IF; RETURN NEW; END $$`);
    await db.$executeRawUnsafe('CREATE TRIGGER fail_rate_alarm_2014 BEFORE INSERT ON agent_team_events FOR EACH ROW EXECUTE FUNCTION fail_rate_alarm_2014()');
    try { await expect(post('fault')).rejects.toThrow('injected rate alarm failure'); }
    finally { await db.$executeRawUnsafe('DROP TRIGGER fail_rate_alarm_2014 ON agent_team_events'); await db.$executeRawUnsafe('DROP FUNCTION fail_rate_alarm_2014()'); }
    expect(await db.workerPostLimitEpisode.count()).toBe(0);
    expect(await db.agentTeamEvent.count({ where: { type: 'post-limit.exceeded' } })).toBe(0);
    expect(await counters()).toEqual(before);
    expect((await failure(post('retry'))).extensions.code).toBe('TEAM_CHAT_RATE_LIMITED');
    expect(await db.workerPostLimitEpisode.count()).toBe(1);
    expect(await db.agentTeamAlarmSchedule.count()).toBeGreaterThan(0);
  });
  it('two concurrent identical posts admit one; changing worker does not share quota', async () => {
    const posts = await Promise.allSettled([post('one copy'), post('one copy')]);
    expect(posts.filter(p => p.status === 'fulfilled')).toHaveLength(1);
    expect((posts.find(p => p.status === 'rejected') as PromiseRejectedResult).reason.extensions.code).toBe('TEAM_CHAT_DUPLICATE');
    const worker = await db.worker.findUniqueOrThrow({ where: { id: workerId } });
    for (let i = 0; i < 9; i++) await post(`worker quota ${i}`);
    const other = await db.worker.create({ data: { appId, agentId: worker.agentId, name: 'Independent', slug: 'independent' } });
    const session = await db.session.create({ data: { id: generateId(), appId, userId, agentId: worker.agentId, workerId: other.id } });
    await post('independent quota', channels[1], { sessionRef: session.id });
  });
  it('a refusal after episode/event insertion rolls back the complete transaction and retries durably', async () => {
    for (let i = 0; i < 10; i++) await post(`schedule failure ${i}`);
    const before = await counters();
    await db.$executeRawUnsafe(`CREATE FUNCTION fail_rate_schedule_2014() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected schedule abort'; END $$`);
    await db.$executeRawUnsafe('CREATE TRIGGER fail_rate_schedule_2014 BEFORE INSERT ON agent_team_alarm_schedule FOR EACH ROW EXECUTE FUNCTION fail_rate_schedule_2014()');
    try { await expect(post('before commit abort')).rejects.toThrow('injected schedule abort'); }
    finally { await db.$executeRawUnsafe('DROP TRIGGER fail_rate_schedule_2014 ON agent_team_alarm_schedule'); await db.$executeRawUnsafe('DROP FUNCTION fail_rate_schedule_2014()'); }
    expect(await db.workerPostLimitEpisode.count()).toBe(0);
    expect(await db.agentTeamEvent.count({ where: { type: 'post-limit.exceeded' } })).toBe(0);
    expect(await counters()).toEqual(before);
    expect((await failure(post('after abort retry'))).extensions.code).toBe('TEAM_CHAT_RATE_LIMITED');
    expect(await db.workerPostLimitEpisode.count()).toBe(1);
  });
  it('a new rate episode starts exactly one hour after the prior refusal, not on every attempt', async () => {
    await seedHistory(10, at);
    vi.spyOn(admission, 'chatPostAdmissionTime').mockResolvedValue(at);
    await failure(post('first episode'));
    await failure(post('same episode'));
    expect(await db.workerPostLimitEpisode.count()).toBe(1);
    const later = new Date(at.getTime() + 3_600_000);
    await db.node.updateMany({ where: { nodeType: 'chat-message', createdByWorkerId: workerId }, data: { createdAt: later } });
    vi.spyOn(admission, 'chatPostAdmissionTime').mockResolvedValue(later);
    await failure(post('next episode'));
    expect(await db.workerPostLimitEpisode.count()).toBe(2);
    expect(await db.agentTeamEvent.count({ where: { type: 'post-limit.exceeded' } })).toBe(2);
  });
  it('same worker posting to another App keeps global quota and owns its alarm in the original App', async () => {
    for (let i = 0; i < 10; i++) await post(`global ${i}`);
    const app = await db.app.findUniqueOrThrow({ where: { id: appId } });
    const otherApp = await db.app.create({ data: { name: 'Other', urn: 'admission2014.example:other', organizationId: app.organizationId } });
    const memory = await db.memory.create({ data: { name: 'other shared', urn: 'admission2014.example:other-shared', class: 'app', appId: otherApp.id, organizationId: app.organizationId } });
    const target = await ensureChannelWithRoot(db, { memoryId: memory.id, loc: 'other', name: 'other', createdBy: userId });
    expect((await failure(post('cross App limited', target.channel.id))).extensions.code).toBe('TEAM_CHAT_RATE_LIMITED');
    const event = await db.agentTeamEvent.findFirstOrThrow({ where: { type: 'post-limit.exceeded' } });
    expect(event.appId).toBe(appId);
    expect(await db.node.count({ where: { memoryId: memory.id, nodeType: 'chat-message' } })).toBe(0);
  });
  it('reporting line belongs to worker App, nearest woken now; acknowledgement prevents escalation', async () => {
    const worker = await db.worker.findUniqueOrThrow({ where: { id: workerId } });
    const higher = await db.worker.create({ data: { appId, agentId: worker.agentId, name: 'Higher', slug: 'higher' } });
    const head = await db.worker.create({ data: { appId, agentId: worker.agentId, name: 'Head', slug: 'head', reportsToWorkerId: higher.id } });
    await db.worker.update({ where: { id: workerId }, data: { reportsToWorkerId: head.id } });
    for (let i = 0; i < 10; i++) await post(`chain ${i}`);
    await failure(post('chain limited'));
    const event = await db.agentTeamEvent.findFirstOrThrow({ where: { type: 'post-limit.exceeded' } });
    expect(event.chain).toEqual([{ workerId: head.id }, { workerId: higher.id }]);
    const scheduled = await db.agentTeamAlarmSchedule.findMany({ where: { eventId: event.id }, orderBy: { chainIndex: 'asc' } });
    expect(scheduled[0]!.wokenAt).not.toBeNull(); expect(scheduled[1]!.wokenAt).toBeNull();
    await M.acknowledgeAlarm({}, { eventId: event.id }, ctx());
    expect(await wakeDueOwners(db, new Date(event.createdAt.getTime() + 3_600_000))).toBe(0);
  });
});

describe('exact alarm constraint and migration parity', () => {
  it('replays only the two subject-bound task-less types; rejects unrelated hyphenated first atoms and generic null-task episodes', async () => {
    const source = readFileSync('prisma/chat-post-invariants.sql', 'utf8');
    expect(readFileSync('prisma/migrations/20261019050000_worker_chat_post_admission/migration.sql', 'utf8').endsWith(source)).toBe(true);
    const base = { appId, severity: 'alarm', chain: [], subjectWorkerId: workerId, episodeStart: new Date() };
    for (const type of ['post-limit.exceeded', 'delivery.stuck']) await expect(db.agentTeamEvent.create({ data: { ...base, type } })).resolves.toMatchObject({ type });
    for (const data of [{ appId, type: 'other-limit.exceeded' }, { ...base, type: 'other-limit.exceeded' }, { ...base, type: 'task.created' }, { ...base, type: 'post-limit.exceeded', subjectWorkerId: null }]) await expect(db.agentTeamEvent.create({ data })).rejects.toThrow(/chk_agent_team_events_(shape|episode)/);
  });
});

let server: Server, baseUrl: string;
beforeAll(async () => {
  server = httpServer(await createServer());
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>(r => server.close(() => r())); });

describe('real GraphQL and MCP post refusals', () => {
  async function bearer() { return (await mintUserApiKey(db, { userId, label: null, createdBy: userId, issuedVia: 'test' })).rawKey; }
  it('GraphQL team and named-Channel paths share limits, typed fields, and no allocation on refusal', async () => {
    const token = await bearer();
    const send = async (body: string) => (await fetch(`${baseUrl}/graphql`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ query: 'mutation($c: ID!, $s: ID!, $b: String!) { createChannelMessage(channelRef:$c,sessionRef:$s,body:$b) { seq } }', variables: { c: channels[0], s: sessionId, b: body } }) })).json() as Promise<any>;
    expect((await send('wire first')).data.createChannelMessage.seq).toBe(1);
    expect((await send('wire first')).errors[0].extensions).toMatchObject({ code: 'TEAM_CHAT_DUPLICATE', earlierSeq: 1 });
    for (let i = 0; i < 9; i++) await M.createTeamChatMessage({}, { appRef: appId, body: `team ${i}`, sessionRef: sessionId }, ctx());
    const before = await counters();
    expect((await send('wire limit')).errors[0].extensions).toMatchObject({ code: 'TEAM_CHAT_RATE_LIMITED', max: 10 });
    expect(await counters()).toEqual(before);
  });
  it('MCP keeps actionable earlier-seq and reset text on both post tools, without extension-dependent rendering', async () => {
    const token = await bearer();
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    const init = await fetch(`${baseUrl}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'admission2014', version: '1' } } }) });
    const connection = init.headers.get('mcp-session-id')!;
    let id = 10;
    const call = async (name: string, args: Record<string, unknown>) => (await fetch(`${baseUrl}/mcp`, { method: 'POST', headers: { ...headers, 'mcp-session-id': connection }, body: JSON.stringify({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } }) })).text();
    await post('MCP prior');
    const duplicate = await call('hadron_team_chat_post', { app: appId, body: 'MCP prior', session: sessionId });
    expect(duplicate).toContain('[team_chat_duplicate]'); expect(duplicate).toContain('#1'); expect(duplicate).toContain('Do not retry');
    for (let i = 0; i < 9; i++) await post(`MCP fill ${i}`);
    const rate = await call('hadron_channel_post', { channel: channels[0], body: 'MCP limited', session: sessionId });
    expect(rate).toContain('[team_chat_rate_limited]'); expect(rate).toContain('10 per 60 seconds'); expect(rate).toContain('Retry after');
  });
});
