/** #2021 held reports: signed descriptor authority, privacy, no delivery effects and atomic events. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { ensureChannelWithRoot } from '../lib/channels.js';
import { appendChatMessage } from '../lib/chatRoot.js';
import { getMemoryEncryptionInfo } from '../lib/nodeCrypto.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerTickerTools } from './tickerTools.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const M = resolvers.Mutation as any;

const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] }) as Context;
let org: { id: string; urn: string };
let app: { id: string; urn: string };
let agentId: string;
let manager: { id: string };
let kit: { id: string; name: string };
let rook: { id: string; name: string };
let channel: { id: string; memoryId: string; loc: string; chatRootNodeId: string };
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
  kit = await db.worker.create({ data: { appId: app.id, agentId, name: 'Kit', slug: 'kit' }, select: { id: true, name: true } });
  rook = await db.worker.create({ data: { appId: app.id, agentId, name: 'Rook', slug: 'rook' }, select: { id: true, name: true } });
  const memory = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:team-shared`, name: 'shared', class: 'app', appId: app.id, sharedMemoryOfAgentId: agentId } });
  const made = await ensureChannelWithRoot(db, { memoryId: memory.id, loc: 'chats:team', name: 'team', createdBy: manager.id });
  channel = { id: made.channel.id, memoryId: memory.id, loc: 'chats:team', chatRootNodeId: made.rootId };
  for (const w of [kit, rook]) await db.registerEntry.create({ data: { id: generateId(), appId: app.id, channelId: channel.id, attendeeWorkerId: w.id, role: 'BOTH' } });
});

// Transport precedent: resolvers.deliveryHeld2021.test.ts, fixture copied read-only.
// These calls traverse SDK validation/serialization; no _registeredTools shortcut.
const peers: Array<{ client: Client; server: McpServer }> = [];
afterEach(async () => {
  for (const { client, server } of peers.splice(0)) {
    await client.close(); await server.close();
  }
});
async function sdk() {
  const server = new McpServer({ name: 'held-main-regression', version: '1' });
  registerTickerTools(server, { db, auth: { userId: manager.id, roles: ['READER'] } as never });
  const client = new Client({ name: 'held-main-client', version: '1' });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  await server.connect(remote); await client.connect(local);
  peers.push({ client, server });
  return client;
}
async function boundSession(workerId = kit.id) {
  return db.session.create({ data: { id: generateId(), appId: app.id, userId: manager.id, workerId, agentId } });
}
async function inbox(client: Client, session: string) {
  const result = await client.callTool({ name: 'hadron_team_chat_inbox', arguments: { appRef: app.id, session } });
  expect(result.isError).not.toBe(true);
  const page = JSON.parse((result.content as Array<{ text: string }>)[0].text);
  expect(page.batches).toHaveLength(1);
  expect(page.batches[0].id).toEqual(expect.any(String));
  expect(page.batches[0].ranges).toHaveLength(1);
  return page.batches[0];
}
async function deliveryEffects() {
  // Compare actual rows, not only counts: a hidden update must also fail.
  return {
    delivered: await db.workerDeliveryChannel.findMany(), read: await db.channelReadState.findMany(),
    ticks: await db.workerDeliveryTick.findMany(), wakes: await db.workerWakeAck.findMany(),
    reservations: await db.appWakeReservation.findMany(), budget: await db.appWakeDay.findMany(),
    tasks: await db.workerDeliveryTaskEvent.findMany(),
  };
}
async function postDue() {
  await say('transport-visible message for @kit and @rook', { mentions: ['kit', 'rook'] });
  await db.node.updateMany({ where: { messageChannelId: channel.id }, data: { createdAt: new Date(Date.now() - 3600_000) } });
}
const parse = (result: any) => JSON.parse(result.content[0].text);
const heldEvents = () => db.agentTeamEvent.count({ where: { type: { in: ['delivery.held', 'delivery.resumed', 'delivery.stuck'] } } });

describe('#2021 merged S1 MCP SDK inbox-to-held transport', () => {
  it('accepts the exact inbox id without acknowledging, spending or moving read/delivery state', async () => {
    const session = await boundSession(), client = await sdk();
    await postDue();
    const before = await deliveryEffects();
    const batch = await inbox(client, session.id);
    expect(await deliveryEffects()).toEqual(before);
    const result = await client.callTool({ name: 'hadron_report_delivery_hold', arguments: {
      batchId: batch.id, reason: 'draft', terminalId: 'term_sdk', session: session.id,
    } });
    expect(result.isError).not.toBe(true);
    const body = parse(result);
    expect(body.workerId).toBe(kit.id);
    expect(body.holds).toHaveLength(1);
    expect(body.holds[0]).toMatchObject({ channelId: channel.id, reason: 'draft', terminalId: 'term_sdk', firstPendingSeq: batch.ranges[0].seqs[0] });
    expect(JSON.stringify(result)).not.toContain(batch.id);
    expect(await db.workerDeliveryHold.count()).toBe(1);
    expect(await heldEvents()).toBe(1);
    expect(await deliveryEffects()).toEqual(before);
    const repeated = await client.callTool({ name: 'hadron_report_delivery_hold', arguments: { batchId: batch.id, reason: 'draft', terminalId: 'term_sdk', session: session.id } });
    expect(repeated.isError).not.toBe(true);
    expect(parse(repeated).holds).toEqual(body.holds);
    expect(await heldEvents()).toBe(1);
    expect(await deliveryEffects()).toEqual(before);
  });

  it.each(['stale', 'foreign', 'unknown-field'] as const)('refuses %s without proof/draft echo or delivery effects', async kind => {
    const session = await boundSession(), client = await sdk();
    await postDue();
    const batch = await inbox(client, session.id);
    let callerSession = session.id;
    if (kind === 'stale') await db.channel.update({ where: { id: channel.id }, data: { incarnation: 2 } });
    if (kind === 'foreign') callerSession = (await boundSession(rook.id)).id;
    const before = await deliveryEffects();
    const result = await client.callTool({ name: 'hadron_report_delivery_hold', arguments: {
      batchId: batch.id, reason: 'draft', session: callerSession,
      ...(kind === 'unknown-field' ? { draft: 'SECRET_DRAFT_TRANSPORT' } : {}),
    } });
    expect(result.isError).toBe(true);
    const wire = JSON.stringify(result);
    expect(wire).toContain(kind === 'unknown-field' ? '[bad_user_input]' : kind === 'foreign' ? '[wake_proof_requester_mismatch]' : '[wake_proof_stale]');
    expect(wire).not.toContain(batch.id);
    expect(wire).not.toContain('SECRET_DRAFT_TRANSPORT');
    expect(await db.workerDeliveryHold.count()).toBe(0);
    expect(await heldEvents()).toBe(0);
    expect(await deliveryEffects()).toEqual(before);
  });
});
