import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
/**
 * #2980 — a filtered chat read (a mentions read, and the encrypted reply/team-tag reads that share its in-memory
 * branch) costs what its page needs, not the whole chat history, whenever the caller does not select `total`.
 *
 * - The red pin: a no-cursor `limit: 1` mentions read over a long history reads a bounded number of rows.
 * - Parity: for every paging shape and reach case, `items` are the same with and without `total` selected, and with
 *   `total` selected it is the exact count (cor:api:120:02, cor:agt:020:04). Run at a tiny batch size so every read
 *   crosses batch boundaries, including a duplicate seq (a pre-#919 backfill) at a boundary.
 * - An unresolvable or cross-tenant `mentionsRef` is the same empty page, `total` 0, on both paths.
 * - The own-read advance (#2018) still sees a partial forward page as partial.
 * - #3001: parity compares message identity (urn), not seq, since duplicate seqs are in the fixture; a createdAt tie
 *   at one seq makes every keyset arm load-bearing; encrypted team-tag and head reads are pinned too.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parse, type FieldNode, type GraphQLResolveInfo, type OperationDefinitionNode, type FragmentDefinitionNode } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { ensureChannelWithRoot } from '../../../lib/channels.js';
import { encryptNodeFieldsWithKey } from '../../../lib/nodeCrypto.js';
import { generateDataKey } from '../../../lib/crypto.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { resolvers, type Context } from './resolvers.js';
import * as teamChat from './resolvers.teamChat.js';

vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const Q = resolvers.Query as any;
const ctx = (userId?: string, extra: Partial<Context> = {}): Context => ({ db, userId, roles: ['READER'], ...extra }) as Context;

/** A resolve info for `doc`'s first top-level field, as graphql-js builds it. */
function infoFor(doc: string): GraphQLResolveInfo {
  const parsed = parse(doc);
  const op = parsed.definitions.find((d) => d.kind === 'OperationDefinition') as OperationDefinitionNode;
  const fragments = Object.fromEntries(
    parsed.definitions.filter((d): d is FragmentDefinitionNode => d.kind === 'FragmentDefinition').map((f) => [f.name.value, f]),
  );
  return { fieldNodes: [op.selectionSet.selections[0] as FieldNode], fragments } as unknown as GraphQLResolveInfo;
}
const WITH_TOTAL = infoFor('{ channelMessages(channelRef: "x") { items { seq } total } }');
const ITEMS_ONLY = infoFor('{ channelMessages(channelRef: "x") { items { seq } } }');

// The batch size the bounded scan uses; absent on main, where every read is a full scan.
const tuning = (teamChat as unknown as { CHAT_FILTER_SCAN?: { batch: number; maxBatch: number } }).CHAT_FILTER_SCAN;
const defaults = tuning ? { ...tuning } : undefined;

type W = { id: string; name: string; holder: string; session: string };
let org: { id: string; urn: string };
let manager: { id: string };
let holderA: { id: string };
let holderB: { id: string };
let app: { id: string; urn: string };
let agent: { id: string };
let memory: { id: string };
let channel: { id: string; memoryId: string; loc: string; chatRootNodeId: string };
let liam: W;
let rook: W;

async function mkUser(n: number) {
  return db.user.create({ data: { id: generateId(), githubId: 98_400 + n, githubUsername: `ms-${n}-${Date.now()}-${Math.floor(Math.random() * 1e5)}`, roles: ['READER'] }, select: { id: true } });
}
async function mkWorker(name: string, holder: string): Promise<W> {
  const w = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name, slug: name.toLowerCase(), heldByUserId: holder, heldAt: new Date() }, select: { id: true, name: true } });
  await db.registerEntry.create({ data: { id: generateId(), appId: app.id, channelId: channel.id, attendeeWorkerId: w.id, role: 'BOTH' } });
  const session = await db.session.create({ data: { id: generateId(), appId: app.id, userId: holder, workerId: w.id, agentId: agent.id, type: 'DEVELOPER', startedAt: new Date() } });
  return { ...w, holder, session: session.id };
}
const humanSays = (userId: string, body: string, replyToSeq: number | null = null) =>
  teamChat.teamChatMutations.createTeamChatMessage({}, { appRef: app.id, body, replyToSeq, sessionRef: null }, ctx(userId));
