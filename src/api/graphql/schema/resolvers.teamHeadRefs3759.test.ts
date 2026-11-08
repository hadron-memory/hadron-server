/**
 * #3759 / cor:agt:020:04 — `teamHeadRefs` on `teamChatMessages` / `channelMessages`: several team heads at once,
 * messages tagged with ANY of them (OR). Companion to hadron-portal#1482 (Holger's answer B).
 *
 * Refusal order (so no ref leaks): metadata gate, mutual exclusion, cap, then per-ref validation. One bad ref
 * refuses the whole call with the single-head text. `[]` is no team filter. The same ANY meaning holds on an
 * encrypted channel, which filters after decryption.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { ensureChannelWithRoot } from '../../../lib/channels.js';
import { encryptNodeFieldsWithKey } from '../../../lib/nodeCrypto.js';
import { generateDataKey } from '../../../lib/crypto.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const Q = resolvers.Query as any;
const ctx = (userId: string): Context => ({ db, userId, roles: ['READER'] }) as Context;

let org: { id: string; urn: string };
let manager: { id: string };
let app: { id: string; urn: string };
let agent: { id: string };
let memory: { id: string };
let channel: { id: string; loc: string };
let heads: { A: string; B: string; C: string };
let foreignHead: string;
const seqs: Record<'a' | 'b' | 'c' | 'ab' | 'none', number> = { a: 0, b: 0, c: 0, ab: 0, none: 0 };

async function mkWorker(name: string, appId: string, reportsTo: string | null = null): Promise<string> {
  const w = await db.worker.create({
    data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId, agentId: agent.id, name, slug: `${name.toLowerCase()}-${generateId().slice(0, 6)}`, reportsToWorkerId: reportsTo },
    select: { id: true },
  });
  return w.id;
}

async function message(seq: number, headIds: string[] | null) {
  const msgNum = String(seq).padStart(3, '0');
  const data: Record<string, unknown> = { authorName: 'Ada', mentions: [] };
  if (headIds) Object.assign(data, { teamTagsVersion: 1, teamTags: headIds.map((headId) => ({ headId, label: `team.${headId.slice(0, 4)}` })), teamHeadIds: headIds });
  await db.node.create({
    data: { id: generateId(), memoryId: memory.id, loc: `${channel.loc}:messages:${msgNum}`, name: msgNum, nodeType: 'chat-message', seq, messageChannelId: channel.id, content: `m${seq}`, data: data as never },
  });
  return seq;
}

const read = (args: Record<string, unknown>, userId = manager.id) =>
  Q.channelMessages({}, { channelRef: channel.id, limit: 100, advanceReadState: false, ...args }, ctx(userId));
const readTeam = (args: Record<string, unknown>, userId = manager.id) =>
  Q.teamChatMessages({}, { appRef: app.id, limit: 100, advanceReadState: false, ...args }, ctx(userId));
const seqsOf = (page: { items: Array<{ seq: number }> }) => page.items.map((m) => m.seq);
async function refusal(p: Promise<unknown>): Promise<{ code: unknown; message: string }> {
  return p.then(
    () => ({ code: 'NONE', message: '' }),
    (e: { extensions?: { code?: unknown }; message: string }) => ({ code: e.extensions?.code, message: e.message }),
  );
}

beforeEach(async () => {
  await cleanDb(db);
  sessionKeyCache.clear();
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'thr-org', urn: `thr-org-${suffix}.com` } });
  manager = await db.user.create({ data: { id: generateId(), githubId: 99_100 + Math.floor(Math.random() * 1e4), githubUsername: `thr-${suffix}`, roles: ['READER'] }, select: { id: true } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: manager.id, role: 'ADMIN' } });
  agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team`, visibility: 'ORGANIZATION' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  memory = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:team-shared`, name: 'shared', class: 'app', appId: app.id, sharedMemoryOfAgentId: agent.id } });
  const made = await ensureChannelWithRoot(db, { memoryId: memory.id, loc: 'chats:team', name: 'team', createdBy: manager.id, asDefaultOfAppId: app.id });
  channel = { id: made.channel.id, loc: 'chats:team' };

  // Three heads, each with one live report (the head predicate), and a head in ANOTHER App.
  const [A, B, C] = [await mkWorker('Ahead', app.id), await mkWorker('Bhead', app.id), await mkWorker('Chead', app.id)];
  for (const [i, h] of [A, B, C].entries()) await mkWorker(`Report${i}`, app.id, h);
  heads = { A, B, C };
  const otherApp = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Other', urn: `${org.urn}:other` } });
  const otherHead = await mkWorker('Ohead', otherApp.id);
  await mkWorker('Oreport', otherApp.id, otherHead);
  foreignHead = otherHead;

  seqs.a = await message(1, [A]);
  seqs.b = await message(2, [B]);
  seqs.c = await message(3, [C]);
  seqs.none = await message(4, null);
  seqs.ab = await message(5, [A, B]);
});

async function seal(): Promise<void> {
  const key = generateDataKey();
  sessionKeyCache.set('thr-3759', memory.id, key);
  await db.memory.update({ where: { id: memory.id }, data: { isEncrypted: true } });
  for (const m of await db.node.findMany({ where: { memoryId: memory.id, nodeType: 'chat-message' } })) {
    const enc = encryptNodeFieldsWithKey({ content: m.content ?? null, data: (m.data ?? null) as unknown }, key);
    await db.node.update({ where: { id: m.id }, data: { content: enc.content ?? null, data: enc.data as never } });
  }
}

describe('#3759 teamHeadRefs — ANY of several heads', () => {
  it('returns exactly the messages tagged with A or B (a message tagged with both once), excluding C and untagged', async () => {
    expect(seqsOf(await read({ teamHeadRefs: [heads.A, heads.B] }))).toEqual([seqs.a, seqs.b, seqs.ab]);
    expect(seqsOf(await readTeam({ teamHeadRefs: [heads.A, heads.B] }))).toEqual([seqs.a, seqs.b, seqs.ab]);
    expect(seqsOf(await read({ teamHeadRefs: [heads.C] }))).toEqual([seqs.c]);
  });

  it('total counts the filtered range; sinceSeq and beforeSeq compose', async () => {
    const page = await read({ teamHeadRefs: [heads.A, heads.B] });
    expect(page.total).toBe(3);
    expect(seqsOf(await read({ teamHeadRefs: [heads.A, heads.B], sinceSeq: seqs.a }))).toEqual([seqs.b, seqs.ab]);
    expect(seqsOf(await read({ teamHeadRefs: [heads.A, heads.B], beforeSeq: seqs.ab }))).toEqual([seqs.a, seqs.b]);
  });

  it('[A, A] behaves as [A]', async () => {
    expect(seqsOf(await read({ teamHeadRefs: [heads.A, heads.A] }))).toEqual(seqsOf(await read({ teamHeadRefs: [heads.A] })));
    expect(seqsOf(await read({ teamHeadRefs: [heads.A, heads.A] }))).toEqual([seqs.a, seqs.ab]);
  });

  it('a one-entry list reads as teamHeadRef does', async () => {
    expect(seqsOf(await read({ teamHeadRefs: [heads.B] }))).toEqual(seqsOf(await read({ teamHeadRef: heads.B })));
  });

  it('an encrypted channel returns A and B and excludes C and untagged (post-decryption path)', async () => {
    await seal();
    expect(seqsOf(await read({ teamHeadRefs: [heads.A, heads.B] }))).toEqual([seqs.a, seqs.b, seqs.ab]);
    expect(seqsOf(await read({ teamHeadRefs: [heads.A, heads.A] }))).toEqual([seqs.a, seqs.ab]);
    const refused = await refusal(read({ teamHeadRefs: [heads.A, foreignHead] }));
    expect(refused.code).toBe('TEAM_CHAT_TEAM_HEAD_INVALID');
  });

  it('[] is no team filter: the unfiltered page, no metadata needed', async () => {
    expect(seqsOf(await read({ teamHeadRefs: [] }))).toEqual([1, 2, 3, 4, 5]);
    // Same on an App-less Channel where every team filter refuses for metadata.
    await db.memory.update({ where: { id: memory.id }, data: { class: 'knowledge', appId: null, sharedMemoryOfAgentId: null } });
    expect(seqsOf(await read({ teamHeadRefs: [] }))).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('#3759 teamHeadRefs — refusals', () => {
  it('one foreign or unknown ref refuses the whole call, byte-identically to each other and to the single head', async () => {
    const foreign = await refusal(read({ teamHeadRefs: [heads.A, foreignHead] }));
    const unknown = await refusal(read({ teamHeadRefs: [heads.A, generateId()] }));
    const single = await refusal(read({ teamHeadRef: foreignHead }));
    expect(foreign.code).toBe('TEAM_CHAT_TEAM_HEAD_INVALID');
    expect(foreign).toEqual(unknown);
    expect(foreign).toEqual(single);
    // The position of the bad entry does not change the answer.
    expect(await refusal(read({ teamHeadRefs: [foreignHead, heads.A] }))).toEqual(foreign);
  });

  it('a leaf (non-head) ref refuses like a foreign one', async () => {
    const leaf = (await db.worker.findFirstOrThrow({ where: { appId: app.id, reportsToWorkerId: heads.A }, select: { id: true } })).id;
    expect((await refusal(read({ teamHeadRefs: [leaf, heads.B] }))).code).toBe('TEAM_CHAT_TEAM_HEAD_INVALID');
  });

  it('the list with teamHeadRef is refused as mutually exclusive', async () => {
    const r = await refusal(read({ teamHeadRefs: [heads.A], teamHeadRef: heads.B }));
    expect(r.code).toBe('BAD_USER_INPUT');
  });

  it('the list with untagged true OR false is refused as mutually exclusive', async () => {
    expect((await refusal(read({ teamHeadRefs: [heads.A], untagged: true }))).code).toBe('BAD_USER_INPUT');
    expect((await refusal(read({ teamHeadRefs: [heads.A], untagged: false }))).code).toBe('BAD_USER_INPUT');
  });

  it('20 entries read, 21 refuse; duplicates count toward the cap by raw length', async () => {
    const twenty = Array.from({ length: 20 }, () => heads.A);
    expect(seqsOf(await read({ teamHeadRefs: twenty }))).toEqual([seqs.a, seqs.ab]);
    const over = await refusal(read({ teamHeadRefs: [...twenty, heads.A] }));
    expect(over.code).toBe('BAD_USER_INPUT');
    expect(over.message).toMatch(/at most 20/);
  });

  it('a 21-entry list with a foreign ref refuses as the cap, not as the ref', async () => {
    const list = [foreignHead, ...Array.from({ length: 20 }, () => heads.A)];
    const r = await refusal(read({ teamHeadRefs: list }));
    expect(r.code).toBe('BAD_USER_INPUT');
    expect(r).not.toEqual(await refusal(read({ teamHeadRefs: [foreignHead] })));
  });

  it('a caller without team metadata learns nothing about refs: metadata refusal comes first', async () => {
    await db.memory.update({ where: { id: memory.id }, data: { class: 'knowledge', appId: null, sharedMemoryOfAgentId: null } });
    const bad = { code: 'TEAM_CHAT_TEAM_METADATA_FORBIDDEN' };
    for (const args of [
      { teamHeadRefs: [heads.A] },
      { teamHeadRefs: [foreignHead] },
      { teamHeadRefs: [heads.A], teamHeadRef: heads.B },
      { teamHeadRefs: [heads.A], untagged: true },
      { teamHeadRefs: Array.from({ length: 21 }, () => foreignHead) },
    ]) {
      expect(await refusal(read({ ...args, limit: 0 }))).toMatchObject({ ...bad });
    }
    // All five answers are the same text.
    const answers = await Promise.all([{ teamHeadRefs: [heads.A] }, { teamHeadRefs: [foreignHead] }].map((a) => refusal(read(a))));
    expect(answers[0]).toEqual(answers[1]);
  });
});
