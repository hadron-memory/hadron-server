/** #2123: real mounted MCP requests, synthetic credentials and private test DB. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../server.js';
import { signJwt } from '../auth/jwt.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { ensureChannelWithRoot } from '../lib/channels.js';
import { appendChatMessage } from '../lib/chatRoot.js';
import { getMemoryEncryptionInfo } from '../lib/nodeCrypto.js';
import { generateId } from '../lib/id.js';
import { APP_KEY_PREFIX, hashAppKey } from '../middleware/auth.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';

let server: Server;
let baseUrl: string;
let token: string;
let workerId: string;
let appId: string;
let userId: string;
let agentId: string;
const opened: Array<{ id: string; token: string }> = [];

beforeAll(async () => {
  server = createHttpServer(await createServer());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  for (const transport of opened.splice(0)) {
    const response = await fetch(`${baseUrl}/mcp`, { method: 'DELETE', headers: {
      accept: 'application/json, text/event-stream', authorization: `Bearer ${transport.token}`, 'mcp-session-id': transport.id,
    } });
    await response.text();
  }
});
afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>(resolve => server.close(() => resolve()));
});
beforeEach(async () => {
  await cleanDb(db);
  const suffix = generateId();
  const user = await db.user.create({ data: { githubId: 2123001, githubUsername: `session-${suffix}`, handle: `session-${suffix}`, roles: ['READER'] } });
  userId = user.id;
  const org = await db.organization.create({ data: { name: 'Session headers', urn: `session-${suffix}.test` } });
  await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'ADMIN' } });
  const app = await db.app.create({ data: { name: 'Team', urn: `${org.urn}:team`, organizationId: org.id } });
  appId = app.id;
  await db.appMember.create({ data: { appId, userId, role: 'owner' } });
  const agent = await db.agent.create({ data: { name: 'Engineer', urn: `${org.urn}:engineer`, organizationId: org.id, visibility: 'ORGANIZATION' } });
  agentId = agent.id;
  await db.appAgent.create({ data: { appId, agentId } });
  workerId = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId, agentId: agent.id,
    name: 'Fixture', slug: 'fixture', heldByUserId: userId, heldAt: new Date() } })).id;
  token = await signJwt({ sub: userId, githubId: 2123001, githubUsername: `session-${suffix}`, roles: ['READER'] });
});

let rpc = 1;
async function post(body: unknown, transport?: string, session?: string, bearer = token) {
  return fetch(`${baseUrl}/mcp`, { method: 'POST', headers: {
    accept: 'application/json, text/event-stream', 'content-type': 'application/json', authorization: `Bearer ${bearer}`,
    ...(transport ? { 'mcp-session-id': transport } : {}), ...(session ? { 'x-hadron-session': session } : {}),
  }, body: JSON.stringify(body) });
}
async function open(session?: string, bearer = token) {
  const response = await post({ jsonrpc: '2.0', id: rpc++, method: 'initialize', params: {
    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'session2123', version: '1' },
  } }, undefined, session, bearer);
  expect(response.status).toBe(200);
  await response.text();
  const id = response.headers.get('mcp-session-id')!;
  expect(id).toBeTruthy();
  opened.push({ id, token: bearer });
  const initialized = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, id, session, bearer);
  await initialized.text();
  return id;
}
async function call(transport: string, name: string, args: Record<string, unknown>, session?: string, bearer = token) {
  const response = await post({ jsonrpc: '2.0', id: rpc++, method: 'tools/call', params: { name, arguments: args } }, transport, session, bearer);
  const raw = await response.text();
  if (response.status !== 200) return { status: response.status, result: null, text: raw };
  const body = JSON.parse(raw.split('\n').find(line => line.startsWith('data:'))?.slice(5) ?? raw);
  return { status: response.status, result: body.result, text: body.result?.content?.[0]?.text ?? '' };
}
const edit = (transport: string, signature: string, session?: string, namedSession?: string) =>
  call(transport, 'hadron_update_worker', { workerRef: workerId, signature, ...(namedSession ? { session: namedSession } : {}) }, session);


describe('#2123 request-local session refusal', () => {
  it('a late unknown session refuses a user-manager edit after a clean initialize', async () => {
    const transport = await open();
    const allowed = await edit(transport, 'human manager control');
    expect(allowed.result?.isError).not.toBe(true);
    expect(await db.worker.findUniqueOrThrow({ where: { id: workerId } })).toMatchObject({ signature: 'human manager control' });
    const denied = await edit(transport, 'must not commit', generateId());
    expect(denied.status).toBe(200);
    expect(await db.worker.findUniqueOrThrow({ where: { id: workerId } })).toMatchObject({ signature: 'human manager control' });
    expect(denied.text).toBe('Error: You are not authorized to manage workers in this App.');
  });

  it.each(['initial bound', 'late bound', 'bound then omitted', 'initial invalid then omitted', 'initial invalid then valid', 'bound then plain header'])(
    '%s cannot become an unbound human-manager edit', async scenario => {
      const bound = await db.session.create({ data: { id: generateId(), appId, userId, workerId, agentId } });
      const plain = await db.session.create({ data: { id: generateId(), appId, userId } });
      const initial = scenario.startsWith('initial invalid') ? generateId() : scenario === 'late bound' ? undefined : bound.id;
      const transport = await open(initial);
      const current = scenario === 'initial bound' || scenario === 'late bound' ? bound.id
        : scenario === 'initial invalid then valid' || scenario === 'bound then plain header' ? plain.id : undefined;
      const before = await db.worker.findUniqueOrThrow({ where: { id: workerId } });
      const denied = await edit(transport, 'must not commit', current);
      expect(denied.status).toBe(200);
      expect(denied.text).toBe('Error: You are not authorized to manage workers in this App.');
      expect(await db.worker.findUniqueOrThrow({ where: { id: workerId } })).toMatchObject({
        signature: before.signature, trailer: before.trailer,
      });
    },
  );


  it.each(['task', 'ticker', 'stop'] as const)('%s write honors late and sticky invalid headers while authorized controls write', async kind => {
    const plain = await db.session.create({ data: { id: generateId(), appId, userId } });
    const transport = await open();
    const run = async (name: string, header?: string, connection = transport) => {
      if (kind === 'task') return call(connection, 'hadron_task_create', { appRef: appId, title: name, session: plain.id }, header);
      if (kind === 'ticker') return call(connection, 'hadron_ticker_create', { appRef: appId, name, cadenceSeconds: 600, session: plain.id }, header);
      // A synthetic already-recorded signal exercises lift without enabling
      // the unavailable notice lane or claiming a set-signal activation.
      const signal = await db.teamStopSignal.create({ data: { id: generateId(), appId, level: 'pause-dispatch', scope: 'worker',
        targetWorkerId: workerId, setAt: new Date(), setByUserId: userId } });
      return call(connection, 'hadron_stop_signal_lift', { appRef: appId, id: signal.id, session: plain.id }, header);
    };
    const count = () => kind === 'task' ? db.agentTask.count({ where: { handle: { not: 'AT0' } } }) : kind === 'ticker' ? db.ticker.count()
      : db.teamStopSignal.count({ where: { endedAt: { not: null } } });
    const allowed = await run('Control');
    expect(allowed.result?.isError).not.toBe(true);
    expect(await count()).toBe(1);
    const denied = await run('Late invalid', generateId());
    expect(denied.text).toMatch(/^\[session_not_bound\]/);
    expect(await count()).toBe(1);
    const sticky = await open(generateId());
    const deniedSticky = await run('Sticky invalid', plain.id, sticky);
    expect(deniedSticky.text).toMatch(/^\[session_not_bound\]/);
    expect(await count()).toBe(1);
    expect((await run('Clean again')).result?.isError).not.toBe(true);
    expect(await count()).toBe(2);
  });

  it.each(['unknown', 'foreign', 'expired', 'dormant'] as const)('%s late session is refused by every write consumer', async state => {
    const other = await db.user.create({ data: { githubId: 2123002, githubUsername: 'foreign-session', roles: ['READER'] } });
    const old = new Date(Date.now() - 400 * 86400000);
    const bad = state === 'unknown' ? generateId() : (await db.session.create({ data: {
      id: generateId(), appId, userId: state === 'foreign' ? other.id : userId,
      ...(state === 'expired' ? { expiresAt: new Date(0) } : {}),
      ...(state === 'dormant' ? { startedAt: old, updatedAt: old, expiresAt: null } : {}),
    } })).id;
    const plain = await db.session.create({ data: { id: generateId(), appId, userId } });
    const transport = await open();
    expect((await edit(transport, 'denied', bad)).text).toBe('Error: You are not authorized to manage workers in this App.');
    expect((await call(transport, 'hadron_task_create', { appRef: appId, title: 'denied', session: plain.id }, bad)).text).toMatch(/^\[session_not_bound\]/);
    expect((await call(transport, 'hadron_ticker_create', { appRef: appId, name: 'denied', cadenceSeconds: 600, session: plain.id }, bad)).text).toMatch(/^\[session_not_bound\]/);
    const signal = await db.teamStopSignal.create({ data: { id: generateId(), appId, level: 'pause-dispatch', scope: 'worker', targetWorkerId: workerId, setAt: new Date(), setByUserId: userId } });
    expect((await call(transport, 'hadron_stop_signal_lift', { appRef: appId, id: signal.id, session: plain.id }, bad)).text).toMatch(/^\[session_not_bound\]/);
    expect(await db.agentTask.count()).toBe(0);
    expect(await db.ticker.count()).toBe(0);
    expect((await db.teamStopSignal.findUniqueOrThrow({ where: { id: signal.id } })).endedAt).toBeNull();
    expect((await db.worker.findUniqueOrThrow({ where: { id: workerId } })).signature).not.toBe('denied');
  });

  it('App-key N5 stays request-local after an initially refused header across task and ticker reads', async () => {
    const raw = `${APP_KEY_PREFIX}${generateId()}${generateId()}`;
    const key = await db.appKey.create({ data: { id: generateId(), appId, keyHash: hashAppKey(raw), keyPreview: raw.slice(-4) } });
    await db.appKeyScope.create({ data: { id: generateId(), appKeyId: key.id, scope: 'attention:deliver', grantedByUserId: userId } });
    const plain = await db.session.create({ data: { id: generateId(), appId } });
    for (const tool of ['hadron_task_list', 'hadron_due_wakes']) {
      const connection = await open(undefined, raw);
      const invoke = (header?: string, transport = connection) => call(transport, tool, { appRef: appId }, header, raw);
      expect((await invoke()).result?.isError).not.toBe(true);
      expect((await invoke(plain.id)).text).toMatch(/^\[app_key_session_bound\]/);
      expect((await invoke(generateId())).text).toMatch(/^\[app_key_session_bound\]/);
      expect((await invoke()).result?.isError).not.toBe(true); // a clean request recovers
      const sticky = await open(generateId(), raw);
      expect((await invoke(undefined, sticky)).result?.isError).not.toBe(true);
      expect((await invoke(plain.id, sticky)).text).toMatch(/^\[app_key_session_bound\]/);
    }
  });


  it('self inbox header-only calls preserve late and initial refusal', async () => {
    const bound = await db.session.create({ data: { id: generateId(), appId, userId, workerId, agentId } });
    const clean = await open();
    const args = { appRef: appId };
    const allowed = await call(clean, 'hadron_team_chat_inbox', args, bound.id);
    expect(allowed.status).toBe(200);
    expect(JSON.parse(allowed.text).batches).toEqual([]);
    const denied = await call(clean, 'hadron_team_chat_inbox', args, generateId());
    expect(denied.result?.isError).toBe(true);
    expect(denied.text).toMatch(/^\[session_(not_found|not_live)\]/);
    const sticky = await open(generateId());
    const deniedSticky = await call(sticky, 'hadron_team_chat_inbox', args, bound.id);
    expect(deniedSticky.result?.isError).toBe(true);
    expect(deniedSticky.text).toMatch(/^\[session_(not_found|not_live)\]/);
  });

  it('S1 explicit-body read and ack preserve validation, refusal floors and delivery atomicity', async () => {
    const bound = await db.session.create({ data: { id: generateId(), appId, userId, workerId, agentId } });
    const app = await db.app.findUniqueOrThrow({ where: { id: appId } });
    const org = await db.organization.findUniqueOrThrow({ where: { id: app.organizationId! } });
    const memory = await db.memory.create({ data: { urn: `${org.urn}:inbox-shared`, name: 'Shared', class: 'app',
      organizationId: org.id, appId, sharedMemoryOfAgentId: agentId } });
    const made = await ensureChannelWithRoot(db, { memoryId: memory.id, loc: 'chats:team', name: 'Team', createdBy: userId });
    await db.registerEntry.create({ data: { id: generateId(), appId, channelId: made.channel.id, attendeeWorkerId: workerId, role: 'BOTH' } });
    const enc = await getMemoryEncryptionInfo(db, memory.id);
    await appendChatMessage(db, { id: made.rootId, memoryId: memory.id, loc: 'chats:team' }, enc,
      async ({ tx, seq, msgNum }) => tx.node.create({ data: { id: generateId(), memoryId: memory.id,
        loc: `chats:team:messages:${msgNum}`, name: msgNum, nodeType: 'chat-message', seq,
        messageChannelId: made.channel.id, content: 'Synthetic mention for @fixture', data: { mentions: ['fixture'], authorName: 'Manager' } } }),
      { asChannel: true });
    await db.node.updateMany({ where: { messageChannelId: made.channel.id }, data: { createdAt: new Date(Date.now() - 3600_000) } });
    const connection = await open(generateId());
    const inbox = (session?: string) => call(connection, 'hadron_team_chat_inbox', { appRef: appId, ...(session ? { session } : {}) }, bound.id);
    const result = await inbox(bound.id);
    expect(result.result?.isError).not.toBe(true);
    const batches = JSON.parse(result.text).batches;
    expect(batches.length).toBe(1);
    expect(batches[0].workerId).toBe(workerId);
    const proof = batches[0].id as string;
    const ack = (session?: string) => call(connection, 'hadron_team_chat_inbox_ack', { batchIds: [proof], ...(session ? { session } : {}) }, bound.id);
    const foreign = await db.user.create({ data: { githubId: 2123004, githubUsername: 'other-inbox', roles: ['READER'] } });
    const old = new Date(Date.now() - 400 * 86400000);
    const badSessions: Array<string | undefined> = [undefined, generateId()];
    for (const kind of ['foreign', 'ended', 'expired', 'dormant']) {
      const bad = await db.session.create({ data: { id: generateId(), appId, agentId, workerId,
        userId: kind === 'foreign' ? foreign.id : userId,
        ...(kind === 'ended' ? { endedAt: new Date() } : {}),
        ...(kind === 'expired' ? { expiresAt: new Date(0) } : {}),
        ...(kind === 'dormant' ? { startedAt: old, updatedAt: old, expiresAt: null } : {}),
      } });
      badSessions.push(bad.id);
    }
    for (const bad of badSessions) {
      const refusedRead = await inbox(bad);
      expect(refusedRead.result?.isError).toBe(true);
      expect(refusedRead.text).toMatch(/^\[session_(not_bound|not_found|not_live)\]/);
      const refusedAck = await ack(bad);
      expect(refusedAck.result?.isError).toBe(true);
      expect(refusedAck.text).toMatch(/^\[session_(required|not_bound|not_found|not_live)\]/);
      expect(await db.workerDeliveryChannel.count()).toBe(0);
      expect(await db.workerWakeAck.count()).toBe(0);
      expect((await db.channelReadState.findFirstOrThrow({ where: { workerId, channelId: made.channel.id } })).lastSeenSeq).toBe(0);
    }
    expect((await ack(bound.id)).text).toBe('Acknowledged 1.');
    expect(await db.workerDeliveryChannel.count()).toBe(1);
    expect((await db.channelReadState.findFirstOrThrow({ where: { workerId, channelId: made.channel.id } })).lastSeenSeq).toBe(0);
    // The local explicit-body override must not mutate the connection's
    // sticky refusal or let the next header-only request use that authority.
    expect((await inbox()).text).toMatch(/^\[session_(not_found|not_live)\]/);
  });

  it('queued requests keep their own bearer/header decision through real dispatch', async () => {
    const plain = await db.session.create({ data: { id: generateId(), appId, userId } });
    const other = await db.user.create({ data: { githubId: 2123003, githubUsername: 'other-principal', roles: ['READER'] } });
    const otherToken = await signJwt({ sub: other.id, githubId: 2123003, githubUsername: 'other-principal', roles: ['READER'] });
    const transport = await open();
    const badHeader = generateId();
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    let blocked = false;
    const original = db.session.updateMany.bind(db.session);
    // The real first tool is suspended in heartbeat, after request auth was
    // refreshed and before it builds its management Context. SQL is retained.
    const heartbeat = vi.spyOn(db.session, 'updateMany').mockImplementation((async (args: any) => {
      if (!blocked && args.where.id === plain.id) {
        blocked = true;
        await hold;
      }
      return original(args);
    }) as typeof db.session.updateMany);
    let arrivals = 0;
    const observe = (request: import('node:http').IncomingMessage) => {
      if (request.headers['mcp-session-id'] === transport &&
          (request.headers['x-hadron-session'] === badHeader || request.headers.authorization === `Bearer ${otherToken}`)) arrivals++;
    };
    server.prependListener('request', observe);
    const first = edit(transport, 'first own request', undefined, plain.id);
    let second: ReturnType<typeof edit> | undefined;
    let foreign: ReturnType<typeof call> | undefined;
    try {
      await vi.waitFor(() => expect(blocked).toBe(true), { timeout: 3000, interval: 10 });
      second = edit(transport, 'late invalid must not commit', badHeader, plain.id);
      foreign = call(transport, 'hadron_update_worker', { workerRef: workerId, signature: 'foreign must not commit' }, undefined, otherToken);
      await vi.waitFor(() => expect(arrivals).toBe(2), { timeout: 3000, interval: 10 });
      release();
      expect((await first).text).toMatch(/^Updated/);
      expect((await second).text).toBe('Error: You are not authorized to manage workers in this App.');
      expect((await foreign).status).toBe(404);
      expect(await db.worker.findUniqueOrThrow({ where: { id: workerId } })).toMatchObject({ signature: 'first own request' });
      // A late invalid request is not an INITIAL refusal and cannot poison
      // the following clean request on this same authenticated transport.
      expect((await edit(transport, 'clean next request')).text).toMatch(/^Updated/);
    } finally {
      release();
      await Promise.allSettled([first, ...(second ? [second] : []), ...(foreign ? [foreign] : [])]);
      heartbeat.mockRestore();
      server.removeListener('request', observe);
    }
  });

});