const workerSays = (w: W, body: string, replyToSeq: number | null = null) =>
  runAsActor({ workerId: w.id, agentId: agent.id }, () =>
    teamChat.teamChatMutations.createTeamChatMessage({}, { appRef: app.id, body, replyToSeq, sessionRef: w.session }, ctx(w.holder)));

/** `n` filler messages that mention nobody, written in one statement (seq continues from the current top). */
async function filler(n: number): Promise<void> {
  const top = (await db.node.aggregate({ where: { memoryId: memory.id, nodeType: 'chat-message' }, _max: { seq: true } }))._max.seq ?? 0;
  await db.node.createMany({
    data: Array.from({ length: n }, (_, i) => {
      const seq = top + i + 1;
      const msgNum = String(seq).padStart(3, '0');
      return { id: generateId(), memoryId: memory.id, loc: `${channel.loc}:messages:${msgNum}-f`, name: msgNum, nodeType: 'chat-message', seq, messageChannelId: channel.id, content: `filler ${seq}`, data: { authorName: 'Ada', mentions: [] } };
    }),
  });
}

/**
 * A second row at an existing message's seq, as a pre-#919 backfill left them (same envelope, its own loc). By default
 * it copies the source's createdAt; pass `createdAt` and a `loc` to build a tie that orders on createdAt first.
 */
async function duplicateSeq(seq: number, opts: { createdAt?: Date; loc?: string } = {}): Promise<void> {
  const src = await db.node.findFirstOrThrow({ where: { memoryId: memory.id, nodeType: 'chat-message', seq }, orderBy: { createdAt: 'asc' } });
  const loc = opts.loc ?? `${src.loc}-dup`;
  await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc, name: loc.split(':').pop()!, nodeType: 'chat-message', seq, messageChannelId: channel.id, content: src.content, data: src.data as never, createdAt: opts.createdAt ?? src.createdAt } });
}

/** Message identity: two rows at one seq differ here, so a page that repeats one and drops its sibling cannot pass. */
const ids = (page: { items: Array<{ urn: string }> }): string[] => page.items.map((m) => m.urn);

/** Count every row `node.findMany` hands back while `fn` runs on the returned context. */
function countingCtx(base: Context): { ctx: Context; rows: () => number } {
  let rows = 0;
  const node = new Proxy(db.node, {
    get(target, prop, recv) {
      if (prop === 'findMany') {
        return async (args: unknown) => {
          const out = await (target.findMany as (a: unknown) => Promise<unknown[]>)(args);
          rows += out.length;
          return out;
        };
      }
      return Reflect.get(target, prop, recv);
    },
  });
  const counted = new Proxy(db, { get: (t, p, r) => (p === 'node' ? node : Reflect.get(t, p, r)) });
  return { ctx: { ...base, db: counted as typeof db }, rows: () => rows };
}

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'ms-org', urn: `ms-org-${suffix}.com` } });
  [manager, holderA, holderB] = [await mkUser(1), await mkUser(2), await mkUser(3)];
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: manager.id, role: 'ADMIN' } });
  agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team`, visibility: 'ORGANIZATION' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  for (const u of [holderA, holderB]) await db.appMember.create({ data: { appId: app.id, userId: u.id, role: 'member' } });
  memory = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:team-shared`, name: 'shared', class: 'app', appId: app.id, sharedMemoryOfAgentId: agent.id } });
  const made = await ensureChannelWithRoot(db, { memoryId: memory.id, loc: 'chats:team', name: 'team', createdBy: manager.id, asDefaultOfAppId: app.id });
  channel = { id: made.channel.id, memoryId: memory.id, loc: 'chats:team', chatRootNodeId: made.rootId };
  liam = await mkWorker('Liam', holderA.id);
  rook = await mkWorker('Rook', holderB.id);
});

