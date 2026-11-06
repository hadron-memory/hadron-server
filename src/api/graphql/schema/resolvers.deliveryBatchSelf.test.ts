import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
/**
 * #2017 R57 — real DB own-session batch read/ack contract; host controls remain in deliveryBatch.test.ts.
 * cor:agt:080:22 (host arm, R4), :23, :26; cor:agt:070:04, :07.
 */

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

async function mkKey(appId: string, label: string) {
  const raw = `${APP_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  return db.appKey.create({ data: { id: generateId(), appId, keyHash: hashAppKey(raw), keyPreview: raw.slice(-4), label }, select: { id: true } });
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
  kit = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name: 'Kit', slug: 'kit' }, select: { id: true, name: true } });
  rook = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name: 'Rook', slug: 'rook' }, select: { id: true, name: true } });
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

describe('R57 own-live-session batches', () => {
  it.each([false, true])('reads only self, including unhosted=%s, with a session-bound proof', async (unhosted) => {
    const s = await ownSession(); await postForBoth();
    if (unhosted) await db.hostRegistrationWorker.deleteMany({ where: { workerId: kit.id } });
    const page = await selfRead(s);
    expect(page.batches.map((b: any) => b.worker.id)).toEqual([kit.id]);
    const p = JSON.parse(Buffer.from(page.batches[0].id.split('.')[0], 'base64url').toString());
    expect(p.requester).toEqual({ sessionId: s.id }); expect(p.hostId).toBeNull();
    expect(page.pageInfo).toEqual({ hasNextPage: false, endCursor: null });
  });
  it('shares host text/hash/key and ranges without sharing acknowledgement authority', async () => {
    const s = await ownSession(); await postForBoth();
    const h = (await read(hostKey)).batches[0]; const b = (await selfRead(s)).batches[0];
    expect(b.text).toBe(h.text); expect(b.ranges).toEqual(h.ranges);
    const decode = (id: string) => JSON.parse(Buffer.from(id.split('.')[0]!, 'base64url').toString());
    expect(decode(b.id).batchKey).toBe(decode(h.id).batchKey);
    expect(await code(selfAck(s, [h.id]))).toBe('WAKE_PROOF_REQUESTER_MISMATCH');
  });
  it('refuses another worker and a foreign App with fixed not-found codes', async () => {
    const s = await ownSession(); await postForBoth();
    expect(await code(selfRead(s, { workerRefs: [rook.id] }))).toBe('WORKER_NOT_FOUND');
    expect(await code(selfRead(s, { appRef: otherApp.id }))).toBe('APP_NOT_FOUND');
  });
  it.each(['ended', 'expired', 'idle', 'reaped'])('refuses a %s session without reviving it', async (kind) => {
    const old = new Date(Date.now() - 30 * 86400_000);
    const s = await ownSession(kind === 'ended' ? { endedAt: new Date() } : kind === 'expired' ? { expiresAt: old } : kind === 'reaped' ? { startedAt: old, autoExpiredAt: old } : { startedAt: old, updatedAt: old });
    expect(await code(selfRead(s))).toBe('SESSION_NOT_LIVE');
    expect(await db.appLogEntry.count()).toBe(0);
    expect((await db.session.findUniqueOrThrow({ where: { id: s.id } })).updatedAt).toEqual(s.updatedAt);
  });
  it("a manager/admin may not borrow someone else's session; actor alone is insufficient", async () => {
    const outsider = await db.user.create({ data: { githubId: 999999991, githubUsername: 'self-outsider', roles: ['ADMIN'] } });
    const s = await ownSession({ userId: outsider.id });
    expect(await code(selfRead(s))).toBe('SESSION_NOT_FOUND');
    expect(await code(runAsActor({ workerId: kit.id, agentId }, () => Q.deliveryBatches({}, { appRef: app.id }, ctx(manager.id))))).toBe('HOST_KEY_REQUIRED');
  });
  it('retired and missing workers refuse with the same not-found code', async () => {
    const s = await ownSession();
    await db.worker.update({ where: { id: kit.id }, data: { retiredAt: new Date() } });
    expect(await code(selfRead(s))).toBe('WORKER_NOT_FOUND');
    const empty = await ownSession({ workerId: null });
    expect(await code(selfRead(empty))).toBe('WORKER_NOT_FOUND');
  });
  it('records successful empty and nonempty self reads transactionally, never as host use', async () => {
    const s = await ownSession(); const before = await db.hostKeyUse.count();
    await selfRead(s); await postForBoth(); await selfRead(s);
    const logs = await db.appLogEntry.findMany({ where: { appId: app.id, sessionId: s.id, message: 'delivery.batch.read' }, orderBy: { createdAt: 'asc' } });
    expect(logs.map(l => [l.level, l.detail])).toEqual([['INFO', { workerId: kit.id, count: 0 }], ['INFO', { workerId: kit.id, count: 1 }]]);
    expect(await db.hostKeyUse.count()).toBe(before);
    expect(await db.workerDeliveryChannel.count()).toBe(0);
  });
  it('#2138 §3.1: an own-session inbox read, empty or not, is a check of the team channel; a host read and a refused read are not', async () => {
    const s = await ownSession();
    const checked = async () => (await db.channelReadState.findFirst({ where: { workerId: kit.id, channelId: channel.id } }))?.lastCheckedAt ?? null;
    expect(await checked()).toBeNull();
    await expect(selfRead(s, {}, { sessionId: 'not-a-session' })).rejects.toThrow();
    expect(await checked()).toBeNull();
    await selfRead(s);
    const first = await checked();
    expect(first).toBeInstanceOf(Date);
    expect((await db.channelReadState.findFirstOrThrow({ where: { workerId: kit.id, channelId: channel.id } })).lastSeenSeq).toBe(0);
  });
  it('#2013 (#2138 §3.7): a stamped @all post reaches the worker\'s inbox', async () => {
    const s = await ownSession();
    await say('@all standup moved', { mentions: ['all'], broadcastWakes: true });
    await db.node.updateMany({ where: { messageChannelId: channel.id }, data: { createdAt: new Date(Date.now() - 3600_000) } }); // past the batching window
    const page = await selfRead(s);
    expect(page.batches).toHaveLength(1);
    expect(page.batches[0].text).toContain('standup moved');
  });
  it('#2138: an inbox read with no team channel to check logs channel.check.miss NO_TEAM_CHANNEL (reason and route only) and still serves the read', async () => {
    const s = await ownSession(); await postForBoth();
    await db.channel.update({ where: { id: channel.id }, data: { deletedAt: new Date() } });
    const page = await selfRead(s);
    expect(Array.isArray(page.batches)).toBe(true);
    const logs = await db.appLogEntry.findMany({ where: { appId: app.id, message: 'channel.check.miss' } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ sessionId: s.id, detail: { reason: 'NO_TEAM_CHANNEL', via: 'inbox' } });
  });
  it('#2158 (George P2): a diagnostic write that FAILS never aborts a valid inbox read (the miss is logged outside the read transaction, best-effort)', async () => {
    const s = await ownSession(); await postForBoth();
    await db.channel.update({ where: { id: channel.id }, data: { deletedAt: new Date() } }); // no team channel -> a NO_TEAM_CHANNEL miss
    await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION test_fail_check_miss() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'diagnostic write refused'; END $$ LANGUAGE plpgsql`);
    await db.$executeRawUnsafe(`CREATE TRIGGER test_fail_check_miss BEFORE INSERT ON app_log FOR EACH ROW WHEN (NEW.message = 'channel.check.miss') EXECUTE FUNCTION test_fail_check_miss()`);
    try {
      const page = await selfRead(s);
      expect(Array.isArray(page.batches)).toBe(true); // the read stands
      // the read's own log entry committed: it was not rolled back with the failed diagnostic
      expect(await db.appLogEntry.count({ where: { appId: app.id, sessionId: s.id, message: 'delivery.batch.read' } })).toBe(1);
      expect(await db.appLogEntry.count({ where: { message: 'channel.check.miss' } })).toBe(0);
    } finally {
      await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_fail_check_miss ON app_log');
      await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_fail_check_miss()');
    }
  });
  it('acks self with worker provenance, session user and no key, and retry changes nothing', async () => {
    const s = await ownSession(); await postForBoth(); const [b] = (await selfRead(s)).batches;
    expect(await selfAck(s, [b.id])).toEqual({ acknowledged: 1, unchanged: 0 });
    expect(await selfAck(s, [b.id])).toEqual({ acknowledged: 0, unchanged: 1 });
    const mark = await db.workerDeliveryChannel.findFirstOrThrow({ where: { workerId: kit.id } });
    expect([mark.ackedByWorkerId, mark.ackedByUserId, mark.ackedByAppKeyId]).toEqual([kit.id, manager.id, null]);
    expect(await db.channelReadState.count({ where: { lastSeenSeq: { gt: 0 } } })).toBe(0); // #2138: an inbox read stamps lastCheckedAt but moves no position
  });
  it('a new session of the same worker cannot acknowledge the old session proof', async () => {
    const s = await ownSession(); await postForBoth(); const [b] = (await selfRead(s)).batches;
    await db.session.update({ where: { id: s.id }, data: { endedAt: new Date() } });
    const next = await ownSession();
    expect(await code(selfAck(next, [b.id]))).toBe('WAKE_PROOF_REQUESTER_MISMATCH');
    expect(await code(selfAck(s, [b.id]))).toBe('SESSION_NOT_LIVE');
    expect(await db.workerDeliveryChannel.count()).toBe(0);
  });
  // #3082: 'MCP own-session selector' removed with hadron_team_chat_inbox(_ack); the resolver twin is 'acks self with worker
  // provenance...' and 'executes the same read and acknowledgement through the GraphQL SDL'.
  it('a committed membership revocation denies even the same owned session', async () => {
    const s = await ownSession(); await postForBoth();
    await db.orgMember.delete({ where: { organizationId_userId: { organizationId: org.id, userId: manager.id } } });
    expect(await code(selfRead(s))).toBe('APP_NOT_FOUND');
    expect(await db.appLogEntry.count()).toBe(0);
  });
  it('an end that wins between entry and deciding transaction refuses and records nothing', async () => {
    const s = await ownSession(); await postForBoth();
    const wrapped = new Proxy(db, { get(target, property) {
      if (property === '$transaction') return async (...args: any[]) => {
        await db.session.update({ where: { id: s.id }, data: { endedAt: new Date() } });
        return (target.$transaction as any)(...args);
      };
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
    expect(await code(selfRead(s, {}, { db: wrapped }))).toBe('SESSION_NOT_LIVE');
    expect(await db.appLogEntry.count()).toBe(0);
  });
  it('a failed self-read audit prevents success and rolls back the record', async () => {
    const s = await ownSession(); await postForBoth();
    const wrapped = new Proxy(db, { get(target, property) {
      if (property === '$transaction') return (fn: any, ...rest: any[]) => target.$transaction(async tx => {
        const proxy = new Proxy(tx, { get(t, p) {
          if (p === 'appLogEntry') return new Proxy(t.appLogEntry, { get(model, method) {
            if (method === 'create') return async () => { throw new Error('audit unavailable'); };
            return Reflect.get(model, method);
          } });
          return Reflect.get(t, p);
        } });
        return fn(proxy);
      }, ...rest);
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
    await expect(selfRead(s, {}, { db: wrapped })).rejects.toThrow('audit unavailable');
    expect(await db.appLogEntry.count()).toBe(0);
  });

  it.each([-1, 0, 1])('uses the inclusive idle boundary at delta %s ms', async (delta) => {
    const deadline = Date.now(); const start = new Date(deadline - idleWindowMsFor('DEVELOPER'));
    const s = await ownSession({ startedAt: start, updatedAt: start });
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(deadline + delta);
    try {
      if (delta <= 0) expect((await selfRead(s)).batches).toEqual([]);
      else expect(await code(selfRead(s))).toBe('SESSION_NOT_LIVE');
    } finally { vi.useRealTimers(); }
  });
  it.each([-1, 0, 1])('uses the exclusive hard expiry at delta %s ms', async (delta) => {
    const deadline = Date.now() + 10_000; const s = await ownSession({ expiresAt: new Date(deadline) });
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(deadline + delta);
    try {
      if (delta < 0) expect((await selfRead(s)).batches).toEqual([]);
      else expect(await code(selfRead(s))).toBe('SESSION_NOT_LIVE');
    } finally { vi.useRealTimers(); }
  });

  it.each(['caller', 'holder', 'encrypted'])('omits a channel without trace when %s cannot receive it', async (reason) => {
    const s = await ownSession(); await postForBoth();
    const outsider = await db.user.create({ data: { githubId: 999999992, githubUsername: 'unreadable-owner', roles: ['READER'] } });
    if (reason === 'encrypted') await db.memory.update({ where: { id: channel.memoryId }, data: { isEncrypted: true } });
    else {
      await db.memory.update({ where: { id: channel.memoryId }, data: { class: 'private', userId: reason === 'caller' ? outsider.id : manager.id, userMemoryOfAgentId: agentId, sharedMemoryOfAgentId: null } });
      if (reason === 'holder') {
        await db.orgMember.create({ data: { organizationId: org.id, userId: outsider.id, role: 'READER' } });
        await db.worker.update({ where: { id: kit.id }, data: { heldByUserId: outsider.id } });
      }
    }
    expect(await selfRead(s)).toEqual({ batches: [], pageInfo: { hasNextPage: false, endCursor: null } });
  });
  it('executes the same read and acknowledgement through the GraphQL SDL', async () => {
    const s = await ownSession(); await postForBoth();
    const { ApolloServer } = await import('@apollo/server');
    const { typeDefs } = await import('./typeDefs.js');
    const server = new ApolloServer<Context>({ typeDefs, resolvers: resolvers as any });
    try {
      const r = await server.executeOperation({ query: 'query($app: String!) { deliveryBatches(appRef: $app) { batches { id text worker { id } } } }', variables: { app: app.id } }, { contextValue: selfCtx(s) });
      expect(r.body.kind).toBe('single'); if (r.body.kind !== 'single') throw new Error('expected single response');
      expect(r.body.singleResult.errors).toBeUndefined();
      const batches = (r.body.singleResult.data as any).deliveryBatches.batches;
      expect(batches.map((b: any) => b.worker.id)).toEqual([kit.id]);
      const a = await server.executeOperation({ query: 'mutation($ids: [String!]!) { acknowledgeDeliveryBatches(batchIds: $ids) { acknowledged unchanged } }', variables: { ids: [batches[0].id] } }, { contextValue: selfCtx(s) });
      expect(a.body.kind).toBe('single'); if (a.body.kind !== 'single') throw new Error('expected single response');
      expect(a.body.singleResult.errors).toBeUndefined();
      expect((a.body.singleResult.data as any).acknowledgeDeliveryBatches).toEqual({ acknowledged: 1, unchanged: 0 });
    } finally { await server.stop(); }
  });

  it('a userless own-session key can read but cannot borrow a human session or survive key revocation', async () => {
    const s = await ownSession({ userId: null });
    const context = keyCtx(bareKey, app.id, { sessionId: s.id });
    expect((await Q.deliveryBatches({}, { appRef: app.id }, context)).batches).toEqual([]);
    const human = await ownSession();
    expect(await code(Q.deliveryBatches({}, { appRef: app.id }, { ...context, sessionId: human.id }))).toBe('SESSION_NOT_FOUND');
    await db.appKey.update({ where: { id: bareKey.id }, data: { revokedAt: new Date() } });
    expect(await code(Q.deliveryBatches({}, { appRef: app.id }, context))).toBe('SESSION_NOT_FOUND');
  });

  it('each explicit session reads its own worker batches independently of another session (moved from the MCP wrapper, #3082)', async () => {
    const kitSession = await ownSession(); const rookSession = await ownSession({ workerId: rook.id }); await postForBoth();
    const results = await Promise.all([kitSession, rookSession].map(s => selfRead(s)));
    expect(results.map((r: any) => r.batches.map((b: any) => b.worker.id))).toEqual([[kit.id], [rook.id]]);
  });

  it('an end winning after ack entry but before the transaction prevents every mark', async () => {
    const s = await ownSession(); await postForBoth(); const [b] = (await selfRead(s)).batches;
    const wrapped = new Proxy(db, { get(target, property) {
      if (property === '$transaction') return async (...args: any[]) => {
        await db.session.update({ where: { id: s.id }, data: { endedAt: new Date() } });
        return (target.$transaction as any)(...args);
      };
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
    expect(await code(selfAck(s, [b.id], { db: wrapped }))).toBe('WAKE_PROOF_REQUESTER_MISMATCH');
    expect(await db.workerDeliveryChannel.count()).toBe(0);
  });
  it('self ack rechecks channel access and rejects a mixed invalid list atomically', async () => {
    const s = await ownSession(); await postForBoth(); const [b] = (await selfRead(s)).batches;
    expect(await code(selfAck(s, [b.id, b.id + 'x']))).toBe('WAKE_PROOF_INVALID');
    expect(await db.workerDeliveryChannel.count()).toBe(0);
    const outsider = await db.user.create({ data: { githubId: 999999993, githubUsername: 'ack-revoked-owner', roles: ['READER'] } });
    await db.memory.update({ where: { id: channel.memoryId }, data: { class: 'private', userId: outsider.id, userMemoryOfAgentId: agentId, sharedMemoryOfAgentId: null } });
    expect(await code(selfAck(s, [b.id]))).toBe('WAKE_PROOF_REQUESTER_MISMATCH');
    expect(await db.workerDeliveryChannel.count()).toBe(0);
  });
  it('self partial ack moves only a rendered prefix and the remainder stays due', async () => {
    const s = await ownSession(); await postForBoth(); await postForBoth();
    const [b] = (await selfRead(s)).batches; expect(b.ranges[0].seqs).toHaveLength(2);
    const seq = b.ranges[0].seqs[0];
    expect(await M.acknowledgeDeliveryBatches({}, { batchIds: [b.id], through: [{ channelId: channel.id, seq }] }, selfCtx(s))).toEqual({ acknowledged: 1, unchanged: 0 });
    expect((await selfRead(s)).batches[0].ranges[0].seqs).toEqual([b.ranges[0].seqs[1]]);
    expect(await selfAck(s, [b.id])).toEqual({ acknowledged: 1, unchanged: 0 });
    expect((await selfRead(s)).batches).toEqual([]);
    expect(await db.channelReadState.count({ where: { lastSeenSeq: { gt: 0 } } })).toBe(0); // #2138: an inbox read stamps lastCheckedAt but moves no position
  });

  it('keeps the session refusal when middleware removed an invalid named binding', async () => {
    const context = { ...ctx(manager.id), sessionBindingRefused: true };
    expect(await code(Q.deliveryBatches({}, { appRef: app.id }, context))).toBe('SESSION_NOT_LIVE');
    expect(await code(M.acknowledgeDeliveryBatches({}, { batchIds: [] }, context))).toBe('SESSION_NOT_LIVE');
    expect(await db.appLogEntry.count()).toBe(0);
  });

  // #3082: 'MCP explicit validated session replaces a refused ambient binding' removed. It pinned the hadron_team_chat_inbox
  // wrapper's own session-argument settlement (resolved through the SDK gate, not a resolver rule); the resolver keeps the
  // refusal in 'keeps the session refusal when middleware removed an invalid named binding' above.
});

it('self proof uses the same current register policy as host proof after read', async () => {
  const s = await ownSession(); await postForBoth();
  const [b] = (await selfRead(s)).batches;
  await db.registerEntry.updateMany({ where: { attendeeWorkerId: kit.id }, data: { role: 'POST' } });
  expect(await code(selfAck(s, [b.id]))).toBe('WAKE_PROOF_REQUESTER_MISMATCH');
  expect(await db.workerDeliveryChannel.count()).toBe(0);
});

it('self read waits on the deciding session row and sees an end committed by its lock holder', async () => {
  const s = await ownSession(); await postForBoth();
  let held!: () => void; const holding = new Promise<void>(r => { held = r; });
  let release!: () => void; const released = new Promise<void>(r => { release = r; });
  let entering!: () => void; const locking = new Promise<'locking'>(r => { entering = () => r('locking'); });
  let auditing!: () => void; const auditStage = new Promise<'auditing'>(r => { auditing = () => r('auditing'); });
  const blocker = db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM sessions WHERE id=${s.id} FOR UPDATE`;
    held(); await released;
    await tx.session.update({ where: { id: s.id }, data: { endedAt: new Date() } });
  });
  await holding;
  const original = db.$transaction.bind(db);
  const wrapped = new Proxy(db, { get(t, prop) {
    if (prop !== '$transaction') return Reflect.get(t, prop);
    return (body: any, ...options: any[]) => (original as any)(async (tx: any) => body(new Proxy(tx, { get(target, key) {
      if (key === 'appLogEntry') return new Proxy(target.appLogEntry, { get(model, method) {
        if (method !== 'create') return Reflect.get(model, method);
        return (...args: any[]) => { auditing(); return model.create(...args); };
      }});
      if (key !== '$queryRaw') return Reflect.get(target, key);
      return (...args: any[]) => {
        const sql = Array.isArray(args[0]) ? args[0].join(' ') : '';
        if (sql.includes('FROM sessions') && sql.includes('FOR SHARE')) entering();
        return target.$queryRaw(...args);
      };
    }})), ...options);
  }});
  const result = code(selfRead(s, {}, { db: wrapped }));
  try { expect(await Promise.race([locking, auditStage, result.then(() => 'completed')])).toBe('locking'); }
  finally { release(); await blocker; }
  expect(await result).toBe('SESSION_NOT_LIVE');
  expect(await db.appLogEntry.count()).toBe(0);
});

it('the post-load self check refuses a hard expiry crossed during message loading', async () => {
  const deadline = Date.now() + 60_000; const s = await ownSession({ expiresAt: new Date(deadline) });
  await postForBoth(); let crossed = false;
  const original = db.$transaction.bind(db);
  const wrapped = new Proxy(db, { get(t, prop) {
    if (prop !== '$transaction') return Reflect.get(t, prop);
    return (body: any, ...options: any[]) => (original as any)(async (tx: any) => body(new Proxy(tx, { get(target, key) {
      if (key !== '$queryRaw') return Reflect.get(target, key);
      return async (...args: any[]) => {
        const rows = await target.$queryRaw(...args);
        if (!crossed && args[0]?.strings?.join(' ').includes('total_eligible')) {
          crossed = true; vi.setSystemTime(deadline);
        }
        return rows;
      };
    }})), ...options);
  }});
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(deadline - 1);
  try {
    expect(await code(selfRead(s, {}, { db: wrapped }))).toBe('SESSION_NOT_LIVE');
    expect(crossed).toBe(true);
    expect(await db.appLogEntry.count()).toBe(0);
  } finally { vi.useRealTimers(); }
});
