/**
 * #2181 — the channel incarnation on the team-chat read / mark wire, and the fence that makes a pinned read or mark
 * decide its effects behind the Channel row lock. Real database, two connections for the races.
 */
import { buildSchema, parse, validate } from 'graphql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { typeDefs } from '../api/graphql/schema/typeDefs.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { Client } from 'pg';
import { advanceReadState } from './channelReadState.js';
import { waitForLockWaiters } from '../test/lockWait.js';
import { generateId } from './id.js';
import { ensureChannelWithRoot } from './channels.js';
import { appendChatMessage } from './chatRoot.js';
import { getMemoryEncryptionInfo } from './nodeCrypto.js';
import { sessionKeyCache } from './sessionKeyCache.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from '../mcp/server.js';
import type { AuthContext } from '../middleware/auth.js';
import { WORKER_SIGNATURE_DEFAULTS } from './workerSignature.js';

vi.mock('./bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.setConfig({ testTimeout: 30_000 });
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const Q = resolvers.Query as any;
const M = resolvers.Mutation as any;

let org: { id: string; urn: string };
let user: { id: string };
let otherUser: { id: string };
let app: { id: string; urn: string };
let otherApp: { id: string; urn: string };
let agent: { id: string };
let memory: { id: string; urn: string };
let channel: { id: string; memoryId: string; loc: string; chatRootNodeId: string };
let worker: { id: string; name: string };
let sessionId: string;


const userCtx = (extra: Partial<Context> = {}): Context => ({ db, userId: user.id, roles: ['READER'], ...extra }) as Context;

async function post(body: string, options: { authorWorkerId?: string; mentions?: string[]; broadcastWakes?: boolean } = {}) {
  const enc = await getMemoryEncryptionInfo(db, channel.memoryId);
  return appendChatMessage(
    db,
    { id: channel.chatRootNodeId, memoryId: channel.memoryId, loc: channel.loc },
    enc,
    async ({ tx, seq, msgNum }) => tx.node.create({
      data: {
        id: generateId(),
        memoryId: channel.memoryId,
        loc: `${channel.loc}:messages:${msgNum}`,
        name: msgNum,
        nodeType: 'chat-message',
        seq,
        messageChannelId: channel.id,
        content: body,
        data: {
          mentions: options.mentions ?? [],
          ...(options.authorWorkerId ? { authorWorkerId: options.authorWorkerId } : {}),
          ...(options.broadcastWakes !== undefined ? { broadcastWakes: options.broadcastWakes } : {}),
        },
      },
    }),
    { asChannel: true },
  );
}

async function addWorker(name: string) {
  const made = await db.worker.create({
    data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name, slug: name.toLowerCase() },
  });
  await db.registerEntry.create({
    data: { id: generateId(), appId: app.id, channelId: channel.id, attendeeWorkerId: made.id, role: 'BOTH' },
  });
  const madeSession = await db.session.create({
    data: { id: generateId(), appId: app.id, userId: user.id, workerId: made.id, agentId: agent.id, type: 'DEVELOPER', startedAt: new Date() },
  });
  return { ...made, sessionId: madeSession.id };
}

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'attention', urn: `attention-${suffix}.com` } });
  user = await db.user.create({ data: { id: generateId(), githubId: 1353001, githubUsername: `attention-${suffix}` } });
  otherUser = await db.user.create({ data: { id: generateId(), githubId: 1353002, githubUsername: `other-${suffix}` } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: otherUser.id, role: 'ADMIN' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Pilot', urn: `${org.urn}:pilot` } });
  otherApp = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Other', urn: `${org.urn}:other` } });
  agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team`, visibility: 'ORGANIZATION' } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await db.appMember.create({ data: { appId: app.id, userId: user.id, role: 'admin' } });
  memory = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: `${org.urn}:pilot-shared`,
      name: 'shared',
      class: 'app',
      appId: app.id,
      sharedMemoryOfAgentId: agent.id,
    },
  });
  worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name: 'Dara', slug: 'dara' } });
  const made = await ensureChannelWithRoot(db, {
    memoryId: memory.id,
    loc: 'chats:team',
    name: 'team',
    createdBy: user.id,
    asDefaultOfAppId: app.id,
  });
  channel = { id: made.channel.id, memoryId: memory.id, loc: 'chats:team', chatRootNodeId: made.rootId };
  await db.registerEntry.create({
    data: { id: generateId(), appId: app.id, channelId: channel.id, attendeeWorkerId: worker.id, role: 'BOTH' },
  });
  sessionId = generateId();
  await db.session.create({
    data: { id: sessionId, appId: app.id, userId: user.id, workerId: worker.id, agentId: agent.id, type: 'DEVELOPER', startedAt: new Date() },
  });
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.TEAM_ATTENTION_TOKEN_SECRET;
  sessionKeyCache.clear();
});




const mcpAuth = (): AuthContext => ({ userId: user.id, appId: app.id, roles: ['READER'], clientId: `user:${user.id}` });
const readState = () => db.channelReadState.findFirst({ where: { workerId: worker.id, channelId: channel.id } });
const currentIncarnation = async () => (await db.channel.findUniqueOrThrow({ where: { id: channel.id } })).incarnation;
const sessionRow = () => db.session.findUniqueOrThrow({ where: { id: sessionId } });
const mark = (seq: number, expectedIncarnation?: number | null) =>
  M.markOwnTeamChatRead({}, { appRef: app.id, sessionRef: sessionId, channelRef: channel.id, seq, expectedIncarnation }, userCtx());
const readPinned = (expectedIncarnation?: number | null, extra: Record<string, unknown> = {}) =>
  Q.channelMessages({}, { channelRef: channel.id, sinceSeq: 0, expectedIncarnation, ...extra }, userCtx({ sessionId }));
/** The write `ensureChannelWithRoot(resetForReuse)` makes to the Channel row. */
const recreateData = { lastSeq: 0, lastMessageAt: null, incarnation: { increment: 1 } };
/** The same write over its own connection: the test pool is small and the held transactions occupy it. */
async function recreateOnOwnConnection() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('UPDATE channels SET last_seq = 0, last_message_at = NULL, incarnation = incarnation + 1 WHERE id = $1', [channel.id]);
  } finally {
    await client.end();
  }
}
const recreate = () => db.channel.update({ where: { id: channel.id }, data: recreateData });
/** The name-holder's session nobody drove for 30 hours: lapsed but resumable by its own act (#1617 B). */
const goneQuiet = async () => {
  await db.worker.update({ where: { id: worker.id }, data: { heldByUserId: user.id, heldAt: new Date() } });
  const { startedAt } = await sessionRow();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(startedAt.getTime() + 30 * 3_600_000));
};
const changed = (current: number) => ({ extensions: { code: 'CHANNEL_INCARNATION_CHANGED', channelId: channel.id, currentIncarnation: current } });

/** Hold an exclusive lock on the Channel row (a recreation mid-flight) until `release()`, from a second connection. */
async function holdRecreation() {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let locked!: () => void;
  const ready = new Promise<void>((r) => { locked = r; });
  const tx = db.$transaction(async (t) => {
    await t.channel.update({ where: { id: channel.id }, data: recreateData });
    locked();
    await gate;
  }, { timeout: 30_000 });
  await ready;
  return { release, done: tx };
}

/** Hold the Channel row FOR UPDATE (not a recreation): anything that fences on it must wait. */
async function holdChannelRowForUpdate() {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let locked!: () => void;
  const ready = new Promise<void>((r) => { locked = r; });
  const tx = db.$transaction(async (t) => {
    await t.$queryRaw`SELECT id FROM channels WHERE id = ${channel.id} FOR UPDATE`;
    locked();
    await gate;
  }, { timeout: 30_000 });
  await ready;
  return { release, done: tx };
}

/** Hold the worker's read-state row (so a guarded effect blocks AFTER it took the Channel row lock). */
async function holdReadStateRow() {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let locked!: () => void;
  const ready = new Promise<void>((r) => { locked = r; });
  const tx = db.$transaction(async (t) => {
    await t.$queryRaw`SELECT id FROM channel_read_states WHERE worker_id = ${worker.id} AND channel_id = ${channel.id} FOR UPDATE`;
    locked();
    await gate;
  }, { timeout: 30_000 });
  await ready;
  return { release, done: tx };
}

describe('#2181 the wire', () => {
  it('Channel.incarnation, the page envelope and the read-state labels are in the schema', () => {
    const schema = buildSchema(typeDefs);
    const ok = (q: string) => expect(validate(schema, parse(q))).toEqual([]);
    ok('{ channel(ref: "x") { incarnation } }');
    ok('{ teamChatMessages(appRef: "x") { channelId channelIncarnation total } }');
    ok('{ channelMessages(channelRef: "x", expectedIncarnation: 1) { channelId channelIncarnation total } }');
    ok('{ channelReadState(attendeeRef: "w", channelRef: "c") { channelIncarnation cursorIncarnation lastSeenSeq } }');
    ok('mutation { markOwnTeamChatRead(appRef: "a", sessionRef: "s", channelRef: "c", seq: 1, expectedIncarnation: 1) { channelIncarnation cursorIncarnation lastSeenSeq } }');
    // The convenience read takes no pin.
    expect(validate(schema, parse('{ teamChatMessages(appRef: "x", expectedIncarnation: 1) { total } }'))).toHaveLength(1);
  });

  it('both reads name the channel and its incarnation; an omitted pin is today\'s read plus those fields', async () => {
    await post('one');
    const viaApp = await Q.teamChatMessages({}, { appRef: app.id, sinceSeq: 0 }, userCtx());
    expect(viaApp).toMatchObject({ total: 1, channelId: channel.id, channelIncarnation: 1 });
    const viaRef = await Q.channelMessages({}, { channelRef: channel.id, sinceSeq: 0 }, userCtx());
    expect(viaRef).toMatchObject({ total: 1, channelId: channel.id, channelIncarnation: 1 });
    await recreate();
    expect(await Q.channelMessages({}, { channelRef: channel.id, sinceSeq: 0 }, userCtx())).toMatchObject({ channelIncarnation: 2 });
  });

  it('an App with no team channel yet answers a null envelope', async () => {
    const empty = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Empty', urn: `${org.urn}:empty` } });
    await db.appMember.create({ data: { appId: empty.id, userId: user.id, role: 'admin' } });
    expect(await Q.teamChatMessages({}, { appRef: empty.id }, userCtx())).toMatchObject({ items: [], total: 0 });
  });
});

describe('#2181 the mark fence', () => {
  it('a current pin marks, labels the cursor and answers both incarnations', async () => {
    await post('one'); await post('two');
    expect(await mark(2, 1)).toEqual({ workerId: worker.id, channelId: channel.id, lastSeenSeq: 2, channelIncarnation: 1, cursorIncarnation: 1 });
    expect(await readState()).toMatchObject({ lastSeenSeq: 2, channelIncarnation: 1 });
  });

  it('a stale pin is CHANGED and writes nothing: no cursor, no check stamp', async () => {
    await post('one');
    await recreate();
    await expect(mark(1, 1)).rejects.toMatchObject(changed(2));
    expect(await readState()).toBeNull();
  });

  it('a stale pin never reads as SEQ_BEYOND_WATERMARK when the replacement\'s watermark is lower', async () => {
    await post('one'); await post('two');
    await recreate(); // lastSeq 0
    await expect(mark(2, 1)).rejects.toMatchObject(changed(2));
  });

  it('an omitted pin keeps the unfenced path, and still labels what it raises', async () => {
    await post('one');
    await recreate();
    await post('two');
    const out = await mark(1);
    expect(out).toMatchObject({ lastSeenSeq: 1, channelIncarnation: 2, cursorIncarnation: 2 });
  });

  it('a fenced response is its own proof for a legacy NULL cursor already past the mark, H=0 included', async () => {
    await post('one'); await post('two');
    await db.channelReadState.create({ data: { id: generateId(), workerId: worker.id, channelId: channel.id, lastSeenSeq: 2 } });
    for (const h of [1, 0]) {
      expect(await mark(h, 1)).toEqual({ workerId: worker.id, channelId: channel.id, lastSeenSeq: 2, channelIncarnation: 1, cursorIncarnation: null });
    }
    expect(await readState()).toMatchObject({ lastSeenSeq: 2, channelIncarnation: null }); // never relabelled
    // an equal-or-lower mark never relabels a labelled cursor either
    await recreate();
    await post('three');
    await db.channelReadState.updateMany({ where: { workerId: worker.id, channelId: channel.id }, data: { channelIncarnation: 1 } });
    expect(await mark(2, 2)).toMatchObject({ lastSeenSeq: 2, channelIncarnation: 2, cursorIncarnation: 1 });
  });

  it('an old high cursor under a replacement reads back as a different cursor incarnation', async () => {
    await post('one'); await post('two');
    await mark(2, 1);
    await recreate();
    const state = await Q.channelReadState({}, { attendeeRef: worker.id, appRef: app.id, channelRef: channel.id }, userCtx());
    expect(state).toMatchObject({ lastSeenSeq: 2, channelIncarnation: 2, cursorIncarnation: 1 });
  });

  it('every refusal ahead of the fence still writes nothing: another user, a revoked register row, a missing channel', async () => {
    await post('one');
    await expect(M.markOwnTeamChatRead({}, { appRef: app.id, sessionRef: sessionId, channelRef: channel.id, seq: 1, expectedIncarnation: 1 },
      { db, userId: otherUser.id, roles: ['READER'] } as Context)).rejects.toMatchObject({ extensions: { code: 'SESSION_NOT_LIVE' } });
    await db.registerEntry.updateMany({ where: { channelId: channel.id }, data: { role: 'POST' } });
    await expect(mark(1, 1)).rejects.toMatchObject({ extensions: { code: 'CHANNEL_NOT_FOUND' } });
    await expect(M.markOwnTeamChatRead({}, { appRef: app.id, sessionRef: sessionId, channelRef: generateId(), seq: 1, expectedIncarnation: 1 }, userCtx()))
      .rejects.toMatchObject({ extensions: { code: 'CHANNEL_NOT_FOUND' } });
    expect(await readState()).toBeNull();
  });

  it('a pinned mark past the watermark of the pinned incarnation is SEQ_BEYOND_WATERMARK', async () => {
    await post('one');
    await expect(mark(5, 1)).rejects.toMatchObject({ extensions: { code: 'SEQ_BEYOND_WATERMARK', lastSeq: 1 } });
  });

  it('a session that ends while the mark waits for the Channel row is refused with nothing written', async () => {
    await post('one');
    const held = await holdChannelRowForUpdate();
    const marking = mark(1, 1).then((v: unknown) => ({ v }), (e: unknown) => ({ e }));
    await waitForLockWaiters(db, 1);
    await db.session.update({ where: { id: sessionId }, data: { endedAt: new Date() } });
    held.release();
    await held.done;
    expect(((await marking) as { e?: unknown }).e).toMatchObject({ extensions: { code: 'SESSION_NOT_LIVE' } });
    expect(await readState()).toBeNull();
  });

  it('the refusal names the channel, says it was recreated and says not to repeat the call', async () => {
    await post('one');
    await recreate();
    await expect(mark(1, 1)).rejects.toThrow(new RegExp(`Channel ${channel.id} was recreated since you read it \\(it is now incarnation 2, you pinned 1\\).*do not repeat this call`));
  });

  it('a lapsed session resumes only with the mark, and a refused mark leaves it lapsed', async () => {
    await post('one');
    await goneQuiet();
    const before = (await sessionRow()).updatedAt!.getTime();
    await recreate();
    await expect(mark(1, 1)).rejects.toMatchObject(changed(2));
    expect((await sessionRow()).updatedAt!.getTime()).toBe(before);
    expect(await readState()).toBeNull();
    await mark(0, 2);
    expect((await sessionRow()).updatedAt!.getTime()).toBeGreaterThan(before);
  });

  describe('both winner orders against a recreation', () => {
    it('recreation first: the mark waits on the Channel row, then refuses with no effects', async () => {
      await post('one');
      await goneQuiet();
      const before = (await sessionRow()).updatedAt!.getTime();
      const held = await holdRecreation();
      const marking = mark(1, 1).then((v: unknown) => ({ v }), (e: unknown) => ({ e }));
      await waitForLockWaiters(db, 1);
      held.release();
      await held.done;
      const out = (await marking) as { e?: unknown };
      expect(out.e).toMatchObject(changed(2));
      expect(await readState()).toBeNull();
      expect((await sessionRow()).updatedAt!.getTime()).toBe(before);
    });

    it('mark first: the recreation waits for the mark, which commits under the old incarnation', async () => {
      await post('one');
      await mark(1, 1); // row exists, labelled 1
      await post('two');
      const held = await holdReadStateRow();
      const marking = mark(2, 1);
      await waitForLockWaiters(db, 1); // the mark holds the Channel row FOR SHARE and waits on the cursor row
      const recreating = recreateOnOwnConnection();
      await waitForLockWaiters(db, 2); // the recreation waits on the mark's Channel row lock
      held.release();
      await held.done;
      expect(await marking).toMatchObject({ lastSeenSeq: 2, channelIncarnation: 1, cursorIncarnation: 1 });
      await recreating;
      const state = await Q.channelReadState({}, { attendeeRef: worker.id, appRef: app.id, channelRef: channel.id }, userCtx());
      expect(state).toMatchObject({ lastSeenSeq: 2, channelIncarnation: 2, cursorIncarnation: 1 });
    });
  });
});

describe('#2181 the pinned read', () => {
  it('a current pin reads and advances; a stale pin before the read returns nothing and moves nothing', async () => {
    await post('one');
    expect(await readPinned(1)).toMatchObject({ total: 1, channelId: channel.id, channelIncarnation: 1 });
    expect(await readState()).toMatchObject({ lastSeenSeq: 1, channelIncarnation: 1 });
    await db.channelReadState.deleteMany({ where: { channelId: channel.id } });
    await recreate();
    await expect(readPinned(1)).rejects.toMatchObject(changed(2));
    expect(await readState()).toBeNull();
  });

  it('recreation between the final page check and the effects: refused, no stamp, no cursor, no revive', async () => {
    await post('one');
    await goneQuiet();
    const before = (await sessionRow()).updatedAt!.getTime();
    const held = await holdRecreation(); // committed state still shows incarnation 1, so both page checks pass
    const reading = readPinned(1).then((v: unknown) => ({ v }), (e: unknown) => ({ e }));
    await waitForLockWaiters(db, 1); // the effects transaction is blocked on the Channel row
    held.release();
    await held.done;
    expect(((await reading) as { e?: unknown }).e).toMatchObject(changed(2));
    expect(await readState()).toBeNull();
    expect((await sessionRow()).updatedAt!.getTime()).toBe(before);
  });

  it('recreation after the effects: they commit under the old incarnation the page proved', async () => {
    await post('one');
    await db.channelReadState.create({ data: { id: generateId(), workerId: worker.id, channelId: channel.id, lastSeenSeq: 0, channelIncarnation: 1 } });
    const held = await holdReadStateRow();
    const reading = readPinned(1);
    await waitForLockWaiters(db, 1);
    const recreating = recreateOnOwnConnection();
    await waitForLockWaiters(db, 2);
    held.release();
    await held.done;
    expect(await reading).toMatchObject({ total: 1, channelIncarnation: 1 });
    await recreating;
    expect(await readState()).toMatchObject({ lastSeenSeq: 1, channelIncarnation: 1 });
  });


  it('a recreation committing between the page read and the closing check refuses the page, even with no session to fence', async () => {
    await post('one');
    let recreated = false;
    const racing = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== 'node') return Reflect.get(target, prop, receiver);
        return new Proxy(target.node, {
          get(node, method, nodeReceiver) {
            if (method !== 'findMany') return Reflect.get(node, method, nodeReceiver);
            return async (...args: unknown[]) => {
              const rows = await (node.findMany as (...a: unknown[]) => Promise<unknown>)(...args);
              if (!recreated) { recreated = true; await recreate(); }
              return rows;
            };
          },
        });
      },
    });
    await expect(Q.channelMessages({}, { channelRef: channel.id, sinceSeq: 0, expectedIncarnation: 1 }, { db: racing, userId: user.id, roles: ['READER'] } as Context))
      .rejects.toMatchObject(changed(2));
    expect(recreated).toBe(true);
  });

  it('the cursor label is written by every attendee kind, only on a raise', async () => {
    await post('one'); await post('two');
    const labelOf = async (where: Record<string, unknown>) => (await db.channelReadState.findFirstOrThrow({ where: { channelId: channel.id, ...where } })).channelIncarnation;
    await advanceReadState(db, { workerId: worker.id }, channel.id, 1);
    await advanceReadState(db, { agentId: agent.id, appId: app.id }, channel.id, 1);
    expect(await labelOf({ workerId: worker.id })).toBe(1);
    expect(await labelOf({ agentId: agent.id })).toBe(1);
    await recreate();
    await advanceReadState(db, { workerId: worker.id }, channel.id, 1); // equal: no relabel
    await advanceReadState(db, { agentId: agent.id, appId: app.id }, channel.id, 1);
    expect(await labelOf({ workerId: worker.id })).toBe(1);
    expect(await labelOf({ agentId: agent.id })).toBe(1);
    await advanceReadState(db, { workerId: worker.id }, channel.id, 2); // a raise: relabelled to the live incarnation
    await advanceReadState(db, { agentId: agent.id, appId: app.id }, channel.id, 2);
    expect(await labelOf({ workerId: worker.id })).toBe(2);
    expect(await labelOf({ agentId: agent.id })).toBe(2);
  });

  it('a mentions read is fenced the same way: refused with no delivery mark and no stamp', async () => {
    await post('hello @dara', { mentions: ['dara'] });
    const held = await holdRecreation();
    const reading = readPinned(1, { mentionsRef: worker.id }).then((v: unknown) => ({ v }), (e: unknown) => ({ e }));
    await waitForLockWaiters(db, 1);
    held.release();
    await held.done;
    expect(((await reading) as { e?: unknown }).e).toMatchObject(changed(2));
    expect(await readState()).toBeNull();
    expect(await db.workerDeliveryChannel.count({ where: { workerId: worker.id } })).toBe(0);
  });

  it('a pinned read that opts out of the cursor still stamps the check, moves no position, and is still fenced', async () => {
    await post('one');
    await readPinned(1, { advanceReadState: false });
    expect(await readState()).toMatchObject({ lastSeenSeq: 0 });
    expect((await readState())?.lastCheckedAt).not.toBeNull();
    await db.channelReadState.deleteMany({ where: { channelId: channel.id } });
    await recreate();
    await expect(readPinned(1, { advanceReadState: false })).rejects.toMatchObject(changed(2));
    expect(await readState()).toBeNull();
  });

  it('a session that ends while the read waits for the Channel row gets no effects', async () => {
    await post('one');
    const held = await holdChannelRowForUpdate();
    const reading = readPinned(1).then((v: unknown) => ({ v }), (e: unknown) => ({ e }));
    await waitForLockWaiters(db, 1);
    await db.session.update({ where: { id: sessionId }, data: { endedAt: new Date() } });
    held.release();
    await held.done;
    await reading;
    expect(await readState()).toBeNull();
  });

  it('the pinned mentions stamp comes after the wake lock: the read waits for it holding no read-state row', async () => {
    await post('hello @dara', { mentions: ['dara'] });
    await db.channelReadState.create({ data: { id: generateId(), workerId: worker.id, channelId: channel.id, lastSeenSeq: 0, channelIncarnation: 1 } });
    // Another transaction holds the worker's wake lock (as acknowledgeDeliveryBatches does before it raises read state).
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const ready = new Promise<void>((r) => { locked = r; });
    const wake = db.$transaction(async (t) => {
      await t.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'wake:' + worker.id}, 0))`;
      locked();
      await gate;
    }, { timeout: 30_000 });
    await ready;
    const reading = readPinned(1, { mentionsRef: worker.id });
    await waitForLockWaiters(db, 1); // the read is blocked on the wake lock
    const probe = new Client({ connectionString: process.env.DATABASE_URL });
    await probe.connect();
    try {
      // The read holds no lock on the read-state row yet: an ack-style writer can take it without waiting (no cycle).
      await probe.query('BEGIN');
      await expect(probe.query('SELECT id FROM channel_read_states WHERE worker_id = $1 AND channel_id = $2 FOR UPDATE NOWAIT', [worker.id, channel.id]))
        .resolves.toBeDefined();
      await probe.query('ROLLBACK');
    } finally {
      await probe.end();
    }
    release();
    await wake;
    expect(await reading).toMatchObject({ total: 1 });
    expect((await readState())?.lastCheckedAt).not.toBeNull(); // the pinned mentions read still counts as a check
  });
});