afterEach(() => {
  if (tuning && defaults) Object.assign(tuning, defaults);
  sessionKeyCache.evict('ms-2980');
});

describe('the red pin: a no-cursor limit-1 mentions read over a long history', () => {
  it('reads a bounded number of rows when total is not selected, and returns the newest mention', async () => {
    await humanSays(manager.id, 'early @liam');
    await filler(3000);
    await humanSays(manager.id, 'ping @liam');
    await filler(5);
    const last = await humanSays(manager.id, 'again @liam');
    await filler(5);
    const { ctx: counted, rows } = countingCtx(ctx(liam.holder));
    const page = await Q.teamChatMessages({}, { appRef: app.id, mentionsRef: liam.id, limit: 1 }, counted, ITEMS_ONLY);
    expect(page.items.map((m: any) => m.seq)).toEqual([last.seq]);
    // One batch reaches the newest mention; a whole-history scan reads all ~3013 rows.
    expect(rows()).toBeLessThanOrEqual(400);
  }, 30_000);

  it('a sparse filter stays bounded: the next older match at the far end is never read for a backward page', async () => {
    await humanSays(manager.id, 'long ago @liam');
    await filler(3000);
    const last = await humanSays(manager.id, 'now @liam');
    await filler(5);
    const { ctx: counted, rows } = countingCtx(ctx(liam.holder));
    const page = await Q.teamChatMessages({}, { appRef: app.id, mentionsRef: liam.id, limit: 1 }, counted, ITEMS_ONLY);
    expect(page.items.map((m: any) => m.seq)).toEqual([last.seq]);
    expect(rows()).toBeLessThanOrEqual(400);
  }, 30_000);

  it('with total selected the count stays exact (the full scan is kept for it)', async () => {
    await humanSays(manager.id, 'early @liam');
    await filler(300);
    await humanSays(manager.id, 'ping @liam');
    const page = await Q.teamChatMessages({}, { appRef: app.id, mentionsRef: liam.id, limit: 1 }, ctx(liam.holder), WITH_TOTAL);
    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(1);
  });
});

