/**
 * #2015 — a worker's identical post to the same Channel within ten minutes is refused, and the refusal writes nothing.
 *
 * The rule: the SAME worker (identity survives its session changes), the SAME Channel, exactly the same body and the
 * same reply identity (a `replies-to` edge to the same target, or none on both sides), within the preceding ten minutes
 * by the admission clock. Refused as TEAM_CHAT_DUPLICATE, carrying the earlier seq in the message text and in the typed
 * fields (MCP renders only the code and the text), with no message, no seq, no edge, no root or Channel counter moved.
 *
 * Out of the rule: a genuine human post (no worker), a different worker, another Channel, a changed body or reply, an
 * earlier message that was soft-deleted (Proposed), and anyone the existing post gate already refuses (the refusal is
 * the gate's, never an earlier seq).
 *
 * The admission instant is read from the database AFTER the Channel's lock is held and is what the new message's
 * `createdAt` is stamped with, so a post that waited on a lock is never recorded as older than the moment it was
 * admitted (Node.createdAt defaults to transaction-start now()).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { ensureChannelWithRoot } from '../../../lib/channels.js';
import { appendChatMessage } from '../../../lib/chatRoot.js';
import { getMemoryEncryptionInfo } from '../../../lib/nodeCrypto.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { type Context } from './resolvers.js';
import { teamChatMutations } from './resolvers.teamChat.js';
import { resolvers } from './resolvers.js';

vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as any;
const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] }) as Context;
const MIN = 60_000;

type W = { id: string; name: string; holder: string; session: string };
type Ch = { id: string; memoryId: string; loc: string; chatRootNodeId: string };

let org: { id: string; urn: string };
let manager: { id: string };
let holderA: { id: string };
let holderB: { id: string };
let outsider: { id: string };
let app: { id: string; urn: string };
let agent: { id: string };
let memory: { id: string };
let channel: Ch;
let other: Ch;
let liam: W;
let rook: W;

async function mkUser(n: number) {
  return db.user.create({ data: { id: generateId(), githubId: 98_700 + n, githubUsername: `dup-${n}-${Date.now()}-${Math.floor(Math.random() * 1e5)}`, roles: ['READER'] }, select: { id: true } });
}
async function mkSession(w: { id: string }, holder: string) {
  return (await db.session.create({ data: { id: generateId(), appId: app.id, userId: holder, workerId: w.id, agentId: agent.id, type: 'DEVELOPER', startedAt: new Date() } })).id;
}
async function mkWorker(name: string, holder: string): Promise<W> {
  const w = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name, slug: name.toLowerCase(), heldByUserId: holder, heldAt: new Date() }, select: { id: true, name: true } });
  await db.registerEntry.create({ data: { id: generateId(), appId: app.id, channelId: channel.id, attendeeWorkerId: w.id, role: 'BOTH' } });
  return { ...w, holder, session: await mkSession(w, holder) };
}

const humanSays = (userId: string, body: string, replyToSeq: number | null = null) =>
  teamChatMutations.createTeamChatMessage({}, { appRef: app.id, body, replyToSeq, sessionRef: null }, ctx(userId));
const workerSays = (w: W, body: string, replyToSeq: number | null = null, session = w.session) =>
  runAsActor({ workerId: w.id, agentId: agent.id }, () =>
    teamChatMutations.createTeamChatMessage({}, { appRef: app.id, body, replyToSeq, sessionRef: session }, ctx(w.holder)));
const workerSaysIn = (w: W, ch: Ch, body: string, replyToSeq: number | null = null) =>
  runAsActor({ workerId: w.id, agentId: agent.id }, () =>
    M.createChannelMessage({}, { channelRef: ch.id, body, replyToSeq, sessionRef: w.session }, ctx(w.holder)));

/** Everything a refused post must leave exactly as it found it. */
async function footprint(ch: Ch) {
  const [messages, edges, root, channelRow] = await Promise.all([
    db.node.count({ where: { memoryId: ch.memoryId, nodeType: 'chat-message', messageChannelId: ch.id } }),
    db.edge.count({ where: { memoryId: ch.memoryId, name: 'replies-to' } }),
    db.node.findUniqueOrThrow({ where: { id: ch.chatRootNodeId }, select: { data: true } }),
    db.channel.findUniqueOrThrow({ where: { id: ch.id }, select: { lastSeq: true, lastMessageAt: true } }),
  ]);
  return { messages, edges, rootData: root.data, lastSeq: channelRow.lastSeq, lastMessageAt: channelRow.lastMessageAt?.toISOString() ?? null };
}
const backdate = (nodeId: string, ms: number) => db.node.update({ where: { id: nodeId }, data: { createdAt: new Date(Date.now() - ms) } });

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'dup-org', urn: `dup-org-${suffix}.com` } });
  [manager, holderA, holderB, outsider] = [await mkUser(1), await mkUser(2), await mkUser(3), await mkUser(4)];
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: manager.id, role: 'ADMIN' } });
  agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team`, visibility: 'ORGANIZATION' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  for (const u of [holderA, holderB]) await db.appMember.create({ data: { appId: app.id, userId: u.id, role: 'member' } });
  memory = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:team-shared`, name: 'shared', class: 'app', appId: app.id, sharedMemoryOfAgentId: agent.id } });
  const made = await ensureChannelWithRoot(db, { memoryId: memory.id, loc: 'chats:team', name: 'team', createdBy: manager.id, asDefaultOfAppId: app.id });
  channel = { id: made.channel.id, memoryId: memory.id, loc: 'chats:team', chatRootNodeId: made.rootId };
  const madeOther = await ensureChannelWithRoot(db, { memoryId: memory.id, loc: 'chats:release', name: 'release', createdBy: manager.id });
  other = { id: madeOther.channel.id, memoryId: memory.id, loc: 'chats:release', chatRootNodeId: madeOther.rootId };
  liam = await mkWorker('Liam', holderA.id);
  rook = await mkWorker('Rook', holderB.id);
});

