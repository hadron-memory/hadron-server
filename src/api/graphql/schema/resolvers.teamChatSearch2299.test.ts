/**
 * #2299 — searching a chat's history (cor:agt:020:04 "Searching a chat's history"). One channel at a time, through the
 * read gate, matching the READ PROJECTION (never the stored row), literal case-insensitive substring, newest first, a
 * bounded scan (1,000) and page (20, cap 50), an opaque cursor bound to (query, channel, incarnation, caller), a typed
 * refusal on an encrypted host, and NO read-state side effect. Every message comes from the real post path except the
 * bulk and legacy-shape rows, which are the point.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { ensureChannelWithRoot } from '../../../lib/channels.js';
import { generateDataKey } from '../../../lib/crypto.js';
import { encryptNodeFieldsWithKey } from '../../../lib/nodeCrypto.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';
import { resolvers, type Context } from './resolvers.js';
import { teamChatMutations } from './resolvers.teamChat.js';

vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const Q = resolvers.Query as any;
const ctx = (userId?: string, extra: Partial<Context> = {}): Context => ({ db, userId, roles: ['READER'], ...extra }) as Context;

let org: { id: string; urn: string };
let manager: { id: string };
let member: { id: string };
let stranger: { id: string };
let app: { id: string; urn: string };
let agent: { id: string };
let memory: { id: string };
let channel: { id: string; memoryId: string; loc: string; chatRootNodeId: string };

const mkUser = (n: number) =>
  db.user.create({ data: { id: generateId(), githubId: 99_300 + n, githubUsername: `cs-${n}-${Date.now()}-${Math.floor(Math.random() * 1e5)}`, roles: ['READER'] }, select: { id: true } });

const say = (userId: string, body: string) =>
  teamChatMutations.createTeamChatMessage({}, { appRef: app.id, body, replyToSeq: null, sessionRef: null }, ctx(userId));

/** The team-chat form and the Channel-addressed form must answer the same contract. */
const viaTeam = (who: string, query: string, extra: Record<string, unknown> = {}, c: Partial<Context> = {}) =>
  Q.teamChatSearch({}, { appRef: app.id, query, ...extra }, ctx(who, c));
const viaChannel = (who: string, query: string, extra: Record<string, unknown> = {}, c: Partial<Context> = {}) =>
  Q.channelMessageSearch({}, { channelRef: channel.id, query, ...extra }, ctx(who, c));
const both = [['teamChatSearch', viaTeam], ['channelMessageSearch', viaChannel]] as const;

const seqs = (page: any): number[] => page.items.map((m: any) => m.seq);
const code = async (p: Promise<unknown>): Promise<string> => {
  try { await p; } catch (e: any) { return String(e?.extensions?.code ?? e?.message); }
  return 'NO_ERROR';
};

/** Bulk canonical messages straight into the channel: seq 1..n, body from `bodyOf(seq)`. */
async function bulk(n: number, bodyOf: (seq: number) => string, from = 1): Promise<void> {
  const rows = Array.from({ length: n }, (_, i) => {
    const seq = from + i;
    return { id: generateId(), memoryId: memory.id, loc: `${channel.loc}:messages:b${seq}`, name: `b${seq}`, nodeType: 'chat-message', seq, messageChannelId: channel.id, content: bodyOf(seq), data: { authorUserId: manager.id, authorName: 'bulk', mentions: [] } };
  });
  await db.node.createMany({ data: rows as never });
}

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'cs-org', urn: `cs-org-${suffix}.com` } });
  [manager, member, stranger] = [await mkUser(1), await mkUser(2), await mkUser(3)];
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: manager.id, role: 'ADMIN' } });
  agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team`, visibility: 'ORGANIZATION' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
  memory = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:team-shared`, name: 'shared', class: 'app', appId: app.id, sharedMemoryOfAgentId: agent.id } });
  const made = await ensureChannelWithRoot(db, { memoryId: memory.id, loc: 'chats:team', name: 'team', createdBy: manager.id, asDefaultOfAppId: app.id });
  channel = { id: made.channel.id, memoryId: memory.id, loc: 'chats:team', chatRootNodeId: made.rootId };
});