describe('parity: items are the same with and without total, at a batch size that crosses boundaries', () => {
  /** A history mixing direct mentions, a stamped broadcast, the worker's own broadcast, other workers' mentions and a duplicate seq. */
  async function history(): Promise<{ liamSeqs: number[] }> {
    const seqs: number[] = [];
    seqs.push((await humanSays(manager.id, 'one @liam')).seq);
    await filler(4);
    seqs.push((await humanSays(manager.id, 'all hands @all')).seq);   // stamped: reaches every worker
    await workerSays(liam, 'my own @all');                            // own post: never on the author's read
    await workerSays(liam, 'hey @rook');                              // Rook's, not Liam's
    await filler(3);
    const dup = (await humanSays(manager.id, 'two @liam')).seq;
    await duplicateSeq(dup);                                          // two rows at one seq
    seqs.push(dup, dup);
    const parent = await humanSays(manager.id, 'thread start');
    seqs.push((await workerSays(rook, 'reply to @liam', parent.seq)).seq);
    await filler(2);
    seqs.push((await humanSays(manager.id, 'three @liam')).seq);
    await filler(1);
    return { liamSeqs: seqs };
  }

  const shapes: Array<[string, Record<string, unknown>]> = [
    ['newest page, limit 1', { limit: 1 }],
    ['newest page, limit 2', { limit: 2 }],
    ['newest page, larger than the matches', { limit: 50 }],
    ['forward from 0, limit 2', { sinceSeq: 0, limit: 2 }],
    ['forward from the middle, limit 3', { sinceSeq: 6, limit: 3 }],
    ['offset 1, limit 2 (oldest-first)', { offset: 1, limit: 2 }],
    ['offset 3, limit 2 (the page sits past the first matches)', { offset: 3, limit: 2 }],
    ['offset past the end', { offset: 40, limit: 2 }],
    ['backward window (beforeSeq)', { beforeSeq: 14, limit: 2 }],
    ['bounded slice (sinceSeq + beforeSeq)', { sinceSeq: 1, beforeSeq: 20, limit: 2 }],
    ['offset alongside beforeSeq (ignored backward)', { beforeSeq: 30, offset: 1, limit: 2 }],
  ];

  const ALL_BATCHES = [[1, 1], [2, 2], [3, 3], [1, 64], [200, 51200]];
  async function compare(c: Context, base: Record<string, unknown>, shape: Record<string, unknown>, expectedAll: number[], batches = ALL_BATCHES) {
    for (const [batch, maxBatch] of batches) {
      if (tuning) Object.assign(tuning, { batch, maxBatch });
      const full = await Q.channelMessages({}, { channelRef: channel.id, ...base, ...shape }, c, WITH_TOTAL);
      const bounded = await Q.channelMessages({}, { channelRef: channel.id, ...base, ...shape }, c, ITEMS_ONLY);
      expect(ids(bounded), `batch ${batch}`).toEqual(ids(full));
      // total counts the matches inside the cursors' range (offset and limit never narrow it).
      const lo = (shape.sinceSeq as number | undefined) ?? -Infinity;
      const hi = (shape.beforeSeq as number | undefined) ?? Infinity;
      expect(full.total).toBe(expectedAll.filter((q) => q > lo && q < hi).length);
    }
  }

  it.each(shapes)('a worker mentions read: %s', async (_label, shape) => {
    const { liamSeqs } = await history();
    const all = await Q.channelMessages({}, { channelRef: channel.id, mentionsRef: liam.id, limit: 100 }, ctx(liam.holder), WITH_TOTAL);
    expect(all.items.map((m: any) => m.seq)).toEqual(liamSeqs);
    await compare(ctx(liam.holder), { mentionsRef: liam.id }, shape, liamSeqs);
  });

  it.each(shapes.slice(0, 5))('the App convenience read matches too: %s', async (_label, shape) => {
    await history();
    for (const batch of [1, 3]) {
      if (tuning) Object.assign(tuning, { batch, maxBatch: batch });
      const full = await Q.teamChatMessages({}, { appRef: app.id, mentionsRef: liam.id, ...shape }, ctx(liam.holder), WITH_TOTAL);
      const bounded = await Q.teamChatMessages({}, { appRef: app.id, mentionsRef: liam.id, ...shape }, ctx(liam.holder), ITEMS_ONLY);
      expect(ids(bounded)).toEqual(ids(full));
    }
  });

  it('a user mentionsRef (handle tokens) matches on both paths', async () => {
    const handle = `msbee${Math.floor(Math.random() * 1e6)}`;
    await db.user.update({ where: { id: holderB.id }, data: { handle } });
    const hit = await humanSays(manager.id, `cc @${handle}`);
    await filler(5);
    await humanSays(manager.id, 'no one');
    if (tuning) tuning.batch = 2;
    const full = await Q.channelMessages({}, { channelRef: channel.id, mentionsRef: holderB.id, limit: 1 }, ctx(holderB.id), WITH_TOTAL);
    const bounded = await Q.channelMessages({}, { channelRef: channel.id, mentionsRef: holderB.id, limit: 1 }, ctx(holderB.id), ITEMS_ONLY);
    expect(full.items.map((m: any) => m.seq)).toEqual([hit.seq]);
    expect(bounded.items.map((m: any) => m.seq)).toEqual([hit.seq]);
    expect(ids(bounded)).toEqual(ids(full));
  });

  it('a createdAt tie at one seq: every keyset arm decides an order, and both paths agree on every row', async () => {
    const { liamSeqs } = await history();
    // Three rows at one mention's seq: the original (oldest createdAt, the LARGEST loc) and two newer rows sharing
    // one createdAt, whose locs sort below the original's. Order is (seq, createdAt, loc), so the original comes first,
    // the createdAt arm alone moves past it, and the loc arm alone separates the two newer rows.
    const s = liamSeqs[0]!;
    const src = await db.node.findFirstOrThrow({ where: { memoryId: memory.id, nodeType: 'chat-message', seq: s } });
    const newer = new Date(src.createdAt.getTime() + 1000);
    await duplicateSeq(s, { createdAt: newer, loc: `${channel.loc}:messages:000-tie-a` });
    await duplicateSeq(s, { createdAt: newer, loc: `${channel.loc}:messages:000-tie-b` });
    liamSeqs.unshift(s, s);
    const all = await Q.channelMessages({}, { channelRef: channel.id, mentionsRef: liam.id, limit: 100 }, ctx(liam.holder), WITH_TOTAL);
    expect(all.items.slice(0, 3).map((m: any) => m.urn.split(':').pop())).toEqual([src.loc.split(':').pop(), '000-tie-a', '000-tie-b']);
    const tieShapes: Array<Record<string, unknown>> = [{ limit: 1 }, { limit: 2 }, { limit: 50 }, { sinceSeq: 0, limit: 2 }, { offset: 1, limit: 2 }, { beforeSeq: s + 1, limit: 2 }];
    for (const shape of tieShapes) await compare(ctx(liam.holder), { mentionsRef: liam.id }, shape, liamSeqs, [[1, 1], [2, 2]]);
  }, 30_000);

  /** The history plus a second thread, then every message sealed under a session key. */
  async function encryptedHistory(): Promise<{ liamSeqs: number[]; parent: number; replies: number[]; tagged: number[]; untagged: number[] }> {
    const { liamSeqs } = await history();
    const parent = await humanSays(manager.id, 'second thread');
    const r1 = await humanSays(manager.id, 'r1', parent.seq);
    await filler(3);
    const r2 = await humanSays(manager.id, 'r2 @liam', parent.seq);
    liamSeqs.push(r2.seq);
    // #3001: Liam heads a team (Rook reports to him); every third message, and one row of the duplicate seq, carries
    // his team tag, stamped as the write path does (teamTagsVersion 1, teamTags, teamHeadIds), then sealed below.
    await db.worker.update({ where: { id: rook.id }, data: { reportsToWorkerId: liam.id } });
    const rows = await db.node.findMany({ where: { memoryId: memory.id, nodeType: 'chat-message' }, orderBy: [{ seq: 'asc' }, { createdAt: 'asc' }, { loc: 'asc' }] });
    const tagged: number[] = [];
    const untagged: number[] = [];
    for (const [i, m] of rows.entries()) {
      const stamp = i % 3 === 0 || m.loc.endsWith('-dup');
      (stamp ? tagged : untagged).push(m.seq!);
      if (!stamp) continue;
      const data = { ...(m.data as Record<string, unknown>), teamTagsVersion: 1, teamTags: [{ headId: liam.id, label: 'team.liam' }], teamHeadIds: [liam.id] };
      await db.node.update({ where: { id: m.id }, data: { data: data as never } });
    }
    const key = generateDataKey();
    sessionKeyCache.set('ms-2980', memory.id, key);
    await db.memory.update({ where: { id: memory.id }, data: { isEncrypted: true } });
    for (const m of await db.node.findMany({ where: { memoryId: memory.id, nodeType: 'chat-message' } })) {
      const enc = encryptNodeFieldsWithKey({ content: m.content ?? null, data: (m.data ?? null) as unknown }, key);
      await db.node.update({ where: { id: m.id }, data: { content: enc.content ?? null, data: enc.data as never } });
    }
    return { liamSeqs, parent: parent.seq, replies: [r1.seq, r2.seq], tagged, untagged };
  }
  // Every read decrypts its rows, so these sweep three batch settings (one row, three rows, the default) and get
  // a longer budget than vitest's 5 s default.
  const ENCRYPTED_BATCHES = [[1, 1], [3, 3], [200, 51200]];

  it('an encrypted channel: the mentions read matches on both paths', async () => {
    const { liamSeqs } = await encryptedHistory();
    for (const [, shape] of shapes) await compare(ctx(liam.holder), { mentionsRef: liam.id }, shape, liamSeqs, ENCRYPTED_BATCHES);
  }, 30_000);

  it('an encrypted channel: the reply filter (same in-memory branch) matches on both paths', async () => {
    const { parent, replies } = await encryptedHistory();
    for (const [, shape] of shapes) await compare(ctx(liam.holder), { replyToSeq: parent }, shape, replies, ENCRYPTED_BATCHES);
  }, 30_000);

  it('an encrypted channel: the selected-head read (teamHeadRef) matches on both paths', async () => {
    const { tagged, untagged } = await encryptedHistory();
    expect(tagged.length).toBeGreaterThan(3);
    expect(untagged.length).toBeGreaterThan(3);
    for (const [, shape] of shapes) await compare(ctx(manager.id), { teamHeadRef: liam.id }, shape, tagged, ENCRYPTED_BATCHES);
  }, 30_000);

  it('an encrypted channel: the untagged and tagged reads match on both paths', async () => {
    const { tagged, untagged } = await encryptedHistory();
    for (const [, shape] of shapes) {
      await compare(ctx(manager.id), { untagged: true }, shape, untagged, ENCRYPTED_BATCHES);
      await compare(ctx(manager.id), { untagged: false }, shape, tagged, ENCRYPTED_BATCHES);
    }
  }, 60_000);
});

