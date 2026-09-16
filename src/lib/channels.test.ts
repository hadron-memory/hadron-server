/**
 * Spec 049 Phase 4 — the Channel entity (D-2026-09-13-006), what is pinned:
 *   - creation makes root, `:messages` and row in one go, and sets the App's
 *     default when asked;
 *   - the address is PROTECTED: a generic node create under it is refused
 *     (LOC_PROTECTED) on the resolver AND the lock helper, while the
 *     Channel's own writer passes (`ownedByChannel`);
 *   - a tombstoned Channel still protects, and deletion removes the root and
 *     unlinks the App default; an overlapping address is refused;
 *   - a non-app-class host is refused (the chat-host rule);
 *   - the read gate follows the host memory: a stranger sees null / empty;
 *   - the host memory cannot be deleted while it hosts a live Channel;
 *   - the backfill mints rows for existing roots with the allocator's
 *     watermark (deleted messages count), sets the App default, provisions
 *     never-posted Apps, and is idempotent.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { ensureChannelWithRoot } from './channels.js';
import { assertLocWritable, LocProtectedError, partitionProtected } from './protectedLoc.js';
import { lockAncestorsForCreate, lockLocForWrite } from './nodeSubtreeLock.js';
import { backfillChannels } from '../jobs/backfillChannels.js';
import { appendChatMessage } from './chatRoot.js';
import { getMemoryEncryptionInfo } from './nodeCrypto.js';

const Q = resolvers.Query as any;
const M = resolvers.Mutation as any;

let org: { id: string; urn: string };
let admin: { id: string };
let stranger: { id: string };
let app: { id: string; urn: string; name: string };
let appMem: { id: string; urn: string };
let knowledge: { id: string; urn: string };

const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] }) as Context;

beforeEach(async () => {
  await cleanDb(db);
  const t = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'ch', urn: `ch-${t}` } });
  admin = await db.user.create({ data: { id: generateId(), githubId: 49101, githubUsername: `ch-admin-${t}` } });
  stranger = await db.user.create({ data: { id: generateId(), githubId: 49102, githubUsername: `ch-stranger-${t}` } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  const agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'agent', urn: `${org.urn}:agent`, visibility: 'ORGANIZATION' } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await db.appMember.create({ data: { appId: app.id, userId: admin.id, role: 'admin' } });
  appMem = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:team-shared`, name: 'shared', class: 'app', appId: app.id, sharedMemoryOfAgentId: agent.id },
  });
  knowledge = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:kb`, name: 'kb', class: 'knowledge', visibility: 'ORGANIZATION' },
  });
});

describe('creation', () => {
  it('makes the root, its :messages child and the row together, and sets the App default', async () => {
    const { channel, rootId } = await ensureChannelWithRoot(db, {
      memoryId: appMem.id, loc: 'chats:team', name: 'team', createdBy: admin.id, asDefaultOfAppId: app.id,
    });
    expect(channel.chatRootNodeId).toBe(rootId);
    expect(channel.lastSeq).toBe(0);
    const locs = (await db.node.findMany({ where: { memoryId: appMem.id }, select: { loc: true } })).map((n) => n.loc).sort();
    expect(locs).toEqual(['chats', 'chats:team', 'chats:team:messages']);
    const a = await db.app.findUniqueOrThrow({ where: { id: app.id } });
    expect(a.defaultChannelId).toBe(channel.id);
    // Idempotent: a second call finds the same row.
    const again = await ensureChannelWithRoot(db, { memoryId: appMem.id, loc: 'chats:team', name: 'team', createdBy: admin.id });
    expect(again.channel.id).toBe(channel.id);
  });

  it('refuses a host that is not app-class', async () => {
    await expect(
      ensureChannelWithRoot(db, { memoryId: knowledge.id, loc: 'chats:x', name: 'x', createdBy: admin.id }),
    ).rejects.toMatchObject({ extensions: { code: 'CHANNEL_HOST_NOT_APP_CLASS' } });
  });

  it('createChannel refuses an address overlapping an existing Channel', async () => {
    await M.createChannel({}, { input: { memoryRef: appMem.urn, loc: 'chats:team', name: 'team' } }, ctx(admin.id));
    await expect(
      M.createChannel({}, { input: { memoryRef: appMem.urn, loc: 'chats:team:sub', name: 'sub' } }, ctx(admin.id)),
    ).rejects.toMatchObject({ extensions: { code: 'LOC_OVERLAPS_CHANNEL' } });
    await expect(
      M.createChannel({}, { input: { memoryRef: appMem.urn, loc: 'chats', name: 'all' } }, ctx(admin.id)),
    ).rejects.toMatchObject({ extensions: { code: 'LOC_OVERLAPS_CHANNEL' } });
    const other = await M.createChannel({}, { input: { memoryRef: appMem.urn, loc: 'chats:release', name: 'release' } }, ctx(admin.id));
    expect(other.loc).toBe('chats:release');
  });
});

describe('protection (S4)', () => {
  beforeEach(async () => {
    await ensureChannelWithRoot(db, { memoryId: appMem.id, loc: 'chats:team', name: 'team', createdBy: admin.id, asDefaultOfAppId: app.id });
  });

  it('a generic createNode under the Channel is refused; a sibling is not', async () => {
    await expect(
      M.createNode({}, { input: { memoryId: appMem.urn, loc: 'chats:team:messages:0001', name: 'm' } }, ctx(admin.id)),
    ).rejects.toMatchObject({ extensions: { code: 'LOC_PROTECTED', channelLoc: 'chats:team' } });
    await expect(
      M.createNode({}, { input: { memoryId: appMem.urn, loc: 'chats:team', name: 'root' } }, ctx(admin.id)),
    ).rejects.toMatchObject({ extensions: { code: 'LOC_PROTECTED' } });
    // An ancestor is protected too (moving `chats` would move the Channel).
    await expect(
      M.createNode({}, { input: { memoryId: appMem.urn, loc: 'chats', name: 'chats' } }, ctx(admin.id)),
    ).rejects.toMatchObject({ extensions: { code: 'LOC_PROTECTED' } });
    const ok = await M.createNode({}, { input: { memoryId: appMem.urn, loc: 'chats-notes', name: 'n' } }, ctx(admin.id));
    expect(ok.loc).toBe('chats-notes');
  });

  it('the lock helpers gate, and the Channel owner passes with ownedByChannel', async () => {
    await db.$transaction(async (tx) => {
      await expect(lockAncestorsForCreate(tx, appMem.id, 'chats:team:messages:0002')).rejects.toBeInstanceOf(LocProtectedError);
    });
    await db.$transaction(async (tx) => {
      await expect(lockLocForWrite(tx, appMem.id, 'chats:team')).rejects.toBeInstanceOf(LocProtectedError);
    });
    await db.$transaction(async (tx) => {
      await lockAncestorsForCreate(tx, appMem.id, 'chats:team:messages:0002', { ownedByChannel: true });
    });
    const split = await partitionProtected(db, appMem.id, ['chats:team:messages:x', 'notes:a']);
    expect(split.allowed).toEqual(['notes:a']);
    expect(split.refused.map((r) => r.loc)).toEqual(['chats:team:messages:x']);
  });

  it('a tombstoned Channel still protects; deleteChannel removes the root and unlinks the default', async () => {
    const before = await db.app.findUniqueOrThrow({ where: { id: app.id } });
    const channelId = before.defaultChannelId!;
    expect(await M.deleteChannel({}, { ref: channelId }, ctx(admin.id))).toBe(true);
    const root = await db.node.findFirst({ where: { memoryId: appMem.id, loc: 'chats:team' } });
    expect(root?.deletedAt).not.toBeNull();
    expect((await db.app.findUniqueOrThrow({ where: { id: app.id } })).defaultChannelId).toBeNull();
    await expect(assertLocWritable(db, appMem.id, 'chats:team:messages:0003', 'write')).rejects.toBeInstanceOf(LocProtectedError);
    expect(await Q.channel({}, { ref: channelId }, ctx(admin.id))).toBeNull();
  });

  it('the host memory cannot be deleted while it hosts a live Channel', async () => {
    await expect(M.deleteMemory({}, { id: appMem.urn }, ctx(admin.id))).rejects.toMatchObject({ extensions: { code: 'MEMORY_HOSTS_CHANNEL' } });
  });
});

describe('reads follow the host memory', () => {
  it('a member reads and lists; a stranger sees null and an empty page', async () => {
    const { channel } = await ensureChannelWithRoot(db, { memoryId: appMem.id, loc: 'chats:team', name: 'team', createdBy: admin.id, asDefaultOfAppId: app.id });
    expect((await Q.channel({}, { ref: channel.id }, ctx(admin.id)))?.id).toBe(channel.id);
    const page = await Q.channels({}, { filter: { appRef: app.urn } }, ctx(admin.id));
    expect(page.total).toBe(1);
    expect(page.items[0].loc).toBe('chats:team');
    expect(await Q.channel({}, { ref: channel.id }, ctx(stranger.id))).toBeNull();
    expect((await Q.channels({}, { filter: { appRef: app.urn } }, ctx(stranger.id))).total).toBe(0);
    await expect(M.updateChannel({}, { ref: channel.id, input: { name: 'x' } }, ctx(stranger.id))).rejects.toThrow();
    const renamed = await M.updateChannel({}, { ref: channel.id, input: { name: 'crew', description: 'the crew' } }, ctx(admin.id));
    expect(renamed.name).toBe('crew');
    expect(renamed.description).toBe('the crew');
  });
});

describe('backfill', () => {
  it('mints rows for existing roots with the allocator watermark, sets the default, provisions never-posted Apps, idempotent', async () => {
    // A pre-Channel team chat: root + messages, one of them deleted at the top seq.
    const root = await db.node.create({
      data: { id: generateId(), memoryId: appMem.id, loc: 'chats:team', name: 'Team chat', nodeType: 'chat', data: { messageCount: 2 } },
    });
    await db.node.create({ data: { id: generateId(), memoryId: appMem.id, loc: 'chats:team:messages', name: 'messages', nodeType: 'record' } });
    await db.node.create({ data: { id: generateId(), memoryId: appMem.id, loc: 'chats:team:messages:0001', name: '1', nodeType: 'chat-message', seq: 1 } });
    await db.node.create({ data: { id: generateId(), memoryId: appMem.id, loc: 'chats:team:messages:0002', name: '2', nodeType: 'chat-message', seq: 2 } });
    await db.node.create({ data: { id: generateId(), memoryId: appMem.id, loc: 'chats:team:messages:0005', name: '5', nodeType: 'chat-message', seq: 5, deletedAt: new Date() } });
    // A summary under the same prefix does NOT count (chatRoot.ts allowlist).
    await db.node.create({ data: { id: generateId(), memoryId: appMem.id, loc: 'chats:team:messages:0009', name: 's', nodeType: 'abstract', seq: 9 } });
    // A second App that never posted, with one shared app-class memory.
    // A second App that never posted, with one team-space memory (the #723 key
    // is what the canonical resolver recognises — a bare app-class row is not a team space).
    const app2 = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Quiet', urn: `${org.urn}:quiet` } });
    const agent2 = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'agent2', urn: `${org.urn}:agent2`, visibility: 'ORGANIZATION' } });
    await db.appAgent.create({ data: { appId: app2.id, agentId: agent2.id } });
    await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:quiet-shared`, name: 'qs', class: 'app', appId: app2.id, sharedMemoryOfAgentId: agent2.id } });

    const dry = await backfillChannels(db, { apply: false });
    expect(dry).toMatchObject({ rootsSeen: 1, rowsCreated: 1, defaultsSet: 1, defaultsProvisioned: 1 });
    expect(await db.channel.count()).toBe(0);

    const run = await backfillChannels(db, { apply: true });
    expect(run).toMatchObject({ rootsSeen: 1, rowsCreated: 1, defaultsSet: 1, defaultsProvisioned: 1, ambiguousApps: [] });
    const row = await db.channel.findUniqueOrThrow({ where: { chatRootNodeId: root.id } });
    expect(row.lastSeq).toBe(5);
    expect(row.deletedAt).toBeNull();
    expect((await db.app.findUniqueOrThrow({ where: { id: app.id } })).defaultChannelId).toBe(row.id);
    const quiet = await db.app.findUniqueOrThrow({ where: { id: app2.id } });
    expect(quiet.defaultChannelId).not.toBeNull();
    // loc-scope-ok: the App's own memories are the tenant scope (the backfill's locator).
    expect(await db.node.count({ where: { memory: { appId: app2.id }, loc: 'chats:team' } })).toBe(1);

    const again = await backfillChannels(db, { apply: true });
    expect(again).toMatchObject({ rootsSeen: 2, rowsCreated: 0, rowsRaised: 0, defaultsSet: 0, defaultsProvisioned: 0 });
  });
});

describe('PR #1165 review — the decisions only the lock can make', () => {
  it('the core refuses an overlapping address and a live non-chat occupant (LOC_OCCUPIED); a tombstoned chat root is adopted', async () => {
    await ensureChannelWithRoot(db, { memoryId: appMem.id, loc: 'chats:team', name: 'team', createdBy: admin.id });
    await expect(
      ensureChannelWithRoot(db, { memoryId: appMem.id, loc: 'chats:team:sub', name: 'sub', createdBy: admin.id }),
    ).rejects.toMatchObject({ extensions: { code: 'LOC_OVERLAPS_CHANNEL' } });
    await db.node.create({ data: { id: generateId(), memoryId: appMem.id, loc: 'notes:x', name: 'x', nodeType: 'record' } });
    await expect(
      ensureChannelWithRoot(db, { memoryId: appMem.id, loc: 'notes:x', name: 'x', createdBy: admin.id }),
    ).rejects.toMatchObject({ extensions: { code: 'LOC_OCCUPIED' } });
    expect(await db.channel.count({ where: { memoryId: appMem.id } })).toBe(1);
    // A tombstoned chat root at the address is revived as the Channel's root.
    const old = await db.node.create({ data: { id: generateId(), memoryId: appMem.id, loc: 'chats:old', name: 'old', nodeType: 'chat', deletedAt: new Date() } });
    const { rootId } = await ensureChannelWithRoot(db, { memoryId: appMem.id, loc: 'chats:old', name: 'old', createdBy: admin.id });
    expect(rootId).toBe(old.id);
    expect((await db.node.findUniqueOrThrow({ where: { id: old.id } })).deletedAt).toBeNull();
  });

  it('the chatbot surface is a generic writer: appendChatMessage on a Channel is refused unless the caller is the Channel operation', async () => {
    const { rootId } = await ensureChannelWithRoot(db, { memoryId: appMem.id, loc: 'chats:team', name: 'team', createdBy: admin.id });
    const chat = { id: rootId, memoryId: appMem.id, loc: 'chats:team' };
    const enc = await getMemoryEncryptionInfo(db, appMem.id);
    const insert = async ({ tx, seq, msgNum }: { tx: any; seq: number; msgNum: string }) =>
      tx.node.create({ data: { id: generateId(), memoryId: appMem.id, loc: `chats:team:messages:${msgNum}`, name: msgNum, nodeType: 'chat-message', seq } });
    await expect(appendChatMessage(db, chat, enc, insert)).rejects.toBeInstanceOf(LocProtectedError);
    const { seq } = await appendChatMessage(db, chat, enc, insert, { asChannel: true });
    expect(seq).toBe(1);
    expect((await db.channel.findUniqueOrThrow({ where: { chatRootNodeId: rootId } })).lastSeq).toBe(1);
    // A chat that is NOT a Channel is unaffected either way.
    const plain = await db.node.create({ data: { id: generateId(), memoryId: appMem.id, loc: 'chats:plain', name: 'plain', nodeType: 'chat', data: { messageCount: 0 } } });
    const r = await appendChatMessage(db, { id: plain.id, memoryId: appMem.id, loc: 'chats:plain' }, enc, async ({ tx, seq, msgNum }) =>
      tx.node.create({ data: { id: generateId(), memoryId: appMem.id, loc: `chats:plain:messages:${msgNum}`, name: msgNum, nodeType: 'chat-message', seq } }),
    );
    expect(r.seq).toBe(1);
  });

  it('App.defaultChannel follows the host memory: an org member who is not an App participant sees null', async () => {
    await ensureChannelWithRoot(db, { memoryId: appMem.id, loc: 'chats:team', name: 'team', createdBy: admin.id, asDefaultOfAppId: app.id });
    const member = await db.user.create({ data: { id: generateId(), githubId: 49103, githubUsername: `ch-member-${Date.now()}` } });
    await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: member.id, role: 'READER' } });
    const a = await db.app.findUniqueOrThrow({ where: { id: app.id } });
    const AppType = (resolvers as any).App;
    expect((await AppType.defaultChannel(a, {}, ctx(admin.id)))?.id).toBe(a.defaultChannelId);
    expect(await AppType.defaultChannel(a, {}, ctx(member.id))).toBeNull();
  });

  it('the backfill sweeps a root in a soft-deleted memory and never lowers a watermark', async () => {
    const gone = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:gone`, name: 'gone', class: 'app', appId: app.id, deletedAt: new Date() } });
    const root = await db.node.create({ data: { id: generateId(), memoryId: gone.id, loc: 'chats:team', name: 'Team chat', nodeType: 'chat', data: { messageCount: 4 } } });
    const run = await backfillChannels(db, { apply: true });
    expect(run.rowsCreated).toBe(1);
    const row = await db.channel.findUniqueOrThrow({ where: { chatRootNodeId: root.id } });
    expect(row.lastSeq).toBe(4);
    // A watermark the allocator moved past is left alone.
    await db.channel.update({ where: { id: row.id }, data: { lastSeq: 9 } });
    const again = await backfillChannels(db, { apply: true });
    expect(again.rowsRaised).toBe(0);
    expect((await db.channel.findUniqueOrThrow({ where: { id: row.id } })).lastSeq).toBe(9);
  });
});

describe('PR #1165 review round 2 — the remaining unlocked writers', () => {
  it('a live non-chat squatter at chats:team is refused by the team-chat locator/bootstrap (LOC_OCCUPIED), and mergeNodes onto a Channel root is refused', async () => {
    await db.node.create({ data: { id: generateId(), memoryId: appMem.id, loc: 'chats:team', name: 'squatter', nodeType: 'record' } });
    await expect(
      M.createTeamChatMessage({}, { appRef: app.urn, body: 'hello' }, ctx(admin.id)),
    ).rejects.toMatchObject({ extensions: { code: 'LOC_OCCUPIED' } });
    expect(await db.channel.count({ where: { memoryId: appMem.id } })).toBe(0);
    // A Channel elsewhere; merging a record INTO its root is refused, and so is deleting a merged source under it.
    const { rootId } = await ensureChannelWithRoot(db, { memoryId: appMem.id, loc: 'chats:release', name: 'release', createdBy: admin.id });
    const note = await db.node.create({ data: { id: generateId(), memoryId: appMem.id, loc: 'notes:n', name: 'n', nodeType: 'record', content: 'x' } });
    await expect(
      M.mergeNodes({}, { input: { source: note.id, target: rootId } }, ctx(admin.id)),
    ).rejects.toMatchObject({ extensions: { code: 'LOC_PROTECTED' } });
    const msg = await db.node.create({ data: { id: generateId(), memoryId: appMem.id, loc: 'chats:release:messages:0001', name: '1', nodeType: 'chat-message', seq: 1 } });
    await expect(
      M.mergeNodes({}, { input: { source: msg.id, target: note.id, deleteSource: true } }, ctx(admin.id)),
    ).rejects.toMatchObject({ extensions: { code: 'LOC_PROTECTED' } });
    // A root-level generic create at a root-level Channel address is refused too.
    await ensureChannelWithRoot(db, { memoryId: appMem.id, loc: 'announce', name: 'announce', createdBy: admin.id });
    await expect(
      M.createNode({}, { input: { memoryId: appMem.urn, loc: 'announce', name: 'a' } }, ctx(admin.id)),
    ).rejects.toMatchObject({ extensions: { code: 'LOC_PROTECTED' } });
  });
});

describe('addressing (#1171) — a Channel can be named after it is created', () => {
  it('emits its address and takes it back on every single-Channel operation', async () => {
    const { channel } = await ensureChannelWithRoot(db, {
      memoryId: appMem.id, loc: 'chats:team', name: 'team', createdBy: admin.id, asDefaultOfAppId: app.id,
    });
    const ChannelType = (resolvers as any).Channel;
    const address = await ChannelType.chatRootUrn(channel, {}, ctx(admin.id));
    // The address is the chat root's node URN — composed by the server so no
    // client has to, and identical to what `createChannel(memoryRef, loc)` was
    // given. Asserted as a value, not a shape, because a client PASTES it.
    expect(address).toBe(`hrn:node:${appMem.urn}:chats:team`);

    // Round trip: the string a read emits is a string the refs accept.
    expect((await Q.channel({}, { ref: address }, ctx(admin.id)))?.id).toBe(channel.id);
    const renamed = await M.updateChannel({}, { ref: address, input: { name: 'crew' } }, ctx(admin.id));
    expect(renamed.name).toBe('crew');
    expect(await M.deleteChannel({}, { ref: address }, ctx(admin.id))).toBe(true);
    expect(await Q.channel({}, { ref: channel.id }, ctx(admin.id))).toBeNull();
  });

  it('the address discloses no more than the id: a stranger reads null and cannot write', async () => {
    const { channel } = await ensureChannelWithRoot(db, { memoryId: appMem.id, loc: 'chats:team', name: 'team', createdBy: admin.id });
    const address = `hrn:node:${appMem.urn}:chats:team`;
    // Widening a ref to accept a URN is a re-authorization event
    // (cor:api:140:01), so the gate is asserted on the NEW form, not inherited
    // from the id form's tests: a real-but-unreadable Channel addressed by URN
    // reads exactly like an address that names nothing at all.
    expect(await Q.channel({}, { ref: address }, ctx(stranger.id))).toBeNull();
    expect(await Q.channel({}, { ref: `hrn:node:${appMem.urn}:chats:absent` }, ctx(stranger.id))).toBeNull();
    expect(await Q.channel({}, { ref: channel.id }, ctx(stranger.id))).toBeNull();
    await expect(M.updateChannel({}, { ref: address, input: { name: 'x' } }, ctx(stranger.id))).rejects.toThrow();
    await expect(M.deleteChannel({}, { ref: address }, ctx(stranger.id))).rejects.toThrow();
    expect((await db.channel.findUniqueOrThrow({ where: { id: channel.id } })).name).toBe('team');
  });
});
