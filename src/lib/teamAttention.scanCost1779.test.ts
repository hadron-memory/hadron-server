import { WORKER_SIGNATURE_DEFAULTS } from './workerSignature.js';
/**
 * #1779 — a complete teamAttentionPage scan must not cost O(backlog / 50)
 * round trips each re-resolving the whole roster.
 *
 * Fixture (Coco's measurement shape, scaled to the test DB): 50 live workers,
 * one plaintext Channel with a ~8,200 head, 45 near-head cursors and 5 dormant
 * cursors near #1. On main a full scan was 164 pages (59 s on a disposable
 * stack) and a router poll with ONE new message re-walked all of them, because
 * the stale cursors pin the frozen span's floor.
 *
 * Structural assertions (not timing-flaky) carry the contract; the wall-clock
 * smoke is a generous ceiling far under the gateway budget.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbWorkerAttribution, suspendChatSeqUniqueness } from '../test/helpers.js';
import { generateId } from './id.js';
import { ensureChannelWithRoot } from './channels.js';
import { sessionKeyCache } from './sessionKeyCache.js';
import type { Context } from '../api/graphql/schema/resolvers.js';
import { aggregatePlaintextWindow, teamAttentionPage } from './teamAttention.js';

vi.mock('./bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const HEAD = 8_200;
const WORKERS = 50;
const STALE = 5;
const NEAR_HEAD = 8_150;

let user: { id: string };
let app: { id: string; urn: string };
let channel: { id: string; memoryId: string; loc: string };
let workerIds: string[] = [];

const ctx = (): Context => ({ db, userId: user.id, roles: ['READER'] }) as Context;

async function appendMessages(from: number, to: number, mentionsOnEvery = 0) {
  const rows = [];
  for (let seq = from; seq <= to; seq++) {
    rows.push({
      id: generateId(), memoryId: channel.memoryId, loc: `${channel.loc}:messages:${seq}`, name: String(seq),
      nodeType: 'chat-message', seq, messageChannelId: channel.id, content: `m${seq}`,
      data: { mentions: mentionsOnEvery && seq % mentionsOnEvery === 0 ? ['@all'] : [] },
    });
  }
  await db.node.createMany({ data: rows });
  await db.channel.update({ where: { id: channel.id }, data: { lastSeq: to } });
}

async function scan(since?: string | null) {
  const items: Array<{ worker: string; unread: number; unreadMentions: number; firstUnreadSeq: number | null; lastSeq: number }> = [];
  let page: string | null = null;
  let pages = 0;
  let adoptable: string | null = null;
  for (let guard = 0; guard < 400; guard++) {
    const r = await teamAttentionPage(ctx(), app.id, { since: page ? null : since ?? null, page });
    pages++;
    items.push(...r.items);
    if (r.scanComplete) { adoptable = r.adoptableSince; break; }
    page = r.nextPage;
    if (!page) break;
  }
  return { items, pages, adoptable };
}

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  const org = await db.organization.create({ data: { id: generateId(), name: 'cost', urn: `cost-${suffix}.com` } });
  user = await db.user.create({ data: { id: generateId(), githubId: 1779001, githubUsername: `cost-${suffix}` } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Pilot', urn: `${org.urn}:pilot` } });
  const agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team`, visibility: 'ORGANIZATION' } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await db.appMember.create({ data: { appId: app.id, userId: user.id, role: 'admin' } });
  const memory = await db.memory.create({
    data: {
      id: generateId(), organizationId: org.id, urn: `${org.urn}:pilot-shared`, name: 'shared', class: 'app',
      appId: app.id, sharedMemoryOfAgentId: agent.id,
    },
  });
  const made = await ensureChannelWithRoot(db, {
    memoryId: memory.id, loc: 'chats:team', name: 'team', createdBy: user.id, asDefaultOfAppId: app.id,
  });
  channel = { id: made.channel.id, memoryId: memory.id, loc: 'chats:team' };
  workerIds = [];
  for (let i = 0; i < WORKERS; i++) {
    const w = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name: `W${String(i).padStart(2, '0')}`, slug: `w${i}` } });
    workerIds.push(w.id);
    await db.registerEntry.create({
      data: { id: generateId(), appId: app.id, channelId: channel.id, attendeeWorkerId: w.id, role: 'BOTH', mentionOnly: i % 10 === 9 },
    });
    await db.session.create({
      data: { id: generateId(), appId: app.id, userId: user.id, workerId: w.id, agentId: agent.id, type: 'DEVELOPER', startedAt: new Date() },
    });
    await db.channelReadState.create({
      data: { id: generateId(), workerId: w.id, appId: app.id, channelId: channel.id, lastSeenSeq: i < STALE ? 2 : NEAR_HEAD },
    });
  }
  await appendMessages(1, HEAD, 7);
}, 120_000);

afterEach(() => {
  delete process.env.TEAM_ATTENTION_TOKEN_SECRET;
  sessionKeyCache.clear();
});

describe('#1779 — scan cost is independent of backlog depth', () => {
  it('a complete scan with stale cursors near #1 finishes in a handful of pages, under the gateway budget', async () => {
    const t0 = Date.now();
    const { items, pages } = await scan();
    const elapsed = Date.now() - t0;


    expect(pages).toBeLessThanOrEqual(5); // main: 164
    expect(elapsed).toBeLessThan(15_000); // main: ~59 s at 50 workers on a full stack
    // Counts stay exact: stale cursors count their whole backlog, near-head ones the tail.
    const byWorker = new Map(items.map((i) => [i.worker, i]));
    expect(byWorker.get(workerIds[0])).toMatchObject({ unread: HEAD - 2, lastSeq: HEAD });
    expect(byWorker.get(workerIds[STALE + 1])).toMatchObject({ unread: HEAD - NEAR_HEAD, lastSeq: HEAD });
  }, 120_000);

  it('a router poll with ONE new message does not re-walk the stale-cursor span page by page', async () => {
    const first = await scan();
    expect(first.adoptable).toBeTruthy();
    await appendMessages(HEAD + 1, HEAD + 1);

    const t0 = Date.now();
    const next = await scan(first.adoptable);
    const elapsed = Date.now() - t0;

    expect(next.pages).toBeLessThanOrEqual(5); // main: 164
    expect(elapsed).toBeLessThan(15_000);
    // Only relevance since the watermark is emitted: every target gains the one new message.
    expect(next.items.length).toBeGreaterThan(0);
    // Counts stay exact on the headline production scenario: a dormant cursor still reports its
    // whole backlog (now including the new message), a near-head one just its tail.
    const byWorker = new Map(next.items.map((i) => [i.worker, i]));
    expect(byWorker.get(workerIds[0])).toMatchObject({
      unread: HEAD + 1 - 2, firstUnreadSeq: 3, lastSeq: HEAD + 1,
    });
    expect(byWorker.get(workerIds[STALE + 1])).toMatchObject({
      unread: HEAD + 1 - NEAR_HEAD, firstUnreadSeq: NEAR_HEAD + 1, lastSeq: HEAD + 1,
    });
  }, 120_000);
});

describe('#1779 — the SQL aggregate counts exactly what the row walk counted', () => {
  it.each([undefined, 1])('matches a JS reference over awkward rows (scanLimit %s)', async (scanLimit) => {
    // Rebuild a small, awkward channel: own posts, broadcast and named mentions,
    // a non-array mentions value, null data, a deleted row, mention-only targets.
    await db.node.deleteMany({ where: { messageChannelId: channel.id } });
    await db.channelReadState.deleteMany({ where: { channelId: channel.id } });
    const named = (i: number) => `w${String(i).padStart(2, '0')}`;
    const rows: Array<{ seq: number; data: unknown; deleted?: boolean }> = [];
    for (let seq = 1; seq <= 700; seq++) {
      let data: unknown = { mentions: [] };
      // #2020: a broadcast is a mention only with a strictly boolean post-time stamp.
      if (seq % 22 === 0) data = { mentions: ['all'], broadcastWakes: true };
      else if (seq % 11 === 0) data = { mentions: ['all'] };
      else if (seq % 29 === 0) data = { mentions: ['team'], broadcastWakes: 'true' };
      else if (seq % 31 === 0) data = { mentions: ['team'], broadcastWakes: true };
      else if (seq % 13 === 0) data = { mentions: [named(3)] };
      else if (seq % 17 === 0) data = { mentions: 'w09' };
      else if (seq % 19 === 0) data = null;
      else if (seq % 7 === 0) data = { mentions: [], authorWorkerId: workerIds[seq % 5] };
      rows.push({ seq, data, deleted: seq % 23 === 0 });
    }
    await db.node.createMany({
      data: rows.map((r) => ({
        id: generateId(), memoryId: channel.memoryId, loc: `${channel.loc}:messages:${r.seq}`, name: String(r.seq),
        nodeType: 'chat-message', seq: r.seq, messageChannelId: channel.id, content: 'x',
        ...(r.data === null ? {} : { data: r.data as object }),
        ...(r.deleted ? { deletedAt: new Date() } : {}),
      })),
    });
    await db.channel.update({ where: { id: channel.id }, data: { lastSeq: 700 } });
    const seenOf = (i: number) => (i % 4 === 0 ? 0 : i * 9);
    for (let i = 0; i < WORKERS; i++) {
      await db.channelReadState.create({
        data: { id: generateId(), workerId: workerIds[i], appId: app.id, channelId: channel.id, lastSeenSeq: seenOf(i) },
      });
    }

    const got = new Map<string, { unread: number; unreadMentions: number; firstUnreadSeq: number | null }>();
    let page: string | null = null;
    for (let guard = 0; guard < 400; guard++) {
      const r: Awaited<ReturnType<typeof teamAttentionPage>> = await teamAttentionPage(ctx(), app.id, { page, scanLimit });
      for (const it of r.items) got.set(it.worker, it);
      if (r.scanComplete) break;
      page = r.nextPage;
    }

    for (let i = 0; i < WORKERS; i++) {
      const mentionOnly = i % 10 === 9;
      const tokens = [named(i)];
      let unread = 0; let ment = 0; let first = 0;
      for (const r of rows) {
        if (r.deleted || r.seq <= seenOf(i)) continue;
        const d = (r.data && typeof r.data === 'object') ? r.data as { mentions?: unknown; authorWorkerId?: string; broadcastWakes?: unknown } : {};
        if (d.authorWorkerId === workerIds[i]) continue;
        unread++;
        if (first === 0) first = r.seq;
        const ms = Array.isArray(d.mentions) ? d.mentions.filter((m): m is string => typeof m === 'string') : [];
        if (ms.some((m) => tokens.includes(m)) || (d.broadcastWakes === true && ms.some((m) => m === 'all' || m === 'team'))) ment++;
      }
      const item = got.get(workerIds[i]);
      if (unread === 0) { expect(item).toBeUndefined(); continue; }
      // mention-only targets are still counted; relevance only gates emission.
      expect(item, `worker ${i}${mentionOnly ? ' (mention-only)' : ''}`).toMatchObject({
        unread, firstUnreadSeq: first,
      });
      expect(item!.unreadMentions).toBe(ment);
    }
  }, 120_000);
});

async function resetTeamChannel(rows: number, mentions: string[] = []) {
  await db.node.deleteMany({ where: { messageChannelId: channel.id } });
  await db.channelReadState.deleteMany({ where: { channelId: channel.id } });
  await db.node.createMany({
    data: Array.from({ length: rows }, (_v, i) => ({
      id: generateId(), memoryId: channel.memoryId, loc: `${channel.loc}:messages:${i + 1}`, name: String(i + 1),
      nodeType: 'chat-message', seq: i + 1, messageChannelId: channel.id, content: 'x', data: { mentions },
    })),
  });
  await db.channel.update({ where: { id: channel.id }, data: { lastSeq: rows } });
}

async function drain(scanLimit?: number) {
  const items: Array<{ worker: string; channel: string; unread: number; unreadMentions: number }> = [];
  let page: string | null = null;
  let pages = 0;
  for (let guard = 0; guard < 400; guard++) {
    const r: Awaited<ReturnType<typeof teamAttentionPage>> = await teamAttentionPage(ctx(), app.id, { page, scanLimit });
    pages++;
    items.push(...r.items);
    if (r.scanComplete) break;
    page = r.nextPage;
  }
  return { items, pages };
}

describe('#1779 §10 — the aggregate is scoped to its own Channel', () => {
  it('another org\'s Channel with rows in the same seq range never moves a target\'s counts', async () => {
    await resetTeamChannel(100); // no mentions
    // A different org's Channel, rows at the SAME seqs, every one broadcast-mentioning.
    const otherOrg = await db.organization.create({ data: { id: generateId(), name: 'foreign', urn: `foreign-${Date.now()}.com` } });
    const otherMemory = await db.memory.create({
      data: { id: generateId(), organizationId: otherOrg.id, urn: `${otherOrg.urn}:chat`, name: 'chat', class: 'knowledge' },
    });
    const foreign = await ensureChannelWithRoot(db, {
      memoryId: otherMemory.id, loc: 'chats:other', name: 'other', createdBy: user.id,
    });
    await db.node.createMany({
      data: Array.from({ length: 100 }, (_v, i) => ({
        id: generateId(), memoryId: otherMemory.id, loc: `chats:other:messages:${i + 1}`, name: String(i + 1),
        nodeType: 'chat-message', seq: i + 1, messageChannelId: foreign.channel.id, content: 'secret',
        data: { mentions: ['all'] },
      })),
    });
    await db.channel.update({ where: { id: foreign.channel.id }, data: { lastSeq: 100 } });

    const { items } = await drain();
    const mine = items.filter((i) => i.worker === workerIds[10] && i.channel === channel.id);
    expect(mine).toHaveLength(1);
    // Exactly this Channel's 100 rows and none of the foreign 100 mentions.
    expect(mine[0]).toMatchObject({ unread: 100, unreadMentions: 0 });
    expect(items.some((i) => i.channel === foreign.channel.id)).toBe(false);
  }, 120_000);
});

describe('#1779 — the per-request plaintext ceiling', () => {
  it('stops a request after two windows across Channels (it does not ride the visit cap)', async () => {
    // Three plaintext Channels of 450 rows, one registered worker. scanLimit 1 means a 200-seq
    // window and a 400-seq request ceiling. Each Channel costs 450 seqs (200 + 200 + 50), 1,350 in
    // all, so the ceiling makes it ceil(1350 / 400) = 4 pages. Without the ceiling the visit cap
    // alone (2 x channels = 6 windows) would finish in 2 pages.
    await resetTeamChannel(0);
    await db.registerEntry.deleteMany({ where: { channelId: channel.id } });
    const chans = [];
    for (const name of ['a', 'b', 'c']) {
      const made = await ensureChannelWithRoot(db, {
        memoryId: channel.memoryId, loc: `chats:${name}`, name, createdBy: user.id,
      });
      await db.registerEntry.create({
        data: { id: generateId(), appId: app.id, channelId: made.channel.id, attendeeWorkerId: workerIds[10], role: 'BOTH' },
      });
      await db.node.createMany({
        data: Array.from({ length: 450 }, (_v, i) => ({
          id: generateId(), memoryId: channel.memoryId, loc: `chats:${name}:messages:${i + 1}`, name: String(i + 1),
          nodeType: 'chat-message', seq: i + 1, messageChannelId: made.channel.id, content: 'x', data: { mentions: [] },
        })),
      });
      await db.channel.update({ where: { id: made.channel.id }, data: { lastSeq: 450 } });
      chans.push(made.channel.id);
    }
    const { items, pages } = await drain(1);
    expect(pages).toBe(4);
    for (const id of chans) {
      expect(items.find((i) => i.worker === workerIds[10] && i.channel === id)).toMatchObject({ unread: 450 });
    }
  }, 120_000);
});

describe('#1779 — an empty target list is a no-op, not a malformed query', () => {
  it('aggregatePlaintextWindow with no targets returns an empty result without touching SQL VALUES', async () => {
    await expect(aggregatePlaintextWindow(db, channel.id, 0, 100, [])).resolves.toEqual({
      perTarget: [], cursor: null, frontierLoc: null,
    });
  });
});

describe('#1783 — aggregatePlaintextWindow edge semantics', () => {
  const target = (over: Partial<Parameters<typeof aggregatePlaintextWindow>[4][number]> = {}) => ({
    index: 0, seen: 0, head: 100, workerId: 'w-target', mentionOnly: false, tokens: ['w00'], ...over,
  });
  const put = (seq: number, data: object, locSuffix = String(seq)) => db.node.create({
    data: {
      id: generateId(), memoryId: channel.memoryId, loc: `${channel.loc}:messages:${locSuffix}`, name: locSuffix,
      nodeType: 'chat-message', seq, messageChannelId: channel.id, content: 'x', data,
    },
  });
  beforeEach(async () => { await resetTeamChannel(0); });

  it('never counts a row above the target\'s frozen head', async () => {
    for (let seq = 1; seq <= 10; seq++) await put(seq, { mentions: [] });
    const r = await aggregatePlaintextWindow(db, channel.id, 0, 10, [target({ head: 6 })]);
    expect(r.perTarget).toEqual([{ index: 0, unread: 6, mentions: 0, first: 1, lastRelevant: 6 }]);
  });

  it('mention-only: lastRelevant is the last MENTIONING row, and null with none', async () => {
    for (let seq = 1; seq <= 9; seq++) await put(seq, { mentions: seq === 4 ? ['w00'] : [] });
    const only = await aggregatePlaintextWindow(db, channel.id, 0, 9, [target({ mentionOnly: true })]);
    expect(only.perTarget[0]).toMatchObject({ unread: 9, mentions: 1, lastRelevant: 4 });
    const none = await aggregatePlaintextWindow(db, channel.id, 0, 3, [target({ mentionOnly: true })]);
    expect(none.perTarget[0]).toMatchObject({ unread: 3, mentions: 0, lastRelevant: null });
    const both = await aggregatePlaintextWindow(db, channel.id, 0, 9, [target()]);
    expect(both.perTarget[0]).toMatchObject({ lastRelevant: 9 });
  });

  it('the frontier row is one a target actually COUNTED, as the row walk had it (duplicate seqs)', async () => {
    // Two rows at seq 5 (a pre-#919 artifact): the higher loc is the target's own post, which the
    // walk skipped, so the counted frontier is the lower-loc row. Planting
    // the duplicate needs #992's constraint aside (see the helper).
    await suspendChatSeqUniqueness(db);
    await put(4, { mentions: [] });
    await put(5, { mentions: [] }, '5a');
    await createDbWorkerAttribution(db, user.id, 'w-target');
    await put(5, { authorWorkerId: 'w-target', mentions: [] }, '5b');
    const r = await aggregatePlaintextWindow(db, channel.id, 0, 10, [target()]);
    expect(r.frontierLoc).toBe(`${channel.loc}:messages:5a`);
    expect(r.perTarget[0]).toMatchObject({ unread: 2, lastRelevant: 5 });
  });
});