describe.each(both)('%s — the match', (_name, search) => {
  it('is a literal, case-insensitive substring, newest first, and returns references only', async () => {
    const a = await say(manager.id, 'Deploy the Staging build');
    await say(manager.id, 'unrelated');
    const c = await say(manager.id, 'later: DEPLOY again');
    const page = await search(member.id, 'deploy');
    expect(seqs(page)).toEqual([c.seq, a.seq]);
    expect(page.complete).toBe(true);
    expect(page.cursor).toBeNull();
    expect(page.channelId).toBe(channel.id);
    expect(page.channelIncarnation).toEqual(expect.any(Number));
    const first = page.items[0];
    expect(Object.keys(first).sort()).toEqual(['channelId', 'channelIncarnation', 'nodeId', 'seq', 'urn']);
    expect(first.channelId).toBe(channel.id);
    expect(first.channelIncarnation).toBe(page.channelIncarnation);
  });

  it('gives % _ and the backslash no meaning', async () => {
    const pct = await say(manager.id, 'at 100% sure');
    const und = await say(manager.id, 'snake_case name');
    const bs = await say(manager.id, 'path a\\b here');
    await say(manager.id, '100x sure');
    await say(manager.id, 'snakeXcase name');
    await say(manager.id, 'path aXb here');
    expect(seqs(await search(member.id, '0% '))).toEqual([pct.seq]);
    expect(seqs(await search(member.id, 'e_c'))).toEqual([und.seq]);
    expect(seqs(await search(member.id, 'a\\b'))).toEqual([bs.seq]);
    expect(seqs(await search(member.id, '%%'))).toEqual([]);
  });

  it('never matches a deleted message, a non-canonical node under the prefix, or another channel', async () => {
    const live = await say(manager.id, 'sentinel-needle live');
    const gone = await say(manager.id, 'sentinel-needle deleted');
    await db.node.updateMany({ where: { memoryId: memory.id, seq: gone.seq }, data: { deletedAt: new Date() } });
    await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: `${channel.loc}:messages:offroad`, name: 'offroad', nodeType: 'note', seq: 99, messageChannelId: channel.id, content: 'sentinel-needle offroad' } });
    const other = await ensureChannelWithRoot(db, { memoryId: memory.id, loc: 'chats:other', name: 'other', createdBy: manager.id });
    await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'chats:other:messages:1', name: '1', nodeType: 'chat-message', seq: 1, messageChannelId: other.channel.id, content: 'sentinel-needle elsewhere' } });
    expect(seqs(await search(member.id, 'sentinel-needle'))).toEqual([live.seq]);
  });
});

describe('the query bounds (TEAM_CHAT_SEARCH_QUERY_LENGTH)', () => {
  it.each(both)('%s: counts code points untrimmed, 2..200, refused identically for everyone before any read', async (_n, search) => {
    await say(manager.id, 'a b and 😀😀 ok');
    for (const bad of ['', 'x', '😀', 'x'.repeat(201)]) {
      for (const who of [member.id, stranger.id]) {
        const err = await search(who, bad).catch((e: any) => e);
        expect(err.extensions.code).toBe('TEAM_CHAT_SEARCH_QUERY_LENGTH');
        expect(err.extensions).toMatchObject({ min: 2, max: 200 });
      }
    }
    expect(seqs(await search(member.id, '😀😀')).length).toBe(1); // two code points, four UTF-16 units
    expect(seqs(await search(member.id, 'a ')).length).toBe(1); // trimming would leave one
    expect(seqs(await search(member.id, 'a'.repeat(200))).length).toBe(0);
  });
});