describe('#2015 the refusal', () => {
  it('refuses an identical post, naming the earlier seq in the text and in the typed fields', async () => {
    const first = await workerSays(liam, 'deploy is green');
    const err: any = await workerSays(liam, 'deploy is green').catch((e) => e);
    expect(err.extensions).toMatchObject({ code: 'TEAM_CHAT_DUPLICATE', earlierSeq: first.seq });
    expect(err.message).toContain(`#${first.seq}`);
    expect(err.message).toMatch(/do not retry/i);
  });

  it('writes nothing: no message, no seq, no edge, no root or Channel counter moved', async () => {
    const first = await workerSays(liam, 'deploy is green');
    const before = await footprint(channel);
    await expect(workerSays(liam, 'deploy is green')).rejects.toMatchObject({ extensions: { code: 'TEAM_CHAT_DUPLICATE' } });
    expect(await footprint(channel)).toEqual(before);
    // the next accepted post takes the very next seq: the refused one consumed none
    expect((await workerSays(liam, 'a different thing')).seq).toBe(first.seq + 1);
  });

  it('is exact: any change to the body is a different post', async () => {
    await workerSays(liam, 'deploy is green');
    expect((await workerSays(liam, 'deploy is green ')).seq).toBeGreaterThan(0);
    expect((await workerSays(liam, 'Deploy is green')).seq).toBeGreaterThan(0);
  });

  it('judges the reply identity: same target is a duplicate; a different target, or none vs one, is not', async () => {
    const a = await humanSays(manager.id, 'question A');
    const b = await humanSays(manager.id, 'question B');
    const first = await workerSays(liam, 'ack', a.seq);
    await expect(workerSays(liam, 'ack', a.seq)).rejects.toMatchObject({ extensions: { code: 'TEAM_CHAT_DUPLICATE', earlierSeq: first.seq } });
    expect((await workerSays(liam, 'ack', b.seq)).seq).toBeGreaterThan(first.seq); // other target
    expect((await workerSays(liam, 'ack')).seq).toBeGreaterThan(first.seq); // no target vs a target
    const bare = await workerSays(liam, 'plain');
    expect((await workerSays(liam, 'plain', a.seq)).seq).toBeGreaterThan(bare.seq); // a target vs none
    await expect(workerSays(liam, 'plain')).rejects.toMatchObject({ extensions: { code: 'TEAM_CHAT_DUPLICATE', earlierSeq: bare.seq } }); // none vs none
  });

  it('a removed replies-to edge is no reply identity: the post is then a plain duplicate of a plain one', async () => {
    const a = await humanSays(manager.id, 'question A');
    const first = await workerSays(liam, 'ack', a.seq);
    await db.edge.updateMany({ where: { memoryId: channel.memoryId, name: 'replies-to', source: { seq: first.seq, messageChannelId: channel.id } }, data: { deletedAt: new Date() } });
    await expect(workerSays(liam, 'ack')).rejects.toMatchObject({ extensions: { code: 'TEAM_CHAT_DUPLICATE', earlierSeq: first.seq } });
  });

  it('names the most recent matching message', async () => {
    const first = await workerSays(liam, 'status?');
    await backdate((await db.node.findFirstOrThrow({ where: { seq: first.seq, messageChannelId: channel.id }, select: { id: true } })).id, 11 * MIN);
    const second = await workerSays(liam, 'status?'); // outside the window: accepted
    await expect(workerSays(liam, 'status?')).rejects.toMatchObject({ extensions: { earlierSeq: second.seq } });
  });
});