describe('an unresolvable or cross-tenant mentionsRef is the same empty page on both paths (cor:agt:020:04)', () => {
  it.each([
    ['an unknown id', () => generateId()],
    ['a worker of another App', async () => {
      const other = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Other', urn: `${org.urn}:other` } });
      return (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: other.id, agentId: agent.id, name: 'Liam', slug: 'liam' }, select: { id: true } })).id;
    }],
    ['a user outside the App', async () => (await mkUser(9)).id],
  ])('%s', async (_label, ref) => {
    await humanSays(manager.id, 'hi @liam');
    await filler(10);
    const mentionsRef = await ref();
    for (const info of [WITH_TOTAL, ITEMS_ONLY]) {
      const page = await Q.channelMessages({}, { channelRef: channel.id, mentionsRef, limit: 1 }, ctx(liam.holder), info);
      expect({ items: page.items, total: page.total }).toEqual({ items: [], total: 0 });
    }
  });
});

describe('the own-read advance still sees a partial forward page as partial (#2018)', () => {
  it('a forward items-only mentions read through the worker\'s session raises delivered only through what it returned', async () => {
    const a = await humanSays(manager.id, '@liam a');
    const b = await humanSays(manager.id, '@liam b');
    await humanSays(manager.id, '@liam c');
    if (tuning) tuning.batch = 1;
    const selfCtx = ctx(liam.holder, { appId: app.id, sessionId: liam.session });
    const page = await Q.channelMessages({}, { channelRef: channel.id, mentionsRef: liam.id, sinceSeq: 0, limit: 2 }, selfCtx, ITEMS_ONLY);
    expect(page.items.map((m: any) => m.seq)).toEqual([a.seq, b.seq]);
    const delivered = (await db.workerDeliveryChannel.findUnique({ where: { workerId_channelId: { workerId: liam.id, channelId: channel.id } } }))?.deliveredThroughSeq ?? 0;
    expect(delivered).toBe(b.seq);
  });
});