describe('paging and the scan bound', () => {
  it.each(both)('%s: 20 by default, 50 at most (clamped, never refused), a limit below 1 refused', async (_n, search) => {
    await bulk(120, s => `needle ${s}`);
    expect((await search(member.id, 'needle')).items).toHaveLength(20);
    expect((await search(member.id, 'needle', { limit: 500 })).items).toHaveLength(50);
    expect((await search(member.id, 'needle', { limit: 7 })).items).toHaveLength(7);
    expect(await code(search(member.id, 'needle', { limit: 0 }))).toBe('BAD_USER_INPUT');
  });

  it.each(both)('%s: a full page continues strictly after its last match, and a new post never repeats or reorders it', async (_n, search) => {
    await bulk(45, s => `needle ${s}`);
    const p1 = await search(member.id, 'needle', { limit: 20 });
    expect(seqs(p1)).toEqual(Array.from({ length: 20 }, (_, i) => 45 - i));
    expect(p1.complete).toBe(false);
    expect(typeof p1.cursor).toBe('string');
    await say(manager.id, 'needle brand new');
    const p2 = await search(member.id, 'needle', { limit: 20, cursor: p1.cursor });
    expect(seqs(p2)).toEqual(Array.from({ length: 20 }, (_, i) => 25 - i));
    const p3 = await search(member.id, 'needle', { limit: 20, cursor: p2.cursor });
    expect(seqs(p3)).toEqual([5, 4, 3, 2, 1]);
    expect(p3.complete).toBe(true);
    expect(p3.cursor).toBeNull();
  });

  it.each(both)('%s: scans at most 1,000 messages, then says it stopped, with a cursor just below the last scanned seq', async (_n, search) => {
    // Matches at 1101 (inside the first 1,000 scanned), 101 (the LAST scanned of call 1, seq 1101..102 is 1,000 rows: so
    // it is outside) — see the arithmetic in the assertions below.
    await bulk(1101, s => (s === 1101 || s === 102 || s === 101 || s === 5 ? `needle ${s}` : `filler ${s}`));
    const p1 = await search(member.id, 'needle', { limit: 50 });
    // Rows scanned: seq 1101 down to 102 (1,000 messages). 1101 and 102 match; 101 was not scanned.
    expect(seqs(p1)).toEqual([1101, 102]);
    expect(p1.complete).toBe(false);
    const p2 = await search(member.id, 'needle', { limit: 50, cursor: p1.cursor });
    expect(seqs(p2)).toEqual([101, 5]); // resumes at 101: nothing skipped, 102 not scanned twice
    expect(p2.complete).toBe(true);
    expect(p2.cursor).toBeNull();
  });

  it.each(both)('%s: a scan that finds nothing within the bound is an INCOMPLETE empty page, not "no matches"', async (_n, search) => {
    await bulk(1100, s => (s === 3 ? 'needle 3' : `filler ${s}`));
    const p1 = await search(member.id, 'needle');
    expect(p1.items).toEqual([]);
    expect(p1.complete).toBe(false);
    expect(typeof p1.cursor).toBe('string');
    const p2 = await search(member.id, 'needle', { cursor: p1.cursor });
    expect(seqs(p2)).toEqual([3]);
    expect(p2.complete).toBe(true);
  });

  it.each(both)('%s: no match in a short chat is the complete empty page', async (_n, search) => {
    await say(manager.id, 'hello');
    const p = await search(member.id, 'zzz');
    expect(p).toMatchObject({ items: [], complete: true, cursor: null });
  });
});

describe('the cursor is bound to (query, channel, incarnation, caller)', () => {
  it('is refused, identically, for another query, caller, channel, incarnation or garbage', async () => {
    await bulk(60, s => `needle ${s}`);
    const p1 = await viaChannel(member.id, 'needle', { limit: 10 });
    const other = await ensureChannelWithRoot(db, { memoryId: memory.id, loc: 'chats:other', name: 'other', createdBy: manager.id });
    const refused = [
      await code(viaChannel(member.id, 'needl', { cursor: p1.cursor })),
      await code(viaChannel(manager.id, 'needle', { cursor: p1.cursor })),
      await code(Q.channelMessageSearch({}, { channelRef: other.channel.id, query: 'needle', cursor: p1.cursor }, ctx(manager.id))),
      await code(viaChannel(member.id, 'needle', { cursor: 'not-a-cursor' })),
      await code(viaChannel(member.id, 'needle', { cursor: '' })),
    ];
    expect(new Set(refused).size).toBe(1);
    expect(refused[0]).toBe('TEAM_CHAT_SEARCH_CURSOR_INVALID');
    await db.channel.update({ where: { id: channel.id }, data: { incarnation: { increment: 1 } } });
    expect(await code(viaChannel(member.id, 'needle', { cursor: p1.cursor }))).toBe('TEAM_CHAT_SEARCH_CURSOR_INVALID');
  });

  it('a cursor from the team-chat form continues on the Channel form (same channel, same binding)', async () => {
    await bulk(30, s => `needle ${s}`);
    const p1 = await viaTeam(member.id, 'needle', { limit: 10 });
    const p2 = await viaChannel(member.id, 'needle', { limit: 10, cursor: p1.cursor });
    expect(seqs(p2)).toEqual(Array.from({ length: 10 }, (_, i) => 20 - i));
  });
});

describe('authorization is the read gate, live on every page', () => {
  it('answers a stranger exactly as a read does, and an unknown channel like an unreadable one', async () => {
    await say(manager.id, 'needle');
    const readTeam = await Q.teamChatMessages({}, { appRef: app.id }, ctx(stranger.id)).catch((e: any) => e);
    const searchTeam = await viaTeam(stranger.id, 'needle').catch((e: any) => e);
    expect(searchTeam.extensions.code).toBe(readTeam.extensions.code);
    expect(searchTeam.message).toBe(readTeam.message);
    const readChan = await Q.channelMessages({}, { channelRef: channel.id }, ctx(stranger.id)).catch((e: any) => e);
    const searchChan = await viaChannel(stranger.id, 'needle').catch((e: any) => e);
    expect(searchChan.extensions.code).toBe(readChan.extensions.code);
    expect(searchChan.message).toBe(readChan.message);
    const unknown = await Q.channelMessageSearch({}, { channelRef: generateId(), query: 'needle' }, ctx(member.id)).catch((e: any) => e);
    const unknownRead = await Q.channelMessages({}, { channelRef: generateId() }, ctx(member.id)).catch((e: any) => e);
    expect(unknown.extensions.code).toBe(unknownRead.extensions.code);
    expect(await code(Q.channelMessageSearch({}, { channelRef: channel.id, query: 'needle' }, ctx(undefined)))).not.toBe('NO_ERROR');
  });

  it('a caller who loses access between pages gets the refusal on the next page and nothing of the first', async () => {
    await bulk(40, s => `needle ${s}`);
    const p1 = await viaChannel(member.id, 'needle', { limit: 10 });
    await db.appMember.deleteMany({ where: { appId: app.id, userId: member.id } });
    const err = await viaChannel(member.id, 'needle', { limit: 10, cursor: p1.cursor }).catch((e: any) => e);
    expect(err.extensions.code).toBe('CHANNEL_NOT_FOUND');
    expect(err.message).not.toMatch(/needle|\d{2}/);
  });
});