describe('#2181 MCP parity', () => {
  it('reads end with the envelope line, a pinned stale read is [channel_incarnation_changed], marks take the pin', async () => {
    await post('one');
    const server = createTestableMcpServer({ ...mcpAuth(), sessionId });
    const read = await server.callToolText('hadron_channel_read', { channel: channel.id, sinceSeq: 0, session: sessionId });
    expect(read.trimEnd().endsWith(`channel ${channel.id} incarnation 1`)).toBe(true);
    const team = await server.callToolText('hadron_team_chat_read', { sinceSeq: 0, session: sessionId, app: app.id });
    expect(team.trimEnd().endsWith(`channel ${channel.id} incarnation 1`)).toBe(true);
    const ok = await server.callToolText('hadron_team_chat_mark_read', { session: sessionId, app: app.id, channel: channel.id, seq: 1, expectedIncarnation: 1 });
    expect(ok).toContain('"channelIncarnation": 1');
    expect(ok).toContain('"cursorIncarnation": 1');
    await recreate();
    const stale = await server.callToolText('hadron_team_chat_mark_read', { session: sessionId, app: app.id, channel: channel.id, seq: 1, expectedIncarnation: 1 });
    expect(stale).toContain('[channel_incarnation_changed]');
    expect(stale).toContain('now incarnation 2');
    const staleRead = await server.callToolText('hadron_channel_read', { channel: channel.id, sinceSeq: 0, session: sessionId, expectedIncarnation: 1 });
    expect(staleRead).toContain('[channel_incarnation_changed]');
  });
});
