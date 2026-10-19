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
  it('acks self with worker provenance, session user and no key, and retry changes nothing', async () => {
    const s = await ownSession(); await postForBoth(); const [b] = (await selfRead(s)).batches;
    expect(await selfAck(s, [b.id])).toEqual({ acknowledged: 1, unchanged: 0 });
    expect(await selfAck(s, [b.id])).toEqual({ acknowledged: 0, unchanged: 1 });
    const mark = await db.workerDeliveryChannel.findFirstOrThrow({ where: { workerId: kit.id } });
    expect([mark.ackedByWorkerId, mark.ackedByUserId, mark.ackedByAppKeyId]).toEqual([kit.id, manager.id, null]);
    expect(await db.channelReadState.count()).toBe(0);
  });
  it('a new session of the same worker cannot acknowledge the old session proof', async () => {
    const s = await ownSession(); await postForBoth(); const [b] = (await selfRead(s)).batches;
    await db.session.update({ where: { id: s.id }, data: { endedAt: new Date() } });
    const next = await ownSession();
    expect(await code(selfAck(next, [b.id]))).toBe('WAKE_PROOF_REQUESTER_MISMATCH');
    expect(await code(selfAck(s, [b.id]))).toBe('SESSION_NOT_LIVE');
    expect(await db.workerDeliveryChannel.count()).toBe(0);
  });
  it('MCP own-session selector reads and acknowledges the same self batch', async () => {
    const s = await ownSession(); await postForBoth();
    const { createTestableMcpServer } = await import('../../../mcp/server.js');
    const server = createTestableMcpServer({ userId: manager.id, roles: ['READER'] } as never, { sessionId: `self-${generateId()}`, cachedAppResolution: { kind: 'multi-app' } });
    const text = (r: any) => r.content[0].text;
    const result = JSON.parse(text(await server.callTool('hadron_delivery_batches', { appRef: app.id, session: s.id })));
    expect(result.batches.map((b: any) => b.workerId)).toEqual([kit.id]);
    expect(text(await server.callTool('hadron_ack_delivery_batches', { batchIds: [result.batches[0].id], session: s.id }))).toBe('Acknowledged 1.');
  });
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

});