describe('an encrypted host memory is refused, never answered as "no matches"', () => {
  it.each(both)('%s: typed refusal, with or without a cached key, after the read gate', async (_n, search) => {
    await say(manager.id, 'secret needle');
    const key = generateDataKey();
    sessionKeyCache.set('cs-2299', memory.id, key);
    await db.memory.update({ where: { id: memory.id }, data: { isEncrypted: true } });
    for (const m of await db.node.findMany({ where: { memoryId: memory.id, nodeType: 'chat-message' } })) {
      const enc = encryptNodeFieldsWithKey({ content: m.content ?? null, data: (m.data ?? null) as unknown }, key);
      await db.node.update({ where: { id: m.id }, data: { content: enc.content ?? null, data: enc.data as never } });
    }
    expect(await code(search(member.id, 'needle'))).toBe('TEAM_CHAT_SEARCH_ENCRYPTED');
    sessionKeyCache.evict('cs-2299');
    expect(await code(search(member.id, 'needle'))).toBe('TEAM_CHAT_SEARCH_ENCRYPTED');
    // The refusal is behind the read gate: a stranger learns nothing about encryption.
    expect(await code(search(stranger.id, 'needle'))).not.toBe('TEAM_CHAT_SEARCH_ENCRYPTED');
  });
});

describe('the search sees exactly what a read shows (differential against the read projection)', () => {
  it.each(both)('%s: for every query the matched seqs are the read bodies containing it, case-folded', async (_n, search) => {
    await say(manager.id, 'Alpha release notes');
    await say(manager.id, 'beta ALPHA 😀 mix');
    await say(manager.id, 'nothing here');
    await say(manager.id, 'ALPHA at the end alpha');
    // A legacy row with no envelope at all: the read projects an empty author, the body is still its content.
    await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: `${channel.loc}:messages:legacy`, name: 'legacy', nodeType: 'chat-message', seq: 50, messageChannelId: channel.id, content: 'legacy alpha row', data: {} } });
    const read = await Q.teamChatMessages({}, { appRef: app.id, limit: 200 }, ctx(member.id, {}));
    for (const q of ['alpha', 'ALPHA', 'e a', 'a 😀', 'zzz', 'at the end']) {
      const expected = read.items.filter((m: any) => m.body.toLowerCase().includes(q.toLowerCase())).sort((a: any, b: any) => b.seq - a.seq);
      const page = await search(member.id, q);
      expect(seqs(page), q).toEqual(expected.map((m: any) => m.seq));
      expect(page.items.map((m: any) => m.urn), q).toEqual(expected.map((m: any) => m.urn));
    }
  });
});

describe('a search is not a read', () => {
  it('moves no read position, delivered mark, check stamp or session, and records no attention', async () => {
    const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name: 'Liam', slug: 'liam', heldByUserId: member.id, heldAt: new Date() }, select: { id: true } });
    const session = await db.session.create({ data: { id: generateId(), appId: app.id, userId: member.id, workerId: worker.id, agentId: agent.id, type: 'DEVELOPER', startedAt: new Date('2026-01-01T00:00:00Z') } });
    await db.registerEntry.create({ data: { id: generateId(), appId: app.id, channelId: channel.id, attendeeWorkerId: worker.id, role: 'BOTH' } });
    await bulk(30, s => `needle ${s}`);
    const snap = async () => JSON.stringify({
      state: await db.channelReadState.findMany({ orderBy: { id: 'asc' } }),
      session: await db.session.findUnique({ where: { id: session.id } }),
      channel: await db.channel.findUnique({ where: { id: channel.id } }),
    });
    const before = await snap();
    for (const [, search] of both) {
      await search(member.id, 'needle', { limit: 10 }, { sessionId: session.id });
      await search(member.id, 'needle', { limit: 10 });
    }
    expect(await snap()).toBe(before);
  });
});