describe('#2015 the window is ten minutes by the persisted admission time', () => {
  const nodeOf = (ch: Ch, seq: number) => db.node.findFirstOrThrow({ where: { memoryId: ch.memoryId, messageChannelId: ch.id, seq }, select: { id: true } });

  it('refuses at 9m55s and admits at 10m05s', async () => {
    const m = await workerSays(liam, 'tick');
    await backdate((await nodeOf(channel, m.seq)).id, 9 * MIN + 55_000);
    await expect(workerSays(liam, 'tick')).rejects.toMatchObject({ extensions: { code: 'TEAM_CHAT_DUPLICATE' } });
    await backdate((await nodeOf(channel, m.seq)).id, 10 * MIN + 5_000);
    expect((await workerSays(liam, 'tick')).seq).toBeGreaterThan(m.seq);
  });

  it('an earlier message that was soft-deleted does not block (Proposed)', async () => {
    const m = await workerSays(liam, 'oops');
    await db.node.update({ where: { id: (await nodeOf(channel, m.seq)).id }, data: { deletedAt: new Date() } });
    expect((await workerSays(liam, 'oops')).seq).toBeGreaterThan(m.seq);
  });

  // CONTROL (green on main by design): Prisma stamps the `@default(now())` on the engine side at insert, i.e. after the
  // lock wait, so main already records a lock-waiting post at its admission. This keeps that true once createdAt is
  // stamped explicitly from the database clock; the clock source itself is pinned in teamChatAdmission2015.test.ts.
  it('control: a lock-waiting post is stamped at its admission, never at its transaction start', async () => {
    // A holds the Channel's lock for 1.5 s inside its own append; B (a worker post) starts, then waits on that lock.
    const enc = await getMemoryEncryptionInfo(db, channel.memoryId);
    let committedAt = 0;
    const holder = appendChatMessage(db, { id: channel.chatRootNodeId, memoryId: channel.memoryId, loc: channel.loc }, enc, async ({ tx, seq, msgNum }) => {
      await new Promise((r) => setTimeout(r, 1500));
      return tx.node.create({ data: { id: generateId(), memoryId: channel.memoryId, loc: `${channel.loc}:messages:${msgNum}`, name: msgNum, nodeType: 'chat-message', seq, messageChannelId: channel.id, content: 'holder', data: {} } });
    }, { asChannel: true }).then(() => { committedAt = Date.now(); });
    await new Promise((r) => setTimeout(r, 200));
    const waited = await workerSays(liam, 'waited for the lock');
    await holder;
    const row = await db.node.findFirstOrThrow({ where: { memoryId: channel.memoryId, messageChannelId: channel.id, seq: waited.seq }, select: { createdAt: true } });
    expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(committedAt - 50); // admitted after the holder committed
    expect(waited.at.getTime()).toBe(row.createdAt.getTime()); // the receipt carries the same instant
  });
});

describe('#2015 who the rule is about', () => {
  it('is the worker, across its sessions', async () => {
    const first = await workerSays(liam, 'same words');
    const second = await mkSession(liam, liam.holder);
    await expect(workerSays(liam, 'same words', null, second)).rejects.toMatchObject({ extensions: { code: 'TEAM_CHAT_DUPLICATE', earlierSeq: first.seq } });
  });

  it('is not another worker, and not a human repeating a worker\'s words', async () => {
    await workerSays(liam, 'same words');
    expect((await workerSays(rook, 'same words')).seq).toBeGreaterThan(0);
    expect((await humanSays(manager.id, 'same words')).seq).toBeGreaterThan(0);
  });

  it('leaves a genuine human posting as themselves unlimited: the same body twice both land', async () => {
    const a = await humanSays(manager.id, 'standup');
    const b = await humanSays(manager.id, 'standup');
    expect(b.seq).toBe(a.seq + 1);
  });

  it('is per Channel: the same words in another Channel are a new post', async () => {
    const first = await workerSays(liam, 'same words');
    const elsewhere = await workerSaysIn(liam, other, 'same words');
    expect(elsewhere.seq).toBe(1);
    await expect(workerSaysIn(liam, other, 'same words')).rejects.toMatchObject({ extensions: { code: 'TEAM_CHAT_DUPLICATE', earlierSeq: elsewhere.seq } });
    await expect(workerSays(liam, 'same words')).rejects.toMatchObject({ extensions: { earlierSeq: first.seq } });
  });

  it('control: a caller the post gate refuses gets the gate\'s refusal, never an earlier seq', async () => {
    await workerSays(liam, 'same words');
    const err: any = await teamChatMutations.createTeamChatMessage({}, { appRef: app.id, body: 'same words', replyToSeq: null, sessionRef: null }, ctx(outsider.id)).catch((e) => e);
    expect(err.extensions.code).not.toBe('TEAM_CHAT_DUPLICATE');
    expect(String(err.message)).not.toMatch(/#\d/);
  });
});

describe('#2015 concurrency reaches the guard', () => {
  it('two identical posts at once admit exactly one', async () => {
    const results = await Promise.allSettled([workerSays(liam, 'race'), workerSays(liam, 'race')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost: any = results.find((r) => r.status === 'rejected');
    expect(lost.reason.extensions.code).toBe('TEAM_CHAT_DUPLICATE');
    expect((await footprint(channel)).messages).toBe(1);
  });
});
