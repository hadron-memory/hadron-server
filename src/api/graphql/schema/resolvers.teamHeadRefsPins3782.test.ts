/**
 * #3782 — regression pins the optional P3s of #3766 (`teamHeadRefs`, #3759) asked for. Test-only. Same fixture as
 * resolvers.teamHeadRefs3759.test.ts: heads A, B, C, messages 1:[A] 2:[B] 3:[C] 4:untagged 5:[A,B].
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildSchema, defaultFieldResolver, graphql } from 'graphql';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { ensureChannelWithRoot } from '../../../lib/channels.js';
import { encryptNodeFieldsWithKey } from '../../../lib/nodeCrypto.js';
import { generateDataKey } from '../../../lib/crypto.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

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

let sealKey: ReturnType<typeof generateDataKey>;
async function seal(): Promise<void> {
  const key = generateDataKey();
  sealKey = key;
  sessionKeyCache.set('thr-3782', memory.id, key);
  await db.memory.update({ where: { id: memory.id }, data: { isEncrypted: true } });
  for (const m of await db.node.findMany({ where: { memoryId: memory.id, nodeType: 'chat-message' } })) {
    const enc = encryptNodeFieldsWithKey({ content: m.content ?? null, data: (m.data ?? null) as unknown }, key);
    await db.node.update({ where: { id: m.id }, data: { content: enc.content ?? null, data: enc.data as never } });
  }
}


const schema = buildSchema(typeDefs);
/** Real GraphQL execution (argument coercion, selection-driven `info`), resolvers wired as the server does. */
function exec(source: string, variableValues: Record<string, unknown>) {
  return graphql({
    schema, source, variableValues, contextValue: ctx(manager.id),
    fieldResolver(parent, args, context, info) {
      const fn = (resolvers as any)[info.parentType.name]?.[info.fieldName];
      return typeof fn === 'function' ? fn(parent, args, context, info) : defaultFieldResolver(parent, args, context, info);
    },
  });
}
const CHANNEL_Q = `query($c: ID!, $h: [ID!], $l: Int, $o: Int) { channelMessages(channelRef: $c, teamHeadRefs: $h, limit: $l, offset: $o, advanceReadState: false) { items { seq } } }`;
const CHANNEL_TOTAL_Q = `query($c: ID!, $h: [ID!], $l: Int, $o: Int) { channelMessages(channelRef: $c, teamHeadRefs: $h, limit: $l, offset: $o, advanceReadState: false) { items { seq } total } }`;
const TEAM_Q = `query($a: ID!, $h: [ID!]) { teamChatMessages(appRef: $a, teamHeadRefs: $h, limit: 100, advanceReadState: false) { items { seq } total } }`;

