/**
 * #2018 S2 — MCP twin of resolvers.oneMark2018.test.ts: an own mentions read through hadron_channel_read and
 * hadron_team_chat_read raises the marks exactly as GraphQL does; windows and another worker's filter move nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
import { ensureChannelWithRoot } from '../lib/channels.js';
import { appendChatMessage } from '../lib/chatRoot.js';
import { getMemoryEncryptionInfo } from '../lib/nodeCrypto.js';
import { createTestableMcpServer } from './server.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const M = resolvers.Mutation as any;
let org: { id: string; urn: string };
let app: { id: string };
let manager: { id: string };
let kit: { id: string };
let rook: { id: string };
let session: { id: string };
let channel: { id: string; memoryId: string; loc: string; chatRootNodeId: string };

async function say(body: string, mentions: string[] = []) {
  const enc = await getMemoryEncryptionInfo(db, channel.memoryId);
  return appendChatMessage(db, { id: channel.chatRootNodeId, memoryId: channel.memoryId, loc: channel.loc }, enc, async ({ tx, seq, msgNum }) =>
    tx.node.create({ data: { id: generateId(), memoryId: channel.memoryId, loc: `${channel.loc}:messages:${msgNum}`, name: msgNum, nodeType: 'chat-message', seq, messageChannelId: channel.id, content: body, data: { authorName: 'Ada', mentions } } }),
    { asChannel: true });
}
const marks = async (w = kit) => ({
  delivered: (await db.workerDeliveryChannel.findUnique({ where: { workerId_channelId: { workerId: w.id, channelId: channel.id } } }))?.deliveredThroughSeq ?? 0,
  read: (await db.channelReadState.findFirst({ where: { workerId: w.id, channelId: channel.id } }))?.lastSeenSeq ?? 0,
});
const mcp = () => createTestableMcpServer({ userId: manager.id, appId: app.id, roles: ['READER'], clientId: `user:${manager.id}` });

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { name: 'OneMark', urn: `onemark-${n}.example` }, select: { id: true, urn: true } });
  manager = await db.user.create({ data: { githubId: 82_000_000 + n, githubUsername: `om-m-${n}`, roles: ['READER'] }, select: { id: true } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: manager.id, role: 'ADMIN' } });
  const ctx = { db, userId: manager.id, roles: ['READER'] } as Context;
  const agentId = (await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx)).id;
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` }, select: { id: true } });
  await db.appAgent.create({ data: { appId: app.id, agentId } });
  kit = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name: 'Kit', slug: 'kit' }, select: { id: true } });
  rook = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name: 'Rook', slug: 'rook' }, select: { id: true } });
  const memory = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:team-shared`, name: 'shared', class: 'app', appId: app.id, sharedMemoryOfAgentId: agentId } });
  const made = await ensureChannelWithRoot(db, { memoryId: memory.id, loc: 'chats:team', name: 'team', createdBy: manager.id });
  channel = { id: made.channel.id, memoryId: memory.id, loc: 'chats:team', chatRootNodeId: made.rootId };
  for (const w of [kit, rook]) await db.registerEntry.create({ data: { id: generateId(), appId: app.id, channelId: channel.id, attendeeWorkerId: w.id, role: 'BOTH', mentionOnly: true } });
  session = await db.session.create({ data: { id: generateId(), appId: app.id, userId: manager.id, workerId: kit.id, agentId } as any, select: { id: true } });
});

describe('#2018 S2 over MCP', () => {
  it('hadron_channel_read with mentions = the own worker raises delivered and (mention-only) the read position', async () => {
    await say('chatter');
    await say('@kit a', ['kit']);
    const out = await mcp().callToolText('hadron_channel_read', { channel: channel.id, mentions: kit.id, sinceSeq: 0, session: session.id });
    expect(out).toContain('@kit a');
    expect(await marks()).toEqual({ delivered: 2, read: 2 });
  });

  it('hadron_team_chat_read with mentions = the own worker does the same', async () => {
    await say('@kit a', ['kit']);
    await mcp().callToolText('hadron_team_chat_read', { mentions: kit.id, sinceSeq: 0, session: session.id });
    expect(await marks()).toEqual({ delivered: 1, read: 1 });
  });

  it('a window, and another worker\'s filter, move nothing', async () => {
    await say('@kit a', ['kit']);
    await say('@rook b', ['rook']);
    await mcp().callToolText('hadron_channel_read', { channel: channel.id, mentions: kit.id, sinceSeq: 0, beforeSeq: 2, session: session.id });
    await mcp().callToolText('hadron_channel_read', { channel: channel.id, mentions: rook.id, sinceSeq: 0, session: session.id });
    expect(await marks()).toEqual({ delivered: 0, read: 0 });
    expect(await marks(rook)).toEqual({ delivered: 0, read: 0 });
  });
});
