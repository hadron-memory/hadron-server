import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
/**
 * #2017 (S1) — `deliveryBatches`: who may read a host's batches, and that every read is recorded.
 * cor:agt:080:22 (host arm, R4), :23, :26; cor:agt:070:04, :07.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { randomBytes } from 'node:crypto';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { waitForLockWaitersOfType } from '../../../test/lockWait.js';
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

describe('who may read delivery batches (R4)', () => {
  it('a key with attention:deliver AND host:operate reads the batches of ITS host only', async () => {
    await postForBoth();
    const mine = await read(hostKey);
    expect(mine.batches.map((b: any) => b.worker.name)).toEqual(['Kit']);
    expect(mine.batches[0].text).toContain('[hadron chat] 1 for Kit');
    expect(typeof mine.batches[0].id).toBe('string');
    expect(mine.batches[0].interrupt).toBe(false);
    const theirs = await read(otherHostKey);
    expect(theirs.batches.map((b: any) => b.worker.name)).toEqual(['Rook']);
  });

  it('a bare attention:deliver key (no host) is refused; so is host:operate without attention:deliver', async () => {
    expect(await code(read(bareKey))).toBe('APP_KEY_SCOPE_REQUIRED');
    expect(await code(read(opOnlyKey))).toBe('APP_KEY_SCOPE_REQUIRED');
  });

  it('a person, a session-bound key, a worker identity and a foreign App key are refused', async () => {
    expect(await code(Q.deliveryBatches({}, { appRef: app.id }, ctx(manager.id)))).toBe('HOST_KEY_REQUIRED');
    expect(await code(runAsActor({ workerId: kit.id, agentId }, () => read(hostKey)))).toBe('APP_KEY_SESSION_BOUND');
    expect(await code(Q.deliveryBatches({}, { appRef: app.id }, keyCtx(foreignKey, otherApp.id)))).toBe('APP_NOT_FOUND');
    expect(await code(read(foreignKey, {}, otherApp.id))).toBe('APP_KEY_SCOPE_REQUIRED'); // its own App, but no scopes
  });

  it('a worker of another host named by ref is simply absent (no oracle)', async () => {
    await postForBoth();
    const page = await read(hostKey, { workerRefs: [rook.id] });
    expect(page.batches).toEqual([]);
  });

  it('a revoked scope, or a lost registration, refuses from the next call', async () => {
    await postForBoth();
    await M.revokeAppKeyScope({}, { id: hostKey.id, scope: 'attention:deliver' }, ctx(manager.id));
    expect(await code(read(hostKey))).toBe('APP_KEY_SCOPE_REQUIRED');
    await M.grantAppKeyScope({}, { id: hostKey.id, scope: 'attention:deliver' }, ctx(manager.id));
    expect((await read(hostKey)).batches).toHaveLength(1);
    await db.hostRegistration.updateMany({ where: { appId: app.id, hostId: 'orca1' }, data: { lostAt: new Date() } });
    expect(await code(read(hostKey))).toBe('APP_KEY_SCOPE_REQUIRED');
  });
});

describe('every read is recorded (cor:agt:070:07)', () => {
  it('writes one host-key use per read, with the number of batches, in the same transaction', async () => {
    await postForBoth();
    await read(hostKey);
    await read(hostKey);
    const uses = await db.hostKeyUse.findMany({ where: { appKeyId: hostKey.id, action: 'deliver' }, orderBy: { usedAt: 'asc' } });
    expect(uses.map((u) => [u.hostId, u.count])).toEqual([['orca1', 1], ['orca1', 1]]);
  });

  it('an empty page is recorded too, and reading changes no mark', async () => {
    await read(hostKey);
    expect(await db.hostKeyUse.count({ where: { appKeyId: hostKey.id, action: 'deliver' } })).toBe(1);
    await postForBoth();
    await read(hostKey);
    expect(await db.workerDeliveryChannel.count()).toBe(0);
  });
});

const ack = (k: { id: string }, batchIds: string[], through?: Array<{ channelId: string; seq: number }>) =>
  M.acknowledgeDeliveryBatches({}, { batchIds, ...(through ? { through } : {}) }, keyCtx(k));

describe('acknowledging a batch', () => {
  it('moves the delivered mark to the rendered range; the next read is empty; a repeat changes nothing; it is recorded', async () => {
    await postForBoth();
    const [b] = (await read(hostKey)).batches;
    expect(await ack(hostKey, [b.id])).toEqual({ acknowledged: 1, unchanged: 0 });
    const mark = await db.workerDeliveryChannel.findFirstOrThrow({ where: { workerId: kit.id, channelId: channel.id } });
    expect(mark.deliveredThroughSeq).toBe(b.ranges[0].throughSeq);
    expect((await read(hostKey)).batches).toEqual([]);
    expect(await ack(hostKey, [b.id])).toEqual({ acknowledged: 0, unchanged: 1 });
    expect(await db.hostKeyUse.count({ where: { appKeyId: hostKey.id, action: 'deliver' } })).toBeGreaterThanOrEqual(3);
  });

  it('another host key, a bare key, a person and a session-bound call cannot acknowledge it', async () => {
    await postForBoth();
    const [b] = (await read(hostKey)).batches;
    expect(await code(ack(otherHostKey, [b.id]))).toBe('WAKE_PROOF_REQUESTER_MISMATCH');
    expect(await code(M.acknowledgeDeliveryBatches({}, { batchIds: [b.id] }, ctx(manager.id)))).toBe('HOST_KEY_REQUIRED');
    expect(await code(runAsActor({ workerId: kit.id, agentId }, () => ack(hostKey, [b.id])))).toBe('APP_KEY_SESSION_BOUND');
    expect(await db.workerDeliveryChannel.count()).toBe(0);
  });

  it('authority is re-derived at the acknowledgement: a revoked host scope or a lost registration refuses and moves nothing', async () => {
    await postForBoth();
    const [b] = (await read(hostKey)).batches;
    await M.revokeAppKeyScope({}, { id: hostKey.id, scope: 'attention:deliver' }, ctx(manager.id));
    expect(await code(ack(hostKey, [b.id]))).toBe('APP_KEY_SCOPE_REQUIRED');
    await M.grantAppKeyScope({}, { id: hostKey.id, scope: 'attention:deliver' }, ctx(manager.id));
    await db.hostRegistration.updateMany({ where: { appId: app.id, hostId: 'orca1' }, data: { lostAt: new Date() } });
    expect(await code(ack(hostKey, [b.id]))).toBe('WAKE_PROOF_REQUESTER_MISMATCH');
    expect(await db.workerDeliveryChannel.count()).toBe(0);
  });

  it('through applies to one batch only; a forged id is invalid', async () => {
    await postForBoth();
    const [b] = (await read(hostKey)).batches;
    expect(await code(ack(hostKey, [b.id, b.id], [{ channelId: channel.id, seq: b.ranges[0].throughSeq }]))).toBe('BAD_USER_INPUT');
    expect(await code(ack(hostKey, [`${b.id}x`]))).toBe('WAKE_PROOF_INVALID');
  });
});

// #2102 review regressions: commit the revocation just before the deciding
// transaction starts. The hook changes real rows/registrations, never the answer.
function beforeDecision(change: () => Promise<unknown>): Context {
  let once = false;
  const original = db.$transaction.bind(db);
  const hooked = new Proxy(db, { get(target, prop) {
    if (prop !== '$transaction') return Reflect.get(target, prop);
    return async (...args: any[]) => {
      if (!once) { once = true; await change(); }
      return (original as any)(...args);
    };
  }});
  return keyCtx(hostKey, app.id, { db: hooked });
}

describe('#2102 current host delivery policy at the deciding transaction', () => {
  it('a supported host refresh removing the worker cannot return its earlier loaded text', async () => {
    await postForBoth();
    const c = beforeDecision(async () => {
      await M.registerHost({}, { input: { appRef: app.id, label: 'Orca 1', pollIntervalSeconds: 60, workers: [] } }, keyCtx(hostKey));
      expect(await db.hostRegistrationWorker.count({ where: { workerId: kit.id } })).toBe(0);
    });
    expect((await Q.deliveryBatches({}, { appRef: app.id }, c)).batches).toEqual([]);
  });

  it.each(['register', 'encrypted', 'holder', 'caller'] as const)('read omits a channel after %s authority is revoked in the gap', async (kind) => {
    await db.worker.update({ where: { id: kit.id }, data: { heldByUserId: manager.id } });
    await postForBoth();
    const c = beforeDecision(() => revoke(kind));
    expect((await Q.deliveryBatches({}, { appRef: app.id }, c)).batches).toEqual([]);
    expect(await db.workerDeliveryChannel.count()).toBe(0);
  });

  async function revoke(kind: 'register' | 'encrypted' | 'holder' | 'caller') {
    if (kind === 'register') return db.registerEntry.updateMany({ where: { attendeeWorkerId: kit.id }, data: { role: 'POST' } });
    if (kind === 'encrypted') return db.memory.update({ where: { id: channel.memoryId }, data: { isEncrypted: true } });
    if (kind === 'caller') return db.memory.update({ where: { id: channel.memoryId }, data: { class: 'private', userId: manager.id, appId: null, sharedMemoryOfAgentId: null, userMemoryOfAgentId: null } });
    return db.orgMember.update({ where: { organizationId_userId: { organizationId: org.id, userId: manager.id } }, data: { deletedAt: new Date() } });
  }

  it.each(['register', 'encrypted', 'holder', 'caller'] as const)('old host proof refuses after %s authority loss, including at transaction entry', async (kind) => {
    await db.worker.update({ where: { id: kit.id }, data: { heldByUserId: manager.id } });
    await postForBoth();
    const [b] = (await read(hostKey)).batches;
    const c = beforeDecision(() => revoke(kind));
    expect(await code(M.acknowledgeDeliveryBatches({}, { batchIds: [b.id] }, c))).toBe('WAKE_PROOF_REQUESTER_MISMATCH');
    expect(await db.workerDeliveryChannel.count()).toBe(0);
    expect((await read(hostKey)).batches).toEqual([]);
  });
});

describe('#2102 proof policy after an actual worker wake-lock wait', () => {
  it.each(['register', 'encrypted'] as const)('a committed %s revocation while ack waits refuses with zero marks', async (kind) => {
    await postForBoth();
    const [b] = (await read(hostKey)).batches;
    let held!: () => void; const holding = new Promise<void>(r => { held = r; });
    let release!: () => void; const released = new Promise<void>(r => { release = r; });
    let entering!: () => void; const waiting = new Promise<void>(r => { entering = r; });
    const blocker = db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'wake:' + kit.id}, 0))`;
      held(); await released;
    });
    await holding;
    const original = db.$transaction.bind(db);
    const hooked = new Proxy(db, { get(target, prop) {
      if (prop !== '$transaction') return Reflect.get(target, prop);
      return (body: any, ...options: any[]) => (original as any)(async (tx: any) => body(new Proxy(tx, { get(t, key) {
        if (key !== '$executeRaw') return Reflect.get(t, key);
        return (...args: any[]) => {
          if (args.includes('wake:' + kit.id)) entering();
          return t.$executeRaw(...args);
        };
      }})), ...options);
    }});
    const pending = M.acknowledgeDeliveryBatches({}, { batchIds: [b.id] }, keyCtx(hostKey, app.id, { db: hooked }));
    try {
      await waiting;
      // Observe a real blocked PostgreSQL advisory lock, not a timed sleep. A deterministic barrier (#2237): the old
      // fixed 100-iteration poll gave up under host load before the writer queued, failing about 2 runs in 3.
      await waitForLockWaitersOfType(db, 'advisory', 1);
      if (kind === 'register') await db.registerEntry.updateMany({ where: { attendeeWorkerId: kit.id }, data: { role: 'POST' } });
      else await db.memory.update({ where: { id: channel.memoryId }, data: { isEncrypted: true } });
    } finally { release(); await blocker; }
    expect(await code(pending)).toBe('WAKE_PROOF_REQUESTER_MISMATCH');
    expect(await db.workerDeliveryChannel.count()).toBe(0);
  });
});

describe('#2102 register policy remains fenced after the deciding read', () => {
  it.each([
    ['host', 'app', 'update'], ['self', 'app', 'update'],
    ['host', 'org', 'update'], ['self', 'org', 'update'],
    ['host', 'app', 'delete'], ['self', 'app', 'create'],
  ] as const)('%s ack fences %s register %s through commit', async (arm, owner, change) => {
    const entry = await db.registerEntry.findFirstOrThrow({ where: { attendeeWorkerId: kit.id } });
    if (owner === 'org') await db.registerEntry.update({ where: { id: entry.id }, data: { appId: null, organizationId: org.id } });
    if (change === 'create') await db.registerEntry.update({ where: { id: entry.id }, data: { attendeeWorkerId: null } });
    await postForBoth();
    const session = arm === 'self' ? await db.session.create({ data: { id: generateId(), appId: app.id, userId: manager.id, workerId: kit.id, agentId } }) : null;
    const caller = session ? { ...ctx(manager.id), appId: app.id, sessionId: session.id } : keyCtx(hostKey);
    const [batch] = (await Q.deliveryBatches({}, { appRef: app.id }, caller)).batches;
    let reached!: () => void; const policyRead = new Promise<void>(r => { reached = r; });
    let release!: () => void; const resumed = new Promise<void>(r => { release = r; });
    let once = false;
    const original = db.$transaction.bind(db);
    const wrapped = new Proxy(db, { get(t, prop) {
      if (prop !== '$transaction') return Reflect.get(t, prop);
      return (body: any, ...options: any[]) => (original as any)(async (tx: any) => body(new Proxy(tx, { get(target, key) {
        if (key !== 'channel') return Reflect.get(target, key);
        return new Proxy(target.channel, { get(model, method) {
          if (method !== 'findMany') return Reflect.get(model, method);
          return async (args: any) => {
            const rows = await model.findMany(args);
            if (!once && args.select?.memory?.select?.isEncrypted) { once = true; reached(); await resumed; }
            return rows;
          };
        }});
      }})), ...options);
    }});
    const pending = M.acknowledgeDeliveryBatches({}, { batchIds: [batch.id] }, { ...caller, db: wrapped });
    await policyRead;
    let committed = false;
    const write = change === 'delete'
      ? M.deleteRegisterEntry({}, { ref: entry.id }, ctx(manager.id))
      : change === 'create'
        ? M.createRegisterEntry({}, { input: { ownerRef: app.id, channelRef: channel.id, attendeeRef: kit.id, role: 'POST' } }, ctx(manager.id))
        : M.updateRegisterEntry({}, { ref: entry.id, input: { role: 'POST' } }, ctx(manager.id));
    const revoke = write.then(() => { committed = true; });
    try {
      // #2237: wait deterministically until the revoking write is blocked on the fence; a revoke that commits first
      // without waiting fails the test outright instead of racing a fixed-length poll.
      const bypassed = revoke.then(() => { throw new Error('the register write committed without waiting on the fence'); });
      bypassed.catch(() => {}); // observed by the race below; never an unhandled rejection
      await Promise.race([waitForLockWaitersOfType(db, 'advisory', 1), bypassed]);
      expect(committed).toBe(false);
    } finally { release(); await Promise.allSettled([pending, revoke]); }
    expect(await pending).toEqual({ acknowledged: 1, unchanged: 0 });
    expect(committed).toBe(true);
    expect(await code(M.acknowledgeDeliveryBatches({}, { batchIds: [batch.id] }, caller))).toBe('WAKE_PROOF_REQUESTER_MISMATCH');
    expect(await db.workerDeliveryChannel.count()).toBe(1);
  });
});

describe('#2102 refused host uses are recorded once apart', () => {
  async function callRead(k: { id: string }, surface: string) {
    const caller = keyCtx(k);
    if (surface === 'resolver') return code(Q.deliveryBatches({}, { appRef: app.id }, caller));
    if (surface === 'graphql') {
      const { ApolloServer } = await import('@apollo/server'); const { typeDefs } = await import('./typeDefs.js');
      const server = new ApolloServer({ typeDefs, resolvers: resolvers as any });
      try { const r = await server.executeOperation({ query: 'query($app:String!){deliveryBatches(appRef:$app){batches{id}}}', variables: { app: app.id } }, { contextValue: caller });
        expect(r.body.kind).toBe('single'); if (r.body.kind === 'single') return r.body.singleResult.errors?.[0]?.extensions?.code;
      } finally { await server.stop(); }
    }
    const { createTestableMcpServer } = await import('../../../mcp/server.js');
    const server = createTestableMcpServer({ ...caller, clientId: `app:${app.id}` } as never);
    const r = await server.callTool('hadron_team_chat_inbox', { appRef: app.id });
    expect((r as any).isError).toBe(true); return undefined;
  }

  it.each(['resolver', 'graphql'])('host-only read refusal is recorded once through %s', async surface => {
    await callRead(opOnlyKey, surface);
    const rows = await db.hostKeyUse.findMany({ where: { appKeyId: opOnlyKey.id, action: 'deliver', refusedCode: 'APP_KEY_SCOPE_REQUIRED' } });
    expect(rows).toHaveLength(1);
  });

  it.each(['resolver', 'graphql'])('receiver ack after attention scope revocation records once through %s', async surface => {
    await postForBoth(); const [b] = (await read(hostKey)).batches;
    await M.revokeAppKeyScope({}, { id: hostKey.id, scope: 'attention:deliver' }, ctx(manager.id));
    if (surface === 'resolver') expect(await code(ack(hostKey, [b.id]))).toBe('APP_KEY_SCOPE_REQUIRED');
    else if (surface === 'graphql') {
      const { ApolloServer } = await import('@apollo/server'); const { typeDefs } = await import('./typeDefs.js');
      const server = new ApolloServer({ typeDefs, resolvers: resolvers as any });
      try {
        const r = await server.executeOperation({ query: 'mutation($ids:[String!]!){acknowledgeDeliveryBatches(batchIds:$ids){acknowledged}}', variables: { ids: [b.id] } }, { contextValue: keyCtx(hostKey) });
        expect(r.body.kind).toBe('single');
        if (r.body.kind === 'single') expect(r.body.singleResult.errors?.[0]?.extensions?.code).toBe('APP_KEY_SCOPE_REQUIRED');
      } finally { await server.stop(); }
    } else {
      const { createTestableMcpServer } = await import('../../../mcp/server.js');
      const server = createTestableMcpServer({ ...keyCtx(hostKey), clientId: `app:${app.id}` } as never);
      expect((await server.callTool('hadron_team_chat_inbox_ack', { batchIds: [b.id] }) as any).isError).toBe(true);
    }
    expect(await db.hostKeyUse.count({ where: { appKeyId: hostKey.id, action: 'deliver', refusedCode: 'APP_KEY_SCOPE_REQUIRED' } })).toBe(1);
    expect(await db.workerDeliveryChannel.count()).toBe(0);
  });

  it('an audit-storage failure preserves the original refusal', async () => {
    const failed = new Proxy(db, { get(t, prop) {
      if (prop !== 'hostKeyUse') return Reflect.get(t, prop);
      return new Proxy(t.hostKeyUse, { get(model, method) { if (method === 'create') return async () => { throw new Error('synthetic audit unavailable'); }; return Reflect.get(model, method); }});
    }});
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try { expect(await code(Q.deliveryBatches({}, { appRef: app.id }, keyCtx(opOnlyKey, app.id, { db: failed })))).toBe('APP_KEY_SCOPE_REQUIRED'); expect(log).toHaveBeenCalledTimes(1); }
    finally { log.mockRestore(); }
  });
});

describe('#2102 empty host acknowledgement is an audited no-op', () => {
  it.each(['resolver', 'graphql'])('records one zero-count accepted use through %s', async surface => {
    if (surface === 'resolver') expect(await ack(hostKey, [])).toEqual({ acknowledged: 0, unchanged: 0 });
    else if (surface === 'graphql') {
      const { ApolloServer } = await import('@apollo/server'); const { typeDefs } = await import('./typeDefs.js');
      const server = new ApolloServer({ typeDefs, resolvers: resolvers as any });
      try {
        const r = await server.executeOperation({ query: 'mutation{acknowledgeDeliveryBatches(batchIds:[]){acknowledged unchanged}}' }, { contextValue: keyCtx(hostKey) });
        expect(r.body.kind).toBe('single');
        if (r.body.kind === 'single') { expect(r.body.singleResult.errors).toBeUndefined(); expect(r.body.singleResult.data?.acknowledgeDeliveryBatches).toEqual({ acknowledged: 0, unchanged: 0 }); }
      } finally { await server.stop(); }
    } else {
      const { createTestableMcpServer } = await import('../../../mcp/server.js');
      const server = createTestableMcpServer({ ...keyCtx(hostKey), clientId: `app:${app.id}` } as never);
      const r = await server.callTool('hadron_team_chat_inbox_ack', { batchIds: [] });
      expect(r.content[0].text).toBe('Acknowledged 0.');
    }
    const uses = await db.hostKeyUse.findMany({ where: { appKeyId: hostKey.id, action: 'deliver' } });
    expect(uses).toHaveLength(1); expect(uses[0]).toMatchObject({ count: 0, refusedCode: null, hostId: 'orca1' });
    expect(await db.workerDeliveryChannel.count()).toBe(0);
    expect(await db.channelReadState.count()).toBe(0);
    expect(await db.workerWakeAck.count()).toBe(0);
    expect(await db.appWakeDay.count()).toBe(0);
  });

  it('preserves the self arm empty result without a host use', async () => {
    const session = await db.session.create({ data: { id: generateId(), appId: app.id, userId: manager.id, workerId: kit.id, agentId } });
    expect(await M.acknowledgeDeliveryBatches({}, { batchIds: [] }, { ...ctx(manager.id), appId: app.id, sessionId: session.id })).toEqual({ acknowledged: 0, unchanged: 0 });
    expect(await db.hostKeyUse.count({ where: { action: 'deliver' } })).toBe(0);
  });

  it.each(['scope', 'registration'])('rechecks %s at the no-op transaction and records only its refusal', async kind => {
    const caller = beforeDecision(async () => {
      if (kind === 'scope') await M.revokeAppKeyScope({}, { id: hostKey.id, scope: 'attention:deliver' }, ctx(manager.id));
      else await db.hostRegistration.updateMany({ where: { appId: app.id, hostId: 'orca1' }, data: { lostAt: new Date() } });
    });
    expect(await code(M.acknowledgeDeliveryBatches({}, { batchIds: [] }, caller))).toBe('APP_KEY_SCOPE_REQUIRED');
    const uses = await db.hostKeyUse.findMany({ where: { appKeyId: hostKey.id, action: 'deliver' } });
    expect(uses).toHaveLength(1); expect(uses[0].refusedCode).toBe('APP_KEY_SCOPE_REQUIRED');
  });

  it('cannot report accepted no-op success when the transactional use record fails', async () => {
    const original = db.$transaction.bind(db);
    const wrapped = new Proxy(db, { get(t, prop) {
      if (prop !== '$transaction') return Reflect.get(t, prop);
      return (body: any, ...options: any[]) => (original as any)(async (tx: any) => body(new Proxy(tx, { get(target, key) {
        if (key !== 'hostKeyUse') return Reflect.get(target, key);
        return new Proxy(target.hostKeyUse, { get(model, method) { if (method === 'create') return async () => { throw new Error('synthetic no-op audit unavailable'); }; return Reflect.get(model, method); }});
      }})), ...options);
    }});
    await expect(M.acknowledgeDeliveryBatches({}, { batchIds: [] }, keyCtx(hostKey, app.id, { db: wrapped }))).rejects.toThrow('synthetic no-op audit unavailable');
    expect(await db.hostKeyUse.count({ where: { action: 'deliver' } })).toBe(0);
    expect(await db.workerDeliveryChannel.count()).toBe(0);
  });
});
