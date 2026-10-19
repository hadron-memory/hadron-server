/**
 * #2017 (S1) — `deliveryBatches`: who may read a host's batches, and that every read is recorded.
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

describe('the MCP twin carries the same text and the same gates', () => {
  it('hadron_delivery_batches returns the GraphQL text byte for byte; hadron_ack_delivery_batches acknowledges it; a bare key is refused', async () => {
    const { createTestableMcpServer } = await import('../../../mcp/server.js');
    const mk = (k: { id: string }) =>
      createTestableMcpServer({ appId: app.id, appKeyId: k.id, organizationId: org.id, roles: [] } as never, { sessionId: `ak-${generateId()}`, cachedAppResolution: { kind: 'multi-app' } });
    const text = (r: { content: Array<{ text: string }> }) => r.content[0]!.text;
    await postForBoth();
    const gql = (await read(hostKey)).batches[0];
    const server = mk(hostKey);
    const mcp = JSON.parse(text(await server.callTool('hadron_delivery_batches', { appRef: app.id })));
    expect(mcp.batches).toHaveLength(1);
    expect(mcp.batches[0].text).toBe(gql.text);
    expect(mcp.batches[0].worker).toBe('Kit');
    expect(text(await server.callTool('hadron_ack_delivery_batches', { batchIds: [mcp.batches[0].id] }))).toBe('Acknowledged 1.');
    expect(JSON.parse(text(await server.callTool('hadron_delivery_batches', { appRef: app.id }))).batches).toEqual([]);
    expect(text(await mk(bareKey).callTool('hadron_delivery_batches', { appRef: app.id }))).toMatch(/^\[app_key_scope_required\]/);
  });
});
