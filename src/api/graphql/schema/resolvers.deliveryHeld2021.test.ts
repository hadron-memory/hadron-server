/** #2021 held reports: signed descriptor authority, privacy, no delivery effects and atomic events. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { randomBytes } from 'node:crypto';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { idleWindowMsFor } from '../../../lib/sessionActivity.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { APP_KEY_PREFIX, hashAppKey } from '../../../middleware/auth.js';
import { ensureChannelWithRoot } from '../../../lib/channels.js';
import { appendChatMessage } from '../../../lib/chatRoot.js';
import { getMemoryEncryptionInfo } from '../../../lib/nodeCrypto.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;

const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] }) as Context;
async function code(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(GraphQLError);
    return (e as GraphQLError).extensions?.code as string;
  }
  return undefined;
}

let org: { id: string; urn: string };
let app: { id: string; urn: string };
let otherApp: { id: string };
let agentId: string;
let manager: { id: string };
let kit: { id: string; name: string };
let rook: { id: string; name: string };
let channel: { id: string; memoryId: string; loc: string; chatRootNodeId: string };
let hostKey: { id: string };   // attention:deliver + host:operate(orca1)
let otherHostKey: { id: string }; // attention:deliver + host:operate(orca2)
let bareKey: { id: string };   // attention:deliver only
let opOnlyKey: { id: string }; // host:operate only
let foreignKey: { id: string };

const rawKeys = new Map<string, string>();
async function mkKey(appId: string, label: string) {
  const raw = `${APP_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  const key = await db.appKey.create({ data: { id: generateId(), appId, keyHash: hashAppKey(raw), keyPreview: raw.slice(-4), label }, select: { id: true } });
  rawKeys.set(key.id, raw);
  return key;
}
const keyCtx = (k: { id: string }, appId = app.id, extra: Partial<Context> = {}): Context =>
  ({ db, appId, appKeyId: k.id, organizationId: org.id, roles: [], ...extra }) as Context;
const read = (k: { id: string }, extra: Record<string, unknown> = {}, appId = app.id) =>
  Q.deliveryBatches({}, { appRef: appId, ...extra }, keyCtx(k, appId));

async function say(body: string, data: Record<string, unknown> = {}) {
  const enc = await getMemoryEncryptionInfo(db, channel.memoryId);
  return appendChatMessage(db, { id: channel.chatRootNodeId, memoryId: channel.memoryId, loc: channel.loc }, enc, async ({ tx, seq, msgNum }) =>
    tx.node.create({ data: { id: generateId(), memoryId: channel.memoryId, loc: `${channel.loc}:messages:${msgNum}`, name: msgNum, nodeType: 'chat-message', seq, messageChannelId: channel.id, content: body, data: { authorName: 'Ada', mentions: [], ...data } } }),
    { asChannel: true });
}

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { name: 'Batches', urn: `batches-${n}.example` }, select: { id: true, urn: true } });
  manager = await db.user.create({ data: { githubId: 81_000_000 + n, githubUsername: `bt-m-${n}`, roles: ['READER'] }, select: { id: true } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: manager.id, role: 'ADMIN' } });
  agentId = (await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(manager.id))).id;
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` }, select: { id: true, urn: true } });
  otherApp = await db.app.create({ data: { organizationId: org.id, name: 'Other', urn: `${org.urn}:other` }, select: { id: true } });
  kit = await db.worker.create({ data: { appId: app.id, agentId, name: 'Kit', slug: 'kit' }, select: { id: true, name: true } });
  rook = await db.worker.create({ data: { appId: app.id, agentId, name: 'Rook', slug: 'rook' }, select: { id: true, name: true } });
  const memory = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:team-shared`, name: 'shared', class: 'app', appId: app.id, sharedMemoryOfAgentId: agentId } });
  const made = await ensureChannelWithRoot(db, { memoryId: memory.id, loc: 'chats:team', name: 'team', createdBy: manager.id });
  channel = { id: made.channel.id, memoryId: memory.id, loc: 'chats:team', chatRootNodeId: made.rootId };
  for (const w of [kit, rook]) await db.registerEntry.create({ data: { id: generateId(), appId: app.id, channelId: channel.id, attendeeWorkerId: w.id, role: 'BOTH' } });
  hostKey = await mkKey(app.id, 'orca1');
  otherHostKey = await mkKey(app.id, 'orca2');
  bareKey = await mkKey(app.id, 'bare');
  opOnlyKey = await mkKey(app.id, 'op-only');
  foreignKey = await mkKey(otherApp.id, 'foreign');
  const grant = (k: { id: string }, scope: string, hostId?: string) => M.grantAppKeyScope({}, { id: k.id, scope, ...(hostId ? { hostId } : {}) }, ctx(manager.id));
  await grant(hostKey, 'attention:deliver'); await grant(hostKey, 'host:operate', 'orca1');
  await grant(otherHostKey, 'attention:deliver'); await grant(otherHostKey, 'host:operate', 'orca2');
  await grant(bareKey, 'attention:deliver');
  await grant(opOnlyKey, 'host:operate', 'orca1');
  // orca1 launches Kit only; orca2 launches Rook only.
  await M.registerHost({}, { input: { appRef: app.id, label: 'Orca 1', pollIntervalSeconds: 60, workers: [{ worker: kit.id, family: 'claude', worktrees: [] }] } }, keyCtx(hostKey));
  await M.registerHost({}, { input: { appRef: app.id, label: 'Orca 2', pollIntervalSeconds: 60, workers: [{ worker: rook.id, family: 'claude', worktrees: [] }] } }, keyCtx(otherHostKey));
});

// Both workers are mentioned, and the window (the app floor) has long passed.
async function postForBoth() {
  await say('hello @kit and @rook', { mentions: ['kit', 'rook'] });
  await db.node.updateMany({ where: { messageChannelId: channel.id }, data: { createdAt: new Date(Date.now() - 3600_000) } });
}


async function ownSession(data: Record<string, unknown> = {}) {
  return db.session.create({ data: { id: generateId(), appId: app.id, userId: manager.id, workerId: kit.id, agentId, ...data } as any });
}
const selfCtx = (s: { id: string }, extra: Partial<Context> = {}): Context => ({ ...ctx(manager.id), appId: app.id, sessionId: s.id, ...extra });
const selfRead = (s: { id: string }, args: Record<string, unknown> = {}, extra: Partial<Context> = {}) =>
  Q.deliveryBatches({}, { appRef: app.id, ...args }, selfCtx(s, extra));
const selfAck = (s: { id: string }, batchIds: string[], extra: Partial<Context> = {}) =>
  M.acknowledgeDeliveryBatches({}, { batchIds }, selfCtx(s, extra));


const report = (batchId: string, extra: Record<string, unknown> = {}, c: Context = keyCtx(hostKey)) =>
  M.reportDeliveryHold({}, { input: { batchId, reason: 'draft', terminalId: 'term_test', ...extra } }, c);
const batch = async () => { await postForBoth(); return (await read(hostKey)).batches[0]; };
const effects = async () => ({ delivered: await db.workerDeliveryChannel.count(), read: await db.channelReadState.count(),
  ticks: await db.workerDeliveryTick.count(), reservations: await db.appWakeReservation.count(),
  spend: await db.appWakeDay.count(), policy: await db.workerDeliveryWaitState.count(), exceptions: await db.workerDeliveryWaitException.count() });

it('accepts one signed batch id; duplicate observation retains id/since and appends no second held event', async () => {
  const b = await batch(), before = await effects();
  const result = await report(b.id);
  expect(result).toMatchObject({ workerId: kit.id, pageInfo: { hasNextPage: false, endCursor: null } });
  expect(result.holds).toHaveLength(1);
  expect(result.holds[0]).toMatchObject({ channelId: channel.id, channelIncarnation: 1, firstPendingSeq: b.ranges[0].seqs[0], reason: 'draft', terminalId: 'term_test' });
  const again = await report(b.id);
  expect(again.holds[0]).toEqual(result.holds[0]);
  expect(await db.agentTeamEvent.count({ where: { type: 'delivery.held' } })).toBe(1);
  expect(await db.agentTeamEvent.count({ where: { type: 'delivery.resumed' } })).toBe(0);
  expect(await effects()).toEqual(before);
  expect(JSON.stringify(result)).not.toContain(b.id);
  expect(JSON.stringify(result)).not.toMatch(/principal|appKeyId|renderHash|replacement/);
});
it('reason/terminal changes retain identity and append only allowlisted metadata', async () => {
  const b = await batch(); const first = await report(b.id);
  const next = await report(b.id, { reason: 'question', terminalId: null });
  expect(next.holds[0]).toMatchObject({ holdId: first.holds[0].holdId, since: first.holds[0].since, reason: 'question', terminalId: null });
  expect(await db.agentTeamEvent.count({ where: { type: 'delivery.held' } })).toBe(2);
});
it.each([
  { proof: 'SECRET' }, { draft: 'SECRET' }, { workerId: 'SECRET' }, { since: 'SECRET' },
  { reason: 'SECRET' }, { terminalId: 'SECRET\nbody' }, { terminalId: 'term_' + 'x'.repeat(129) }, { terminalId: 42 },
])('rejects untrusted report metadata without echo or writes: %j', async extra => {
  const b = await batch(), before = await effects();
  try { await report(b.id, extra); throw new Error('accepted'); }
  catch (e) { expect(e).toBeInstanceOf(GraphQLError); expect((e as GraphQLError).extensions.code).toBe('BAD_USER_INPUT'); expect((e as Error).message).not.toContain('SECRET'); }
  expect(await db.workerDeliveryHold.count()).toBe(0); expect(await db.agentTeamEvent.count({ where: { type: { in: ['delivery.held', 'delivery.resumed', 'delivery.stuck'] } } })).toBe(0); expect(await effects()).toEqual(before);
});
it.each(['forged', 'identity', 'future', 'expired'])('refuses %s descriptors without effects', async kind => {
  const b = await batch(); const { verifyBatchProof, signBatchProof } = await import('../../../lib/tickers/wakeProof.js');
  const p = verifyBatchProof(b.id); let token = b.id;
  if (kind === 'forged') token = b.id + 'x';
  if (kind === 'identity') token = p.batchKey;
  if (kind === 'future') token = signBatchProof({ ...p, issuedAt: Date.now()+60_000 });
  if (kind === 'expired') token = signBatchProof({ ...p, issuedAt: Date.now()-16*60_000 });
  expect(await code(report(token))).toBe(kind === 'future' || kind === 'expired' ? 'WAKE_PROOF_STALE' : 'WAKE_PROOF_INVALID');
  expect(await db.workerDeliveryHold.count()).toBe(0); expect(await db.agentTeamEvent.count({ where: { type: { in: ['delivery.held', 'delivery.resumed', 'delivery.stuck'] } } })).toBe(0);
});
it('refuses another key, foreign App key, bare scope and another host worker', async () => {
  const b = await batch();
  expect(await code(report(b.id, {}, keyCtx(otherHostKey)))).toBe('WAKE_PROOF_REQUESTER_MISMATCH');
  expect(await code(report(b.id, {}, keyCtx(foreignKey, otherApp.id)))).toBe('WAKE_PROOF_REQUESTER_MISMATCH');
  expect(await code(report(b.id, {}, keyCtx(bareKey)))).toBe('WAKE_PROOF_REQUESTER_MISMATCH');
  await db.hostRegistrationWorker.deleteMany({ where: { workerId: kit.id } });
  expect(await code(report(b.id))).toBe('WAKE_PROOF_REQUESTER_MISMATCH');
  expect(await db.workerDeliveryHold.count()).toBe(0);
});
it.each(['read', 'delivery', 'incarnation', 'encrypted', 'deleted'])('refuses %s-covered/stale channels without an event', async kind => {
  const b = await batch();
  if (kind === 'read') await db.channelReadState.create({ data: { workerId: kit.id, channelId: channel.id, lastSeenSeq: b.ranges[0].throughSeq } });
  if (kind === 'delivery') await db.workerDeliveryChannel.create({ data: { workerId: kit.id, channelId: channel.id, channelIncarnation: 1, deliveredThroughSeq: b.ranges[0].throughSeq, deliveredAt: new Date() } });
  if (kind === 'incarnation') await db.channel.update({ where: { id: channel.id }, data: { incarnation: 2 } });
  if (kind === 'encrypted') await db.memory.update({ where: { id: channel.memoryId }, data: { isEncrypted: true } });
  if (kind === 'deleted') await db.channel.update({ where: { id: channel.id }, data: { deletedAt: new Date() } });
  const before = await effects();
  expect(await code(report(b.id))).toBe('WAKE_PROOF_STALE');
  expect(await db.workerDeliveryHold.count()).toBe(0); expect(await db.agentTeamEvent.count({ where: { type: { in: ['delivery.held', 'delivery.resumed', 'delivery.stuck'] } } })).toBe(0); expect(await effects()).toEqual(before);
});
it('self can report its own unhosted batch, but cannot cross replay host or sibling-session descriptors', async () => {
  const s = await ownSession(); const b = await batch(); const self = (await selfRead(s)).batches[0];
  await db.hostRegistrationWorker.deleteMany({ where: { workerId: kit.id } });
  expect(await code(report(b.id, {}, selfCtx(s)))).toBe('WAKE_PROOF_REQUESTER_MISMATCH');
  expect(await code(report(self.id))).toBe('WAKE_PROOF_REQUESTER_MISMATCH');
  const other = await ownSession();
  expect(await code(report(self.id, {}, selfCtx(other)))).toBe('WAKE_PROOF_REQUESTER_MISMATCH');
  const result = await report(self.id, {}, selfCtx(s)); expect(result.holds).toHaveLength(1);
  const row = await db.workerDeliveryHold.findFirstOrThrow(); expect(row.principal).toEqual({ kind: 'worker', workerId: kit.id, sessionId: s.id });
});
it.each(['ended', 'expired'])('a %s self session cannot report or revive', async kind => {
  const s = await ownSession(); await postForBoth(); const b = (await selfRead(s)).batches[0];
  await db.session.update({ where: { id: s.id }, data: kind === 'ended' ? { endedAt: new Date() } : { expiresAt: new Date(Date.now()-1) } });
  expect(await code(report(b.id, {}, selfCtx(s)))).toBe('SESSION_NOT_LIVE'); expect(await db.workerDeliveryHold.count()).toBe(0);
});
it('MCP delegates self reports and rejects unknown metadata instead of discarding it', async () => {
  const s = await ownSession(); await postForBoth(); const b = (await selfRead(s)).batches[0];
  const { createTestableMcpServer } = await import('../../../mcp/server.js');
  const server = createTestableMcpServer({ userId: manager.id, roles: ['READER'] } as never, { sessionId: `held-${generateId()}`, cachedAppResolution: { kind: 'multi-app' } });
  const bad: any = await server.callTool('hadron_report_delivery_hold', { batchId: b.id, reason: 'draft', session: s.id, proof: 'SECRET' });
  expect(bad.isError).toBe(true); expect(bad.content[0].text).toContain('[bad_user_input]'); expect(bad.content[0].text).not.toContain('SECRET');
  const good: any = await server.callTool('hadron_report_delivery_hold', { batchId: b.id, reason: 'draft', session: s.id });
  expect(good.isError).not.toBe(true); expect(JSON.parse(good.content[0].text).holds).toHaveLength(1);
});

async function secondChannel(name = 'second') {
  const old = channel;
  const made = await ensureChannelWithRoot(db, { memoryId: old.memoryId, loc: `chats:${name}`, name, createdBy: manager.id });
  const next = { id: made.channel.id, memoryId: old.memoryId, loc: `chats:${name}`, chatRootNodeId: made.rootId };
  await db.registerEntry.create({ data: { appId: app.id, channelId: next.id, attendeeWorkerId: kit.id, role: 'BOTH' } });
  channel = next; await postForBoth(); channel = old;
  return next;
}
it('multi-channel reports return every hold atomically within the signed ten-seq hard cap', async () => {
  await postForBoth(); const other = await secondChannel();
  const b = (await read(hostKey)).batches[0]; expect(b.ranges).toHaveLength(2);
  const result = await report(b.id); expect(result.holds).toHaveLength(2);
  expect(new Set(result.holds.map((h: any) => h.channelId))).toEqual(new Set([channel.id, other.id]));
  expect(result.pageInfo).toEqual({ hasNextPage: false, endCursor: null });
  expect(await db.agentTeamEvent.count({ where: { type: 'delivery.held' } })).toBe(2);
});
it('a stale later channel refuses the whole batch with no earlier hold/event/audit', async () => {
  await postForBoth(); const other = await secondChannel(); const b = (await read(hostKey)).batches[0];
  const before = await db.hostKeyUse.count();
  await db.channel.update({ where: { id: other.id }, data: { incarnation: 2 } });
  expect(await code(report(b.id))).toBe('WAKE_PROOF_STALE');
  expect(await db.workerDeliveryHold.count()).toBe(0); expect(await db.agentTeamEvent.count({ where: { type: { in: ['delivery.held', 'delivery.resumed', 'delivery.stuck'] } } })).toBe(0); expect(await db.hostKeyUse.count()).toBe(before);
});
it('a later hold persistence failure rolls back earlier holds/events and host-use audit', async () => {
  await postForBoth(); await secondChannel(); const b = (await read(hostKey)).batches[0];
  const before = await db.hostKeyUse.count();
  const failing = new Proxy(db, { get(target, prop) {
    if (prop === '$transaction') return (fn: any, options: any) => target.$transaction(async tx => {
      let created = 0;
      return fn(new Proxy(tx, { get(t, p) {
        if (p === 'workerDeliveryHold') return new Proxy(t.workerDeliveryHold, { get(delegate, method) {
          if (method === 'create') return async (args: any) => { if (++created === 2) throw new Error('injected hold failure'); return delegate.create(args); };
          return Reflect.get(delegate, method, delegate);
        } });
        return Reflect.get(t, p, t);
      } }));
    }, options);
    return Reflect.get(target, prop, target);
  } });
  await expect(report(b.id, {}, keyCtx(hostKey, app.id, { db: failing }))).rejects.toThrow('injected hold failure');
  expect(await db.workerDeliveryHold.count()).toBe(0); expect(await db.agentTeamEvent.count({ where: { type: { in: ['delivery.held', 'delivery.resumed', 'delivery.stuck'] } } })).toBe(0); expect(await db.hostKeyUse.count()).toBe(before);
});
it.each(['scope', 'self-end', 'incarnation', 'expiry'])('rechecks %s after an authority-lock wait', async kind => {
  const s = await ownSession(); await postForBoth();
  let b = kind === 'self-end' ? (await selfRead(s)).batches[0] : (await read(hostKey)).batches[0];
  if (kind === 'expiry') {
    const { signBatchProof, verifyBatchProof } = await import('../../../lib/tickers/wakeProof.js');
    b = { ...b, id: signBatchProof({ ...verifyBatchProof(b.id), issuedAt: Date.now()-15*60_000+5 }) };
  }
  const { lockAuthorityAnchors } = await import('../../../lib/auth/authorityAnchors.js');
  const { waitForLockWaitersOfType } = await import('../../../test/lockWait.js');
  let release!: () => void, held!: () => void;
  const gate = new Promise<void>(r => { release = r; }), ready = new Promise<void>(r => { held = r; });
  const revoker = db.$transaction(async tx => {
    await lockAuthorityAnchors(tx, [{ kind: 'app', id: app.id }], 'exclusive');
    if (kind === 'scope') await tx.appKeyScope.updateMany({ where: { appKeyId: hostKey.id, scope: 'attention:deliver' }, data: { revokedAt: new Date(), revokedByUserId: manager.id } });
    if (kind === 'self-end') await tx.session.update({ where: { id: s.id }, data: { endedAt: new Date() } });
    if (kind === 'incarnation') await tx.channel.update({ where: { id: channel.id }, data: { incarnation: 2 } });
    held(); await gate;
  }, { timeout: 20_000 });
  await Promise.race([ready, revoker]);
  const result = code(report(b.id, {}, kind === 'self-end' ? selfCtx(s) : keyCtx(hostKey)));
  try { await waitForLockWaitersOfType(db, 'advisory', 1); } finally { release(); await revoker; }
  expect(await result).toBe(kind === 'scope' ? 'APP_KEY_SCOPE_REQUIRED' : kind === 'self-end' ? 'SESSION_NOT_LIVE' : 'WAKE_PROOF_STALE');
  expect(await db.workerDeliveryHold.count()).toBe(0); expect(await db.agentTeamEvent.count({ where: { type: { in: ['delivery.held', 'delivery.resumed', 'delivery.stuck'] } } })).toBe(0);
});
it('the actual MCP SDK preserves unknown keys for sanitized refusal, then accepts the same signed id', async () => {
  const s = await ownSession(); await postForBoth(); const b = (await selfRead(s)).batches[0];
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { registerTickerTools } = await import('../../../mcp/tickerTools.js');
  const server = new McpServer({ name: 'held-test', version: '1' });
  registerTickerTools(server, { db, auth: { userId: manager.id, roles: ['READER'] } as never });
  const client = new Client({ name: 'held-test-client', version: '1' });
  const [a, z] = InMemoryTransport.createLinkedPair();
  await server.connect(z); await client.connect(a);
  try {
    const bad: any = await client.callTool({ name: 'hadron_report_delivery_hold', arguments: { batchId: b.id, reason: 'draft', session: s.id, draft: 'SECRET_DRAFT' } });
    expect(bad.isError).toBe(true); expect(bad.content[0].text).toContain('[bad_user_input]'); expect(bad.content[0].text).not.toContain('SECRET');
    expect(await db.workerDeliveryHold.count()).toBe(0);
    const good: any = await client.callTool({ name: 'hadron_report_delivery_hold', arguments: { batchId: b.id, reason: 'draft', session: s.id } });
    expect(good.isError).not.toBe(true); expect(JSON.parse(good.content[0].text).holds).toHaveLength(1);
  } finally { await client.close(); await server.close(); }
});

it('a retired worker or removed App refuses without exposing an internal transaction error', async () => {
  const b = await batch();
  await db.worker.update({ where: { id: kit.id }, data: { retiredAt: new Date() } });
  expect(await code(report(b.id))).toBe('WAKE_PROOF_STALE');
  expect(await db.workerDeliveryHold.count()).toBe(0);
});
it('GraphQL exposes the same strict typed input and bounded result without a resumed door', async () => {
  const b = await batch();
  const { graphql, buildSchema } = await import('graphql');
  const { typeDefs } = await import('./typeDefs.js');
  const schema = buildSchema(typeDefs);
  const call = (input: unknown) => graphql({ schema, source: 'mutation($input: DeliveryHoldReportInput!) { reportDeliveryHold(input:$input) { workerId holds { holdId channelId reason } pageInfo { hasNextPage endCursor } } }',
    variableValues: { input }, rootValue: { reportDeliveryHold: (args: any) => M.reportDeliveryHold({}, args, keyCtx(hostKey)) } });
  const bad = await call({ batchId: b.id, reason: 'draft', proof: 'SECRET' });
  expect(bad.errors?.length).toBeGreaterThan(0); expect(await db.workerDeliveryHold.count()).toBe(0);


  const good = await call({ batchId: b.id, reason: 'draft' });
  expect(good.errors).toBeUndefined(); expect((good.data as any).reportDeliveryHold.holds).toHaveLength(1);
  expect(schema.getMutationType()?.getFields().reportDeliveryResumed).toBeUndefined();
});
it('another live key on the same host cannot reuse the receiving key proof', async () => {
  const b = await batch(), sibling = await mkKey(app.id, 'same-host');
  await M.grantAppKeyScope({}, { id: sibling.id, scope: 'attention:deliver' }, ctx(manager.id));
  await M.grantAppKeyScope({}, { id: sibling.id, scope: 'host:operate', hostId: 'orca1' }, ctx(manager.id));
  expect(await code(report(b.id, {}, keyCtx(sibling)))).toBe('WAKE_PROOF_REQUESTER_MISMATCH');
  expect(await db.workerDeliveryHold.count()).toBe(0);
});
it('a partially covered rendered descriptor is stale, rather than reporting its old first seq', async () => {
  await postForBoth(); await postForBoth(); const b = (await read(hostKey)).batches[0];
  expect(b.ranges[0].seqs).toHaveLength(2);
  await db.channelReadState.create({ data: { workerId: kit.id, channelId: channel.id, lastSeenSeq: b.ranges[0].seqs[0] } });
  expect(await code(report(b.id))).toBe('WAKE_PROOF_STALE');
  expect(await db.workerDeliveryHold.count()).toBe(0);
});

// Required integration pin: typed input plus the shared #2087/#2090 coercion formatter.
it('shared GraphQL formatter must not echo signed batch ids or unknown sensitive values', async () => {
  const b = await batch();
  const before = await effects();
  const { createServer } = await import('../../../server.js');
  const { createServer: httpServer } = await import('node:http');
  const server = httpServer(await createServer());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as import('node:net').AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/graphql`, { method: 'POST', headers: {
      'content-type': 'application/json', authorization: `Bearer ${rawKeys.get(hostKey.id)}`,
    }, body: JSON.stringify({ query: 'mutation($input:DeliveryHoldReportInput!){reportDeliveryHold(input:$input){workerId}}',
      variables: { input: { batchId: b.id, reason: 'draft', proof: 'SECRET_DRAFT' } } }) });
    const answer = await response.json() as { errors?: unknown[] };
    expect(answer.errors).toEqual([{ message: 'Invalid GraphQL variable input.',
      locations: [{ line: 1, column: 10 }], extensions: { code: 'BAD_USER_INPUT' } }]);
    expect(JSON.stringify(answer)).not.toContain(b.id);
    expect(JSON.stringify(answer)).not.toContain('SECRET_DRAFT');
    expect(await db.workerDeliveryHold.count()).toBe(0);
    expect(await effects()).toEqual(before);
  } finally { await new Promise<void>((resolve,reject) => server.close(e => e ? reject(e) : resolve())); }
});

it('verifier boundary caps the atomic result at ten channels and refuses an eleven-seq descriptor loudly', async () => {
  await postForBoth();
  for (let i=0; i<9; i++) await secondChannel(`cap${i}`);
  const b = (await read(hostKey)).batches[0];
  expect(b.ranges).toHaveLength(10);
  expect((await report(b.id)).holds).toHaveLength(10);
  const { verifyBatchProof, signBatchProof, batchKeyOf } = await import('../../../lib/tickers/wakeProof.js');
  const proof = verifyBatchProof(b.id);
  const channels = [...proof.channels, { channelId: generateId(), incarnation: 1, from: 1, through: 1, seqs: [1] }];
  const larger = { ...proof, channels };
  const token = signBatchProof({ ...larger, batchKey: batchKeyOf(larger) });
  const before = await db.agentTeamEvent.count({ where: { type: 'delivery.held' } });
  expect(await code(report(token))).toBe('WAKE_PROOF_INVALID');
  expect(await db.workerDeliveryHold.count()).toBe(10);
  expect(await db.agentTeamEvent.count({ where: { type: 'delivery.held' } })).toBe(before);
});
it.each(['encrypted', 'caller', 'holder'])('canonical health omits stored holds and alarms excluded by %s visibility', async visibility => {
  const b = await batch(); await report(b.id);
  const { deliveryStateTransaction, beginDeliveryTracking, observeDeliveryPolicyThrough, reconcileDeliveryAlarm } = await import('../../../lib/tickers/deliveryState.js');
  const { loadDeliveryHealthSnapshot } = await import('../../../lib/tickers/deliveryPendingSnapshot.js');
  const at = new Date(), posted = (await db.node.findFirstOrThrow({ where: { messageChannelId: channel.id }, orderBy: { seq: 'asc' } })).createdAt;
  await deliveryStateTransaction(db, app.id, kit.id, async tx => {
    await beginDeliveryTracking(tx, kit.id, posted); await observeDeliveryPolicyThrough(tx, kit.id, at);
    await reconcileDeliveryAlarm(tx, { workerId: kit.id, now: at, candidates: [{ workerId: kit.id, channelId: channel.id, channelIncarnation: 1, seq: b.ranges[0].seqs[0], dueSince: posted }], hold: null });
  });
  const snapshot = () => db.$transaction(tx => loadDeliveryHealthSnapshot(tx, { ctx: keyCtx(hostKey), app: { ...app, organizationId: org.id, ownerUserId: null }, hostId: 'orca1', workerId: kit.id, asOf: at }), { isolationLevel: 'RepeatableRead' });
  expect(await snapshot()).toMatchObject({ pendingMessageCount: 1, heldChannelCount: 1, activeAlarmCount: 1 });
  if (visibility === 'encrypted') await db.memory.update({ where: { id: channel.memoryId }, data: { isEncrypted: true } });
  if (visibility === 'caller') await db.memory.update({ where: { id: channel.memoryId }, data: { class: 'private', userId: manager.id, userMemoryOfAgentId: agentId, sharedMemoryOfAgentId: null } });
  if (visibility === 'holder') {
    const outside = await db.user.create({ data: { id: generateId(), roles: ['READER'] } });
    await db.worker.update({ where: { id: kit.id }, data: { heldByUserId: outside.id, heldAt: new Date() } });
  }
  const hidden = await snapshot();
  expect(hidden).toMatchObject({ pendingMessageCount: 0, heldChannelCount: 0, activeAlarmCount: 0, suppressedAlarmCount: 0, alarm: null, channels: [], totalChannels: 0 });
  expect(JSON.stringify(hidden)).not.toContain(channel.id);
  expect(await db.workerDeliveryHold.count()).toBe(1); // history/current storage is not deleted by a read
});
it('memory-row visibility changes are fenced before the worker/reporting locks and rechecked after waiting', async () => {
  const b = await batch();
  const { waitForLockWaitersOfType } = await import('../../../test/lockWait.js');
  let release!: () => void, held!: () => void;
  const gate = new Promise<void>(r => { release = r; }), ready = new Promise<void>(r => { held = r; });
  const changing = db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM memories WHERE id = ${channel.memoryId} FOR UPDATE`;
    await tx.memory.update({ where: { id: channel.memoryId }, data: { class: 'private', userId: manager.id, userMemoryOfAgentId: agentId, sharedMemoryOfAgentId: null } });
    held(); await gate;
  }, { timeout: 20_000 });
  await Promise.race([ready, changing]);
  const result = code(report(b.id));
  try { await waitForLockWaitersOfType(db, 'transactionid', 1, 1000); } finally { release(); await changing; }
  expect(await result).toBe('WAKE_PROOF_REQUESTER_MISMATCH');
  expect(await db.workerDeliveryHold.count()).toBe(0);
});
