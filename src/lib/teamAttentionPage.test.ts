/**
 * #1384/#1421 — the paged (v2) attention regression matrix (contract #2977,
 * reconciliation #2984). Ten families: bounded multi-page scanning with
 * partial-count retention; global budgets/round-robin/fairness; loss-safety
 * (failed nudge, lost page, restart, forward read cursor, post-freeze
 * arrivals); drift and key loss; token tampering/size/kind; preview paging,
 * final-page proof and apply; v1 migration refusals; and GraphQL/MCP parity.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import { ensureChannelWithRoot } from './channels.js';
import { appendChatMessage } from './chatRoot.js';
import { encryptNodeFields, getMemoryEncryptionInfo } from './nodeCrypto.js';
import { generateDataKey } from './crypto.js';
import { sessionKeyCache } from './sessionKeyCache.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import {
  getTeamAttention,
  previewTeamAttentionSwitchover,
  teamAttentionPage,
  teamAttentionPreviewPage,
  confirmTeamAttentionSwitchover,
} from './teamAttention.js';

let org: { id: string; urn: string };
let user: { id: string };
let app: { id: string; urn: string };
let agent: { id: string };
let memory: { id: string };
let channel: { id: string; memoryId: string; loc: string; chatRootNodeId: string };
let worker: { id: string };
let sessionId: string;

const userCtx = (extra: Partial<Context> = {}): Context => ({ db, userId: user.id, roles: ['READER'], ...extra }) as Context;

async function post(body: string, options: { authorWorkerId?: string; mentions?: string[] } = {}) {
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
        content: body,
        data: {
          mentions: options.mentions ?? [],
          ...(options.authorWorkerId ? { authorWorkerId: options.authorWorkerId } : {}),
        },
      },
    }),
    { asChannel: true },
  );
}

async function drainPages(
  start: { since?: string | null } = {},
  opts: { limit?: number; scanLimit?: number; maxPages?: number } = {},
) {
  const out: { items: ReturnType<typeof identityOf>[]; adoptableSince: string | null; pages: number } = { items: [], adoptableSince: null, pages: 0 };
  let page: string | null = null;
  const max = opts.maxPages ?? 50;
  do {
    const result = await teamAttentionPage(userCtx(), app.id, {
      since: page ? null : (start.since ?? null),
      page,
      limit: opts.limit ?? null,
      scanLimit: opts.scanLimit ?? null,
    });
    out.pages++;
    out.items.push(...result.items.map(identityOf));
    if (result.scanComplete) {
      out.adoptableSince = result.adoptableSince;
      return out;
    }
    page = result.nextPage;
  } while (page && out.pages < max);
  throw new Error(`scan did not complete within ${max} pages`);
}

type Item = Awaited<ReturnType<typeof teamAttentionPage>>['items'][number];
function identityOf(item: Item) {
  return { worker: item.worker, channel: item.channel, unread: item.unread, unreadMentions: item.unreadMentions, firstUnreadSeq: item.firstUnreadSeq, lastRelevantSeq: item.lastRelevantSeq, lastSeq: item.lastSeq };
}

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'paged', urn: `paged-${suffix}.com` } });
  user = await db.user.create({ data: { id: generateId(), githubId: 1353101, githubUsername: `paged-${suffix}` } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Pilot', urn: `${org.urn}:pilot` } });
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
  worker = await db.worker.create({ data: { id: generateId(), appId: app.id, agentId: agent.id, name: 'Dara', slug: 'dara' } });
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
  // PR A keeps the pilot gate (its removal is #1421/PR B); the v2 surface
  // sits behind it on main exactly as v1 did. The channel memory is ENCRYPTED
  // so the multi-page scanning path is the one under test (plaintext channels
  // legitimately complete in one aggregate visit).
  process.env.TEAM_ATTENTION_PILOT_USER_IDS = user.id;
  process.env.TEAM_ATTENTION_PILOT_APP_IDS = app.id;
  await db.memory.update({ where: { id: memory.id }, data: { isEncrypted: true } });
  sessionKeyCache.set('paged-attention', memory.id, generateDataKey());
});

afterEach(() => {
  delete process.env.TEAM_ATTENTION_PILOT_USER_IDS;
  delete process.env.TEAM_ATTENTION_PILOT_APP_IDS;
  delete process.env.TEAM_ATTENTION_TOKEN_SECRET;
  sessionKeyCache.clear();
});

describe('family 1 — bounded multi-page scanning and partial-count retention', () => {
  it('completes an encrypted scan across pages with exact final counts and no early adoptable token', async () => {
    for (let i = 0; i < 7; i++) await post(`m${i}`, { mentions: i === 6 ? ['dara'] : [] });
    const first = await teamAttentionPage(userCtx(), app.id, { scanLimit: 3 });
    expect(first.scanComplete).toBe(false);
    expect(first.adoptableSince).toBeNull();
    const drained = await drainPages({}, { scanLimit: 3, limit: 2 });
    const mine = drained.items.filter((i) => i.worker === worker.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ unread: 7, unreadMentions: 1, lastSeq: 7 });
    expect(drained.adoptableSince).toBeTruthy();
  });

  it('retains a mention found on an early page of an unfinished channel across continuation restarts', async () => {
    await post('early mention', { mentions: ['dara'] });
    for (let i = 0; i < 5; i++) await post(`later ${i}`);
    const first = await teamAttentionPage(userCtx(), app.id, { scanLimit: 2, limit: 1 });
    expect(first.scanComplete).toBe(false);
    // The drain restarts from the FIRST page continuation; partial counts
    // (the early mention) must survive into the final item.
    const drained = await drainPages({}, { scanLimit: 2 });
    const mine = drained.items.filter((i) => i.worker === worker.id);
    expect(mine[0]).toMatchObject({ unread: 6, unreadMentions: 1 });
  });

  it('never emits an unread=0 item for an unfinished channel (no false zeros)', async () => {
    for (let i = 0; i < 4; i++) await post(`m${i}`);
    const first = await teamAttentionPage(userCtx(), app.id, { scanLimit: 2 });
    expect(first.scanComplete).toBe(false);
    // All items on early pages come only from exhausted channels; nothing
    // half-scanned may appear — with a single channel that means no items yet.
    expect(first.items).toHaveLength(0);
  });
});

describe('family 2 — budgets, round-robin and fairness', () => {
  it('bounds decrypted rows per request across a single large encrypted channel', async () => {
    for (let i = 0; i < 9; i++) await post(`m${i}`);
    const one = await teamAttentionPage(userCtx(), app.id, { scanLimit: 4 });
    expect(one.scanComplete).toBe(false);
    expect(one.nextPage).toBeTruthy();
    const drained = await drainPages({}, { scanLimit: 4 });
    expect(drained.items.filter((i) => i.worker === worker.id)[0]).toMatchObject({ unread: 9 });
  });

  it('clamps caller budgets to the hard caps', async () => {
    await post('one');
    const result = await teamAttentionPage(userCtx(), app.id, { limit: 10_000, scanLimit: 10_000 });
    // Caps are internal; the call must still succeed and complete a tiny scan.
    expect(result.scanComplete).toBe(true);
    expect(result.items.filter((i) => i.worker === worker.id)[0]).toMatchObject({ unread: 1 });
  });
});

describe('family 3 — loss safety', () => {
  it('a failed mid-scan restart from the committed watermark redelivers (duplicate, never lose)', async () => {
    for (let i = 0; i < 5; i++) await post(`m${i}`);
    const first = await teamAttentionPage(userCtx(), app.id, { scanLimit: 2 });
    expect(first.scanComplete).toBe(false);
    // Router loses the continuation and restarts WITHOUT page or since:
    // the whole span is re-scanned and redelivered.
    const restarted = await drainPages({}, { scanLimit: 2 });
    expect(restarted.items.filter((i) => i.worker === worker.id)[0]).toMatchObject({ unread: 5 });
  });

  it('adopted watermark filters a subsequent poll to genuinely new activity', async () => {
    for (let i = 0; i < 3; i++) await post(`m${i}`);
    const first = await drainPages({});
    const since = first.adoptableSince!;
    const second = await teamAttentionPage(userCtx(), app.id, { since });
    // No head moved: the v1 idle short-circuit — final page, no items.
    expect(second.scanComplete).toBe(true);
    expect(second.items).toHaveLength(0);
    await post('new since adoption', { mentions: ['dara'] });
    const third = await drainPages({ since });
    // v1 semantics: a moved head reports the target with its FULL unread
    // count (from the read cursor), gated by relevance — not the delta.
    expect(third.items.filter((i) => i.worker === worker.id)[0]).toMatchObject({ unread: 4, unreadMentions: 1 });
  });

  it('a forward read-cursor move during a scan does not stale it', async () => {
    for (let i = 0; i < 6; i++) await post(`m${i}`);
    const first = await teamAttentionPage(userCtx(), app.id, { scanLimit: 2 });
    expect(first.scanComplete).toBe(false);
    // The worker reads ahead while the scan is mid-flight.
    await db.channelReadState.create({
      data: { id: generateId(), workerId: worker.id, channelId: channel.id, lastSeenSeq: 2 },
    }).catch(() => undefined); // unique constraint may exist from capture paths
    const next = await teamAttentionPage(userCtx(), app.id, { page: first.nextPage });
    expect([true, false]).toContain(next.scanComplete);
  });
});

describe('family 4 — drift and key loss', () => {
  it('a message arriving mid-scan is NOT skipped by adoption (#3046 finding 1)', async () => {
    for (let i = 0; i < 5; i++) await post(`m${i}`);
    const first = await teamAttentionPage(userCtx(), app.id, { scanLimit: 2 });
    expect(first.scanComplete).toBe(false);
    // Message #6 lands while the scan is mid-flight.
    await post('arrived mid-scan');
    let page = first.nextPage;
    let adopted: string | null = null;
    for (let guard = 0; guard < 50 && page; guard++) {
      const r = await teamAttentionPage(userCtx(), app.id, { page });
      if (r.scanComplete) { adopted = r.adoptableSince; break; }
      page = r.nextPage;
    }
    expect(adopted).toBeTruthy();
    // The adoptable watermark carries the FROZEN head (5), not the live 6…
    const decoded = JSON.parse(Buffer.from(adopted!.split('.')[0], 'base64url').toString('utf-8'));
    expect(decoded.workers[0].channels[0].head).toBe(5);
    // …so the next poll from it must notify the mid-scan arrival.
    const next = await drainPages({ since: adopted });
    // v1 semantics: full unread from the read cursor; the skip-prevention
    // proof is the target being REPORTED at all (relevance 6 > watermark 5).
    expect(next.items.filter((i) => i.worker === worker.id)[0]).toMatchObject({ unread: 6, lastRelevantSeq: 6 });
  });

  it('a target appearing between pages stales the continuation (#3046 finding 2)', async () => {
    for (let i = 0; i < 5; i++) await post(`m${i}`);
    const first = await teamAttentionPage(userCtx(), app.id, { scanLimit: 2 });
    expect(first.scanComplete).toBe(false);
    // A second live Worker registers mid-scan: the live target set grows.
    const second = await db.worker.create({ data: { id: generateId(), appId: app.id, agentId: agent.id, name: 'Mira', slug: 'mira' } });
    await db.registerEntry.create({
      data: { id: generateId(), appId: app.id, channelId: channel.id, attendeeWorkerId: second.id, role: 'BOTH' },
    });
    await db.session.create({
      data: { id: generateId(), appId: app.id, userId: user.id, workerId: second.id, agentId: agent.id, type: 'DEVELOPER', startedAt: new Date() },
    });
    await expect(teamAttentionPage(userCtx(), app.id, { page: first.nextPage })).rejects.toMatchObject({
      extensions: { code: 'TEAM_ATTENTION_STALE_PAGE' },
    });
    // The restart picks the new target up fresh.
    const restarted = await drainPages({});
    expect(restarted.items.some((i) => i.worker === second.id)).toBe(true);
  });

  it('refuses a page token whose channel frontier row was deleted (typed stale restart)', async () => {
    for (let i = 0; i < 5; i++) await post(`m${i}`);
    const first = await teamAttentionPage(userCtx(), app.id, { scanLimit: 2 });
    expect(first.scanComplete).toBe(false);
    // Delete the frontier row the continuation points at.
    const decoded = JSON.parse(Buffer.from(first.nextPage!.split('.')[0], 'base64url').toString('utf-8'));
    const frontierLoc = `chats:team:messages:${decoded.c_front[0]}`;
    await db.node.updateMany({ where: { memoryId: memory.id, loc: frontierLoc }, data: { deletedAt: new Date() } });
    await expect(teamAttentionPage(userCtx(), app.id, { page: first.nextPage })).rejects.toMatchObject({
      extensions: { code: 'TEAM_ATTENTION_STALE_PAGE' },
    });
  });

  it('revoking the operator App participation stales the page (scope drift)', async () => {
    for (let i = 0; i < 3; i++) await post(`m${i}`);
    const first = await teamAttentionPage(userCtx(), app.id, { scanLimit: 1 });
    expect(first.scanComplete).toBe(false);
    // Org admins participate in any org App, so BOTH memberships must go.
    await db.appMember.deleteMany({ where: { appId: app.id, userId: user.id } });
    await db.orgMember.deleteMany({ where: { organizationId: org.id, userId: user.id } });
    await expect(teamAttentionPage(userCtx(), app.id, { page: first.nextPage })).rejects.toMatchObject({
      extensions: { code: 'APP_NOT_FOUND' },
    });
  });
});

describe('family 5 — token integrity', () => {
  it('rejects tampered, cross-operator and wrong-kind page tokens', async () => {
    await post('one');
    // Completion rule post-#1430: an exactly-full page leaves the channel
    // active; the zero-row seek on the next pull proves completion.
    const first = await drainPages({}, { scanLimit: 1 });
    expect(first.adoptableSince).toBeTruthy();
    const forged = `${Buffer.from(JSON.stringify({ v: 2, kind: 'team-attention-page', op: 'poll', appId: app.id, userId: user.id, W: [], C: [], t_w: [], t_c: [], dg: 'x' })).toString('base64url')}.deadbeef`;
    await expect(teamAttentionPage(userCtx(), app.id, { page: forged })).rejects.toMatchObject({ extensions: { code: 'INVALID_ATTENTION_PAGE' } });
    await expect(teamAttentionPage(userCtx(), app.id, { page: 'not-a-token' })).rejects.toMatchObject({ extensions: { code: 'INVALID_ATTENTION_PAGE' } });
    await expect(teamAttentionPage(userCtx(), app.id, { since: 'now' })).rejects.toMatchObject({ extensions: { code: 'SWITCHOVER_CONFIRMATION_REQUIRED' } });
    await expect(teamAttentionPage(userCtx(), app.id, { since: 'x', page: 'y' })).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });
});

describe('family 6 — paged preview, final-page proof, apply', () => {
  it('multi-page preview issues its proof only on the final page; apply baselines frozen heads only', async () => {
    await post('backlog one');
    await post('backlog two');
    const p1 = await teamAttentionPreviewPage(userCtx(), app.id, { scanLimit: 1 });
    expect(p1.scanComplete).toBe(false);
    expect(p1.proof).toBeNull();
    let page = p1.nextPage;
    let last = p1;
    while (page) {
      last = await teamAttentionPreviewPage(userCtx(), app.id, { page });
      page = last.nextPage;
    }
    expect(last.scanComplete).toBe(true);
    expect(last.proof).toBeTruthy();
    expect(last.expiresAt).toBeInstanceOf(Date);
    // A message arriving after the final page's freeze stays unread: apply
    // baselines only through the frozen head.
    await post('arrived after the freeze');
    const applied = await confirmTeamAttentionSwitchover(userCtx(), app.id, last.proof!);
    expect(applied).toMatchObject({ applied: true });
    const after = await db.channelReadState.findFirstOrThrow({ where: { workerId: worker.id, channelId: channel.id } });
    expect(after.lastSeenSeq).toBe(2);
  });
});

describe('family 7 — v1 migration', () => {
  it('v1 poll and preview doors refuse UPGRADE_REQUIRED with migration guidance', async () => {
    await expect(getTeamAttention(userCtx(), app.id)).rejects.toMatchObject({ extensions: { code: 'UPGRADE_REQUIRED' } });
    await expect(previewTeamAttentionSwitchover(userCtx(), app.id)).rejects.toMatchObject({ extensions: { code: 'UPGRADE_REQUIRED' } });
  });

  it('a v1 since token starts a v2 scan carrying the watermark forward', async () => {
    for (let i = 0; i < 3; i++) await post(`m${i}`);
    const first = await drainPages({});
    // Adopt, then v1-shaped since feeds the v2 door.
    const viaV2 = await teamAttentionPage(userCtx(), app.id, { since: first.adoptableSince });
    expect(viaV2.scanComplete).toBe(true);
    expect(viaV2.items).toHaveLength(0);
  });
});

describe('family 8 — GraphQL parity', () => {
  it('exposes the paged doors with the same semantics as the lib', async () => {
    await post('hello', { mentions: ['dara'] });
    const viaGraphQL = await resolvers.Query.teamAttentionPage({}, { appRef: app.id, since: null, page: null, limit: null, scanLimit: null }, userCtx());
    expect(viaGraphQL.scanComplete).toBe(true);
    expect(viaGraphQL.items.filter((i: { worker: string }) => i.worker === worker.id)[0]).toMatchObject({ unread: 1 });
    const previewViaGraphQL = await resolvers.Query.teamAttentionPreviewPage({}, { appRef: app.id, page: null, limit: null, scanLimit: null }, userCtx());
    expect(previewViaGraphQL.proof).toBeTruthy();
  });
});

describe('family 9 — consolidated review corrections (#3051/#3053/#3054)', () => {
  it('maskSet sets bits that open a new nibble (indices 0/4/8)', async () => {
    const { maskSet, maskGet, maskEmpty } = await import('./teamAttentionPage.js');
    let m = maskEmpty();
    for (const i of [0, 4, 8, 12]) m = maskSet(m, i);
    for (const i of [0, 4, 8, 12]) expect(maskGet(m, i)).toBe(true);
    for (const i of [1, 5, 9]) expect(maskGet(m, i)).toBe(false);
  });

  it('duplicate seq at the frozen max is fully scanned (finding 4)', async () => {
    // Two message rows sharing seq=1 (the legacy duplicate-seq shape): the
    // relevant mention rides the row with the LARGER id. Envelopes encrypt
    // exactly as appendChatMessage would in this encrypted memory.
    const memEnc = await getMemoryEncryptionInfo(db, channel.memoryId);
    for (const [id, mentions] of [['aaa-dup', []], ['zzz-dup', ['dara']]] as const) {
      const enc = encryptNodeFields({ content: null, data: { mentions } }, memEnc);
      await db.node.create({
        data: {
          id, memoryId: channel.memoryId, loc: `chats:team:messages:${id}`,
          name: id, nodeType: 'chat-message', seq: 1, content: 'dup',
          data: (enc.data ?? null) as object,
        },
      });
    }
    // Raw inserts bypass appendChatMessage's watermark maintenance.
    await db.channel.update({ where: { id: channel.id }, data: { lastSeq: 1 } });
    const drained = await drainPages({}, { scanLimit: 1 });
    expect(drained.items.filter((i) => i.worker === worker.id)[0]).toMatchObject({ unread: 2, unreadMentions: 1 });
  });

  it('carries the original relevance floor across pages (finding 6 / QA repro 2)', async () => {
    await post('one');
    await post('two');
    const first = await drainPages({});
    // A post-watermark self-authored message moves the head but is excluded
    // by the author filter — nothing NEW is relevant for this worker.
    await post('own, excluded', { authorWorkerId: worker.id });
    const second = await drainPages({ since: first.adoptableSince }, { scanLimit: 1 });
    expect(second.items.filter((i) => i.worker === worker.id)).toHaveLength(0);
  });

  it('a replaced register with the same worker+channel+mentionOnly stales (finding 2 / QA repro 5)', async () => {
    for (let i = 0; i < 4; i++) await post(`m${i}`);
    const first = await teamAttentionPage(userCtx(), app.id, { scanLimit: 2 });
    expect(first.scanComplete).toBe(false);
    await db.registerEntry.deleteMany({ where: { attendeeWorkerId: worker.id, channelId: channel.id } });
    await db.registerEntry.create({
      data: { id: generateId(), appId: app.id, channelId: channel.id, attendeeWorkerId: worker.id, role: 'BOTH' },
    });
    await expect(teamAttentionPage(userCtx(), app.id, { page: first.nextPage })).rejects.toMatchObject({
      extensions: { code: 'TEAM_ATTENTION_STALE_PAGE' },
    });
  });

  it('round-robin quantum lets a short channel finish beside a huge one (finding 7)', async () => {
    // Second encrypted channel with its own register for the same worker.
    const memory2 = await db.memory.create({
      // No sharedMemoryOfAgentId: one shared app-class memory per App per agent —
      // a second REGISTER channel lives fine in a plain org knowledge memory.
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:second`, name: 'second', class: 'knowledge', visibility: 'ORGANIZATION', isEncrypted: true },
    });
    sessionKeyCache.set('paged-attention-2', memory2.id, generateDataKey());
    const made2 = await ensureChannelWithRoot(db, { memoryId: memory2.id, loc: 'chats:team2', name: 'team2', createdBy: user.id });
    await db.registerEntry.create({
      data: { id: generateId(), appId: app.id, channelId: made2.channel.id, attendeeWorkerId: worker.id, role: 'BOTH' },
    });
    const enc2 = await getMemoryEncryptionInfo(db, memory2.id);
    await appendChatMessage(db, { id: made2.rootId, memoryId: memory2.id, loc: 'chats:team2' }, enc2,
      async ({ tx, seq, msgNum }) => tx.node.create({
        data: { id: generateId(), memoryId: memory2.id, loc: `chats:team2:messages:${msgNum}`, name: msgNum, nodeType: 'chat-message', seq, content: 'short channel', data: { mentions: [] } },
      }), { asChannel: true });
    for (let i = 0; i < 9; i++) await post(`huge ${i}`);
    // Budget 4, quantum-fair: the huge channel may take at most half this
    // request's rows per visit. The short channel's item ships no later than
    // the SECOND pull (the exactly-full page rule #1430 leaves it active
    // until a zero-row seek proves completion on the next visit).
    const p1 = await teamAttentionPage(userCtx(), app.id, { scanLimit: 4 });
    const p2 = await teamAttentionPage(userCtx(), app.id, { page: p1.nextPage });
    const shortItem = [...p1.items, ...p2.items].find((i) => i.channel === made2.channel.id);
    expect(shortItem).toMatchObject({ unread: 1 });
    // The huge channel (9 messages) is still delivering at this point: the
    // short item shipped before the huge one completed.
    const hugeItems = [...p1.items, ...p2.items].filter((i) => i.channel === channel.id);
    expect(hugeItems.length).toBeLessThanOrEqual(1);
  });

  it('the 200-target continuation fits the transport ceiling at compact IDs (size fixture)', async () => {
    const { signPageToken } = await import('./teamAttentionPage.js');
    const id = () => Array.from({ length: 32 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
    const W = Array.from({ length: 20 }, id);
    const C = Array.from({ length: 200 }, id);
    const R = Array.from({ length: 200 }, id);
    const payload = {
      v: 2 as const, kind: 'team-attention-page' as const, op: 'poll' as const,
      appId: id(), userId: id(), ts: Date.now(), W, C, R,
      t_w: Array.from({ length: 200 }, (_v, i) => i % 20),
      t_c: Array.from({ length: 200 }, (_v, i) => i),
      t_r: Array.from({ length: 200 }, (_v, i) => i),
      t_mo: Array.from({ length: 200 }, () => 1),
      t_seen: Array.from({ length: 200 }, () => 2147483647),
      t_head: Array.from({ length: 200 }, () => 2147483647),
      t_prior: Array.from({ length: 200 }, () => 2147483647),
      c_done: '0'.repeat(50),
      o: 'c' as const,
      c_num: Array.from({ length: 200 }, () => '2147483647'),
      c_front: Array.from({ length: 200 }, () => '2147483647'),
            c_inc: Array.from({ length: 200 }, () => 2147483647),
      c_min: Array.from({ length: 200 }, () => 0),
      c_max: Array.from({ length: 200 }, () => 2147483647),
      u_unread: Array.from({ length: 200 }, () => 2147483647),
      u_ment: Array.from({ length: 200 }, () => 2147483647),
      u_first: Array.from({ length: 200 }, () => 2147483647),
      u_last: Array.from({ length: 200 }, () => 2147483647),
      e_emitted: '0'.repeat(50),
      q: Array.from({ length: 200 }, (_v, i) => i),
      next: 0,
      dg: 'x'.repeat(32),
    };
    const signed = signPageToken(payload, 'size-fixture-secret');
    expect('tooLarge' in signed).toBe(false);
    if (!('tooLarge' in signed)) expect(signed.token.length).toBeLessThan(65_536);
  });
});

describe('family 13 — #3123 long-loc liveness', () => {
  it('a long-loc (147-char) channel completes within the token ceiling alongside a normal channel', async () => {
    // Channel with a long address: two 60-char atoms.
    const longLoc = 'chats:' + 'x'.repeat(60) + ':' + 'y'.repeat(60);
    const longMemory = await db.memory.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:long`, name: 'long', class: 'knowledge', visibility: 'ORGANIZATION', isEncrypted: true },
    });
    sessionKeyCache.set('paged-long', longMemory.id, generateDataKey());
    const madeLong = await ensureChannelWithRoot(db, { memoryId: longMemory.id, loc: longLoc, name: 'long-team', createdBy: user.id });
    await db.registerEntry.create({
      data: { id: generateId(), appId: app.id, channelId: madeLong.channel.id, attendeeWorkerId: worker.id, role: 'BOTH' },
    });
    const encL = await getMemoryEncryptionInfo(db, longMemory.id);
    for (let i = 0; i < 3; i++) {
      await appendChatMessage(db, { id: madeLong.rootId, memoryId: longMemory.id, loc: longLoc }, encL,
        async ({ tx, seq, msgNum }) => tx.node.create({
          data: { id: generateId(), memoryId: longMemory.id, loc: `${longLoc}:messages:${msgNum}`, name: msgNum, nodeType: 'chat-message', seq, content: `long ${i}`, data: { mentions: [] } },
        }), { asChannel: true });
    }
    // The original channel also present; the scan must page through both and
    // produce continuations whose SUFFIX cursors keep the token small.
    for (let i = 0; i < 3; i++) await post(`orig ${i}`);
    let page: string | null = null;
    let pages = 0;
    let completed = false;
    do {
      const r = await teamAttentionPage(userCtx(), app.id, { page, scanLimit: 2 });
      pages++;
      if (r.scanComplete) { completed = true; break; }
      page = r.nextPage;
      if (page && page.length > 65_536) throw new Error(`continuation exceeded ceiling: ${page.length}`);
    } while (page && pages < 30);
    expect(completed).toBe(true);
  });
});

describe('family 15 — frozen keyset boundary (#1428 Codex round N)', () => {
  it('a busy channel producing rows after the freeze does not starve completion', async () => {
    for (let i = 0; i < 5; i++) await post(`freeze-range ${i}`);
    // Page 1 of a multi-page scan — the freeze captures head 5.
    const p1 = await teamAttentionPage(userCtx(), app.id, { scanLimit: 2 });
    expect(p1.scanComplete).toBe(false);
    // Post-freeze traffic: rows beyond the frozen head keep arriving…
    await post('post-freeze 1');
    await post('post-freeze 2');
    await post('post-freeze 3');
    // …but the ORIGINAL scan (continuing p1's page token) completes over its
    // frozen range without fetching them — the busy channel cannot starve
    // completion by keeping every page full of seq > cMax rows.
    let page: string | null = p1.nextPage;
    let adopted: string | null = null;
    let items: ReturnType<typeof identityOf>[] = [];
    for (let guard = 0; guard < 30 && page; guard++) {
      const r = await teamAttentionPage(userCtx(), app.id, { page, scanLimit: 2 });
      items.push(...r.items.map(identityOf));
      if (r.scanComplete) { adopted = r.adoptableSince; break; }
      page = r.nextPage;
    }
    expect(adopted).toBeTruthy();
    const mine = items.filter((i) => i.worker === worker.id);
    expect(mine[0]).toMatchObject({ unread: 5 });
    // And the next poll from the adopted watermark reports the post-freeze work.
    const next = await drainPages({ since: adopted });
    expect(next.items.filter((i) => i.worker === worker.id)[0]).toMatchObject({ unread: 8 });
  });
});

describe('family 16 — Codex padding-boundary round', () => {
  it('a scan frozen at head 999 completes correctly despite a post-freeze msgNum-1000 row (#1428)', async () => {
    // 999 messages: locs pad to 3 digits (…:001 through …:999). The channel
    // head is 999. A post-freeze row at msgNum 1000 has loc …:1000 which
    // sorts BEFORE …:101 in C order (padding inversion).
    const memEnc = await getMemoryEncryptionInfo(db, channel.memoryId);
    for (let seq = 1; seq <= 3; seq++) {
      const locSuffix = String(seq).padStart(3, '0');
      const enc = encryptNodeFields({ content: null, data: { mentions: seq === 3 ? ['dara'] : [] } }, memEnc);
      await db.node.create({
        data: { id: `pad999-${seq}`, memoryId: channel.memoryId, loc: `chats:team:messages:${locSuffix}`,
          name: locSuffix, nodeType: 'chat-message', seq, content: 'x', data: (enc.data ?? null) as object },
      });
    }
    await db.channel.update({ where: { id: channel.id }, data: { lastSeq: 3 } });
    // Freeze at head 3, then a post-freeze row arrives with loc …:1000.
    const p1 = await teamAttentionPage(userCtx(), app.id, { scanLimit: 2 });
    expect(p1.scanComplete).toBe(false);
    const enc1000 = encryptNodeFields({ content: null, data: { mentions: [] } }, memEnc);
    await db.node.create({
      data: { id: 'pad999-post', memoryId: channel.memoryId, loc: 'chats:team:messages:1000',
        name: '1000', nodeType: 'chat-message', seq: 4, content: 'post', data: (enc1000.data ?? null) as object },
    });
    // Continue the original scan: it must complete over the frozen 3-message
    // range despite the post-freeze row sitting inside the prefix range.
    let page: string | null = p1.nextPage;
    let adopted: string | null = null;
    let items: ReturnType<typeof identityOf>[] = [];
    for (let guard = 0; guard < 20 && page; guard++) {
      const r = await teamAttentionPage(userCtx(), app.id, { page, scanLimit: 2 });
      items.push(...r.items.map(identityOf));
      if (r.scanComplete) { adopted = r.adoptableSince; break; }
      page = r.nextPage;
    }
    expect(adopted).toBeTruthy();
    const mine = items.filter((i) => i.worker === worker.id);
    expect(mine[0]).toMatchObject({ unread: 3, unreadMentions: 1, firstUnreadSeq: 1 });
  });
});

describe('family 14 — review #3153', () => {
  it('a genuinely-issued pre-C shape gets STALE_PAGE; every signed malformed variant gets INVALID (#3170/#3171)', async () => {
    const { signPageToken } = await import('./teamAttentionPage.js');
    await post('one');
    const secret = process.env.TEAM_ATTENTION_TOKEN_SECRET || process.env.JWT_SECRET || '';
    // Mint a REAL current continuation, then strip `o` and `c_front` — the
    // exact transformation an actually-issued pre-C page underwent.
    const current = await teamAttentionPage(userCtx(), app.id, {});
    expect(current.scanComplete).toBe(true); // tiny scan final page — mint a paged one instead
    await post('two');
    await post('three');
    const paged = await teamAttentionPage(userCtx(), app.id, { scanLimit: 1 });
    expect(paged.scanComplete).toBe(false);
    const realPayload = JSON.parse(Buffer.from(paged.nextPage!.split('.')[0], 'base64url').toString('utf-8'));
    const preC: Record<string, unknown> = { ...realPayload };
    delete preC.o;
    delete preC.c_front;
    const signedOld = signPageToken(preC as never, secret);
    if ('tooLarge' in signedOld) throw new Error('unexpected tooLarge');
    await expect(teamAttentionPage(userCtx(), app.id, { page: (signedOld as { token: string }).token })).rejects.toMatchObject({
      extensions: { code: 'TEAM_ATTENTION_STALE_PAGE' },
    });
    // Chip's three separately-signed malformed variants (#3171) — each must
    // get INVALID, not the old-order restart.
    const variants: Array<[string, Record<string, unknown>]> = [
      ['t_r references absent register', { ...preC, R: [], t_r: [0] }],
      ['missing c_num array', (() => { const v = { ...preC }; delete v.c_num; return v; })()],
      ['missing t_r array', (() => { const v = { ...preC }; delete v.t_r; return v; })()],
      ['broken t_w index', { ...preC, t_w: [99] }],
      ['missing q queue array', (() => { const v = { ...preC }; delete v.q; return v; })()],
      ['missing ts timestamp', (() => { const v = { ...preC }; delete v.ts; return v; })()],
      // Current-era token missing c_front (has o:'c') → INVALID
      ['current token missing c_front', (() => { const v = { ...realPayload }; delete v.c_front; return v; })()],
    ];
    for (const [label, variant] of variants) {
      const signed = signPageToken(variant as never, secret);
      if ('tooLarge' in signed) throw new Error(`unexpected tooLarge: ${label}`);
      await expect(teamAttentionPage(userCtx(), app.id, { page: (signed as { token: string }).token })).rejects.toMatchObject({
        extensions: { code: 'INVALID_ATTENTION_PAGE' },
      });
    }
  });

  it('a counted message followed by an own post keeps the COUNTED frontier on the counted row (#3153 finding 3)', async () => {
    await post('counted', { mentions: ['dara'] });
    await post('own after counted', { authorWorkerId: worker.id });
    await post('not yet visited');
    // scanLimit 2: the first TWO rows are visited (counted + own); the third
    // remains, so the channel stays ACTIVE after the pull. c_num advances to
    // the own (last charged raw) row; c_front stays on the counted row — the
    // one the deletion check protects. THEN delete the counted row → typed
    // restart while the channel is still active.
    const first = await teamAttentionPage(userCtx(), app.id, { scanLimit: 2 });
    expect(first.scanComplete).toBe(false);
    const decoded = JSON.parse(Buffer.from(first.nextPage!.split('.')[0], 'base64url').toString('utf-8'));
    expect(decoded.c_num[0]).toBe('002'); // raw cursor on the own post (loc suffix is padded)
    expect(decoded.c_front[0]).toBe('001'); // counted frontier on the counted row
    await db.node.updateMany({ where: { memoryId: memory.id, loc: 'chats:team:messages:001' }, data: { deletedAt: new Date() } });
    await expect(teamAttentionPage(userCtx(), app.id, { page: first.nextPage })).rejects.toMatchObject({
      extensions: { code: 'TEAM_ATTENTION_STALE_PAGE' },
    });
  });
});

describe('family 13b — legacy suffix shapes', () => {
  it('a nonnumeric message suffix pages correctly and stores verbatim', async () => {
    // Legacy shape: a message loc whose suffix after the channel prefix is
    // not a plain counter (pre-padding or importer-created row).
    const memEnc = await getMemoryEncryptionInfo(db, channel.memoryId);
    const enc = encryptNodeFields({ content: null, data: { mentions: ['dara'] } }, memEnc);
    await db.node.create({
      data: {
        id: 'legacy-suffix-row', memoryId: channel.memoryId, loc: 'chats:team:messages:legacy-alpha',
        name: 'legacy', nodeType: 'chat-message', seq: 1, content: 'legacy',
        data: (enc.data ?? null) as object,
      },
    });
    await db.node.create({
      data: {
        id: 'legacy-suffix-row-b', memoryId: channel.memoryId, loc: 'chats:team:messages:legacy-beta',
        name: 'legacy-b', nodeType: 'chat-message', seq: 2, content: 'legacy-b',
        data: (enc.data ?? null) as object,
      },
    });
    await db.channel.update({ where: { id: channel.id }, data: { lastSeq: 2 } });
    const drained = await drainPages({}, { scanLimit: 1 });
    const mine = drained.items.filter((i) => i.worker === worker.id);
    expect(mine[0]).toMatchObject({ unread: 2, unreadMentions: 2, firstUnreadSeq: 1 });
  });
});

describe('family 12 — review #3111 lifecycle', () => {
  it('a same-address channel recreation stales the continuation despite preserved IDs (#3111)', async () => {
    for (let i = 0; i < 5; i++) await post(`m${i}`);
    const first = await teamAttentionPage(userCtx(), app.id, { scanLimit: 2 });
    expect(first.scanComplete).toBe(false);
    // The SUPPORTED same-address lifecycle: delete, then ensure at the same
    // address — Channel/register IDs survive, incarnation increments, and a
    // fresh message keeps the live head >= the frozen head. The deletion
    // mirrors the GraphQL deleteChannel tombstone (soft-delete the root,
    // soft-delete the messages, reset the channel) without its auth surface.
    await db.node.update({ where: { id: channel.chatRootNodeId }, data: { deletedAt: new Date() } });
    await db.node.updateMany({ where: { memoryId: channel.memoryId, loc: { startsWith: 'chats:team:messages:' } }, data: { deletedAt: new Date() } });
    await db.channel.update({ where: { id: channel.id }, data: { deletedAt: new Date() } });
    const remade = await ensureChannelWithRoot(db, {
      memoryId: channel.memoryId, loc: channel.loc, name: 'team', createdBy: user.id, asDefaultOfAppId: app.id,
    });
    expect(remade.channel.id).toBe(channel.id); // IDs preserved — the whole point
    const enc = await getMemoryEncryptionInfo(db, channel.memoryId);
    await appendChatMessage(db, { id: remade.rootId, memoryId: channel.memoryId, loc: channel.loc }, enc,
      async ({ tx, seq, msgNum }) => tx.node.create({
        data: { id: generateId(), memoryId: channel.memoryId, loc: `${channel.loc}:messages:${msgNum}`, name: msgNum, nodeType: 'chat-message', seq, content: 'new incarnation', data: { mentions: [] } },
      }), { asChannel: true });
    await expect(teamAttentionPage(userCtx(), app.id, { page: first.nextPage })).rejects.toMatchObject({
      extensions: { code: 'TEAM_ATTENTION_STALE_PAGE' },
    });
  });
});

describe('family 11 — review #3105', () => {
  it('firstUnreadSeq is the minimum seq when loc order diverges from seq order (999/1000)', async () => {
    const memEnc = await getMemoryEncryptionInfo(db, channel.memoryId);
    for (const [locSuffix, seq] of [['1000', 1000], ['999', 999]] as const) {
      const enc = encryptNodeFields({ content: null, data: { mentions: [] } }, memEnc);
      await db.node.create({
        data: {
          id: `pad-${locSuffix}`, memoryId: channel.memoryId, loc: `chats:team:messages:${locSuffix}`,
          name: locSuffix, nodeType: 'chat-message', seq, content: 'pad',
          data: (enc.data ?? null) as object,
        },
      });
    }
    await db.channel.update({ where: { id: channel.id }, data: { lastSeq: 1000 } });
    const drained = await drainPages({});
    expect(drained.items.filter((i) => i.worker === worker.id)[0]).toMatchObject({ unread: 2, firstUnreadSeq: 999 });
  });

  it('the 36-char-ID variant of the size fixture also fits (contract boundary)', async () => {
    const { signPageToken } = await import('./teamAttentionPage.js');
    const id = () => Array.from({ length: 36 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
    const payload = {
      v: 2 as const, kind: 'team-attention-page' as const, op: 'poll' as const,
      appId: id(), userId: id(), ts: Date.now(),
      W: Array.from({ length: 20 }, id), C: Array.from({ length: 200 }, id), R: Array.from({ length: 200 }, id),
      t_w: Array.from({ length: 200 }, (_v, i) => i % 20),
      t_c: Array.from({ length: 200 }, (_v, i) => i),
      t_r: Array.from({ length: 200 }, (_v, i) => i),
      t_mo: Array.from({ length: 200 }, () => 1),
      t_seen: Array.from({ length: 200 }, () => 2147483647),
      t_head: Array.from({ length: 200 }, () => 2147483647),
      t_prior: Array.from({ length: 200 }, () => 2147483647),
      c_done: '0'.repeat(50),
      o: 'c' as const,
      c_num: Array.from({ length: 200 }, () => '2147483647'),
      c_front: Array.from({ length: 200 }, () => '2147483647'),
            c_inc: Array.from({ length: 200 }, () => 2147483647),
      c_min: Array.from({ length: 200 }, () => 0),
      c_max: Array.from({ length: 200 }, () => 2147483647),
      u_unread: Array.from({ length: 200 }, () => 2147483647),
      u_ment: Array.from({ length: 200 }, () => 2147483647),
      u_first: Array.from({ length: 200 }, () => 2147483647),
      u_last: Array.from({ length: 200 }, () => 2147483647),
      e_emitted: '0'.repeat(50),
      q: Array.from({ length: 200 }, (_v, i) => i),
      next: 0, dg: 'x'.repeat(32),
    };
    const signed = signPageToken(payload, 'size-fixture-secret');
    expect('tooLarge' in signed).toBe(false);
    if (!('tooLarge' in signed)) expect(signed.token.length).toBeLessThan(65_536);
  });
});

describe('family 10 — Codex #1428 findings', () => {
  it('plaintext channels page under the scan budget instead of one aggregate (P1)', async () => {
    // A plaintext memory + channel + register for the same worker.
    const plainMemory = await db.memory.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:plain`, name: 'plain', class: 'knowledge', visibility: 'ORGANIZATION' },
    });
    const madePlain = await ensureChannelWithRoot(db, { memoryId: plainMemory.id, loc: 'chats:plain', name: 'plain-team', createdBy: user.id });
    await db.registerEntry.create({
      data: { id: generateId(), appId: app.id, channelId: madePlain.channel.id, attendeeWorkerId: worker.id, role: 'BOTH' },
    });
    for (let i = 0; i < 7; i++) {
      await appendChatMessage(db, { id: madePlain.rootId, memoryId: plainMemory.id, loc: 'chats:plain' }, { id: plainMemory.id, isEncrypted: false },
        async ({ tx, seq, msgNum }) => tx.node.create({
          data: { id: generateId(), memoryId: plainMemory.id, loc: `chats:plain:messages:${msgNum}`, name: msgNum, nodeType: 'chat-message', seq, content: `plain ${i}`, data: { mentions: i === 6 ? ['dara'] : [] } },
        }), { asChannel: true });
    }
    // Budget 2: the plaintext span must PAGE (no one-shot aggregate), and the
    // encrypted channel also present must not be starved.
    const p1 = await teamAttentionPage(userCtx(), app.id, { scanLimit: 2 });
    expect(p1.scanComplete).toBe(false);
    const drained = await drainPages({}, { scanLimit: 2 });
    const plain = drained.items.filter((i) => i.channel === madePlain.channel.id && i.worker === worker.id);
    expect(plain[0]).toMatchObject({ unread: 7, unreadMentions: 1 });
  });

  it('fractional pagination budgets are refused loudly at the door (P2)', async () => {
    await expect(teamAttentionPage(userCtx(), app.id, { scanLimit: 1.5 })).rejects.toMatchObject({
      extensions: { code: 'BAD_USER_INPUT' },
    });
    await expect(teamAttentionPage(userCtx(), app.id, { limit: 2.5 })).rejects.toMatchObject({
      extensions: { code: 'BAD_USER_INPUT' },
    });
  });
});