for (const mode of ['plaintext', 'encrypted'] as const) {
  describe(`#3782 teamHeadRefs pins (${mode})`, () => {
    beforeEach(async () => { if (mode === 'encrypted') await seal(); });

    it('pin 1: pages across interleaved non-matching messages with a small limit/offset; total is the filtered count', async () => {
      const h = [heads.A, heads.B];
      expect(seqsOf(await read({ teamHeadRefs: h, limit: 1, offset: 0 }))).toEqual([seqs.a]);
      expect(seqsOf(await read({ teamHeadRefs: h, limit: 1, offset: 1 }))).toEqual([seqs.b]);
      expect(seqsOf(await read({ teamHeadRefs: h, limit: 2, offset: 2 }))).toEqual([seqs.ab]);
      const page = await read({ teamHeadRefs: h, limit: 1, offset: 1 });
      expect(page.total).toBe(3);
      expect(seqsOf(await read({ teamHeadRefs: h, limit: 1, offset: 3 }))).toEqual([]);
    });

    it('pin 2: a former head (reports moved away) that still has a stamped message is accepted by the list as by teamHeadRef', async () => {
      const former = await mkWorker('Dhead', app.id);
      const report = await mkWorker('Dreport', app.id, former);
      const dSeq = await message(6, [former]);
      if (mode === 'encrypted') {
        const key = sealKey;
        const m = await db.node.findFirstOrThrow({ where: { memoryId: memory.id, seq: dSeq } });
        const enc = encryptNodeFieldsWithKey({ content: m.content ?? null, data: (m.data ?? null) as unknown }, key);
        await db.node.update({ where: { id: m.id }, data: { content: enc.content ?? null, data: enc.data as never } });
      }
      await db.worker.update({ where: { id: report }, data: { reportsToWorkerId: null } }); // `former` is no longer a head
      const single = await read({ teamHeadRef: former });
      expect(seqsOf(single)).toEqual([dSeq]);
      expect(seqsOf(await read({ teamHeadRefs: [former] }))).toEqual([dSeq]);
      expect(seqsOf(await read({ teamHeadRefs: [heads.A, former] }))).toEqual([seqs.a, seqs.ab, dSeq]);
      // A once-head that never stamped a message in this channel is still refused, like the single path.
      const unstamped = await mkWorker('Ehead', app.id);
      const eReport = await mkWorker('Ereport', app.id, unstamped);
      await db.worker.update({ where: { id: eReport }, data: { reportsToWorkerId: null } });
      expect((await refusal(read({ teamHeadRefs: [unstamped] }))).code).toBe('TEAM_CHAT_TEAM_HEAD_INVALID');
      expect(await refusal(read({ teamHeadRefs: [unstamped] }))).toEqual(await refusal(read({ teamHeadRef: unstamped })));
    });

    it('pin 3: an items-only selection (no total) pages 1 -> 2 -> 5 -> empty', async () => {
      const h = [heads.A, heads.B];
      const pageSeqs: number[][] = [];
      for (const offset of [0, 1, 2, 3]) {
        const r = await exec(CHANNEL_Q, { c: channel.id, h, l: 1, o: offset });
        expect(r.errors).toBeUndefined();
        pageSeqs.push((r.data as any).channelMessages.items.map((m: { seq: number }) => m.seq));
      }
      expect(pageSeqs).toEqual([[seqs.a], [seqs.b], [seqs.ab], []]);
    });

    it('pin 4: real GraphQL execution coerces and serves teamHeadRefs on both fields; a null list element is rejected', async () => {
      const h = [heads.A, heads.B];
      const ch = await exec(CHANNEL_TOTAL_Q, { c: channel.id, h, l: 100, o: 0 });
      expect(ch.errors).toBeUndefined();
      expect((ch.data as any).channelMessages).toEqual({ items: [{ seq: seqs.a }, { seq: seqs.b }, { seq: seqs.ab }], total: 3 });
      const tm = await exec(TEAM_Q, { a: app.id, h });
      expect(tm.errors).toBeUndefined();
      expect((tm.data as any).teamChatMessages).toEqual({ items: [{ seq: seqs.a }, { seq: seqs.b }, { seq: seqs.ab }], total: 3 });
      // `[ID!]` on the field: a variable declared `[ID]` is refused at validation, so a null entry can never reach a
      // resolver and the SDL is what is pinned (declaring the variable `[ID!]` would test only the variable).
      for (const [q, vars] of [[CHANNEL_Q, { c: channel.id, h: [heads.A, null] }], [TEAM_Q, { a: app.id, h: [null] }]] as const) {
        const loose = q.replace('$h: [ID!]', '$h: [ID]');
        const bad = await exec(loose, vars as Record<string, unknown>);
        expect(bad.data).toBeUndefined();
        expect(bad.errors?.[0]?.message).toMatch(/\[ID\]|\[ID!\]/);
      }
    });

    it('pin 5: mutual exclusion is judged BEFORE per-ref validation (a foreign ref plus teamHeadRef/untagged is BAD_USER_INPUT, not the head refusal)', async () => {
      expect((await refusal(read({ teamHeadRefs: [foreignHead], teamHeadRef: heads.A }))).code).toBe('BAD_USER_INPUT');
      expect((await refusal(read({ teamHeadRefs: [foreignHead], untagged: true }))).code).toBe('BAD_USER_INPUT');
      expect((await refusal(read({ teamHeadRefs: [foreignHead], untagged: false }))).code).toBe('BAD_USER_INPUT');
    });
  });
}
