/**
 * Spec 049 Phase 4 — the Channel entity (D-2026-09-13-006), what is pinned:
 *   - creation makes root, `:messages` and row in one go, and sets the App's
 *     default when asked;
 *   - the address is PROTECTED: a generic node create under it is refused
 *     (LOC_PROTECTED) on the resolver AND the lock helper, while the
 *     Channel's own writer passes (`ownedByOperation`);
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
import { ensureChannelWithRoot, lockMemoryForChannelChange } from './channels.js';
import { assertLocWritable, LocProtectedError, partitionProtected } from './protectedLoc.js';
import { lockAncestorsForCreate, lockLocForWrite } from './nodeSubtreeLock.js';
import { backfillChannels } from '../jobs/backfillChannels.js';
import { appendChatMessage } from './chatRoot.js';
import { encryptNodeFields, getMemoryEncryptionInfo } from './nodeCrypto.js';
import { generateDataKey } from './crypto.js';
import { sessionKeyCache } from './sessionKeyCache.js';

const Q = resolvers.Query as any;
const M = resolvers.Mutation as any;

let org: { id: string; urn: string };
let admin: { id: string };
let stranger: { id: string };
let app: { id: string; urn: string; name: string };
let appMem: { id: string; urn: string };
let knowledge: { id: string; urn: string };

const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] }) as Context;

/** Deterministic barrier: wait until this memory-scoped advisory key has a waiter. */
async function waitForChannelMemoryLockWaiter(
  memoryId: string,
  timeoutMs = 10_000,
  minimumWaiters = 1,
): Promise<void> {
  const key = `channel-host:${memoryId}`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [{ count }] = await db.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*)::bigint AS count
      FROM pg_locks
      WHERE locktype = 'advisory'
        AND NOT granted
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND classid = (((hashtext(${key})::bigint >> 32) & 4294967295))::oid
        AND objid = ((hashtext(${key})::bigint & 4294967295))::oid
        AND objsubid = 1
    `;
    if (Number(count) >= minimumWaiters) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for Channel memory-lock waiter on ${memoryId}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

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

  it('hosts a Channel in a memory of ANY class, and writes NO data.scope', async () => {
    // #1196 / Holger's #1193 ruling — the class gate is gone and
    // `CHANNEL_HOST_NOT_APP_CLASS` is retired, not repurposed. This replaces
    // `refuses a host that is not app-class`, which asserted the removed rule.
    // Safe only because the chat surfaces gate on the HOST MEMORY now: the
    // read/write half is pinned in resolvers.channelChat.test.ts.
    const { channel, rootId } = await ensureChannelWithRoot(db, {
      memoryId: knowledge.id,
      loc: 'chats:x',
      name: 'x',
      createdBy: admin.id,
    });
    expect(channel.memoryId).toBe(knowledge.id);

    // D-2026-08-10-005: the marker is GONE rather than stamped `'shared'`. A
    // Channel in a `private` memory is neither of its two values, so keeping it
    // would have meant writing something false.
    const root = await db.node.findUniqueOrThrow({ where: { id: rootId } });
    expect(root.nodeType).toBe('chat');
    expect((root.data as Record<string, unknown>).scope).toBeUndefined();
    expect((root.data as Record<string, unknown>).messageCount).toBe(0);
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

  it('a TOMBSTONED Channel still reserves its address against create, but no longer blocks DELETE (#1226)', async () => {
    // @Jonas measured the defect end-to-end: `deleteChannel` reports success,
    // the message subtree survives, and `node rm` on the survivors is refused
    // by a gate naming "the Channel's own operations" — operations of a Channel
    // that is gone. 7 nodes, later 14, that nothing could remove.
    //
    // Two halves, and they must not be conflated. RESERVATION is a claim about
    // who may PUT something at the address and must survive the tombstone (the
    // module header's original reason). CLEANUP is about removing what is
    // already there, and refusing it left the gate with no exit.
    const ch = await Q.channels(null, { filter: { memoryRef: appMem.urn } }, ctx(admin.id));
    const target = ch.items.find((c: { loc: string }) => c.loc === 'chats:team')!;
    // Posted through the Channel's OWN operation — the only writer of this
    // address, which is the whole reason the generic surface is gated.
    await M.createChannelMessage({}, { channelRef: target.id, body: 'hello' }, ctx(admin.id));
    await M.deleteChannel({}, { ref: target.id }, ctx(admin.id));

    // RESERVED: a generic create at or under the address is still refused, so a
    // dead team chat cannot be occupied and then "restored" over.
    await expect(
      M.createNode({}, { input: { memoryId: appMem.urn, loc: 'chats:team:messages:9999', name: 'squat' } }, ctx(admin.id)),
    ).rejects.toMatchObject({ extensions: { code: 'LOC_PROTECTED' } });

    // CLEANABLE: the orphaned subtree can now be deleted. Before #1226 this
    // threw LOC_PROTECTED and there was no operation that could.
    const orphan = await db.node.findFirst({
      where: { memoryId: appMem.id, loc: { startsWith: 'chats:team:messages:' }, deletedAt: null },
      select: { id: true },
    });
    expect(orphan).not.toBeNull();
    await expect(
      M.deleteNode({}, { nodeRef: orphan!.id }, ctx(admin.id)),
    ).resolves.toBeTruthy();
  });

  it('a LIVE Channel still refuses delete — the carve-out is by liveness, not a hole (#1226)', async () => {
    // The positive control for the test above: without this, "delete is
    // permitted" could mean the gate stopped covering delete entirely.
    const live = await Q.channels(null, { filter: { memoryRef: appMem.urn } }, ctx(admin.id));
    const liveCh = live.items.find((c: { loc: string }) => c.loc === 'chats:team')!;
    await M.createChannelMessage({}, { channelRef: liveCh.id, body: 'hi' }, ctx(admin.id));
    const msg = await db.node.findFirst({
      where: { memoryId: appMem.id, loc: { startsWith: 'chats:team:messages:' }, deletedAt: null },
      select: { id: true },
    });
    expect(msg).not.toBeNull();
    await expect(
      M.deleteNode({}, { nodeRef: msg!.id }, ctx(admin.id)),
    ).rejects.toMatchObject({ extensions: { code: 'LOC_PROTECTED' } });
  });

  it('recreating a Channel at a tombstoned address starts CLEAN, not with the old transcript (#1226)', async () => {
    // @Jonas measured the defect: delete, recreate at the same address, and
    // all four previous messages read back with `lastSeq` continuing. The
    // address is the only thing the two Channels share, and re-creating at a
    // known address is ordinary — so inheriting is a confidentiality edge,
    // not merely a surprise.
    const before = await Q.channels(null, { filter: { memoryRef: appMem.urn } }, ctx(admin.id));
    const first = before.items.find((c: { loc: string }) => c.loc === 'chats:team')!;
    await M.createChannelMessage({}, { channelRef: first.id, body: 'secret one' }, ctx(admin.id));
    await M.createChannelMessage({}, { channelRef: first.id, body: 'secret two', replyToSeq: 1 }, ctx(admin.id));
    const oldReply = await db.edge.findFirstOrThrow({
      where: { memoryId: appMem.id, name: 'replies-to', deletedAt: null },
      select: { id: true },
    });
    const oldMessage = await db.node.findFirstOrThrow({
      where: { memoryId: appMem.id, loc: { startsWith: 'chats:team:messages:' }, deletedAt: null },
      select: { id: true },
    });
    // A pre-#1196 team-chat root can still carry this retired marker. Reuse is
    // a new incarnation, so it must not inherit a stale audience assertion.
    const oldChannel = await db.channel.findUniqueOrThrow({ where: { id: first.id } });
    const oldRoot = await db.node.findUniqueOrThrow({ where: { id: oldChannel.chatRootNodeId } });
    await db.node.update({
      where: { id: oldRoot.id },
      data: {
        abstract: 'old summary',
        abstractOriginHash: 'deadbeef',
        content: 'old root payload',
        contentHash: 'cafebabe',
        embeddingPendingAt: new Date(),
        embeddingFailedAt: new Date(),
        embeddingAttempts: 3,
        embeddingError: 'old failure',
        tokens: 42,
        data: { ...(oldRoot.data as Record<string, unknown>), scope: 'shared' },
      },
    });
    await db.nodeEmbedding.create({
      data: {
        id: generateId(), nodeId: oldRoot.id, memoryId: appMem.id,
        kind: 'abstract', provider: 'old', model: 'old', dim: 768,
      },
    });
    await M.deleteChannel({}, { ref: first.id }, ctx(admin.id));

    // Recreate at the SAME address. The schema forces a resurrection —
    // `@@unique([loc, memoryId])` has no `deletedAt`, so the tombstone holds
    // the loc and no second node can be inserted there.
    const { channel: reborn } = await ensureChannelWithRoot(db, {
      memoryId: appMem.id, loc: 'chats:team', name: 'team', createdBy: admin.id,
    });

    const msgs = await Q.channelMessages(null, { channelRef: reborn.id }, ctx(admin.id));
    expect(msgs.items).toHaveLength(0);

    const emptyState = await db.channel.findUniqueOrThrow({ where: { id: reborn.id } });
    expect(emptyState.incarnation).toBe(oldChannel.incarnation + 1);
    expect(emptyState.lastSeq).toBe(0);
    expect(emptyState.lastMessageAt).toBeNull();
    const cleanRoot = await db.node.findUniqueOrThrow({ where: { id: reborn.chatRootNodeId } });
    expect((cleanRoot.data as Record<string, unknown>).lastMessageAt).toBeUndefined();
    expect((cleanRoot.data as Record<string, unknown>).scope).toBeUndefined();
    expect(cleanRoot.abstract).toBeNull();
    expect(cleanRoot.abstractOriginHash).toBeNull();
    expect(cleanRoot.content).toBeNull();
    expect(cleanRoot.contentHash).toBeNull();
    expect(cleanRoot.embeddingPendingAt).toBeNull();
    expect(cleanRoot.embeddingFailedAt).toBeNull();
    expect(cleanRoot.embeddingAttempts).toBe(0);
    expect(cleanRoot.embeddingError).toBeNull();
    expect(cleanRoot.tokens).toBeNull();
    expect(await db.nodeEmbedding.count({ where: { nodeId: cleanRoot.id } })).toBe(0);
    expect((await db.edge.findUniqueOrThrow({ where: { id: oldReply.id } })).deletedAt).not.toBeNull();

    // A caller may retry the stable id it deleted before reuse. Reset already
    // tombstoned that row, so GraphQL must preserve its soft-delete idempotency
    // instead of treating the now-live Channel as a new delete attempt.
    const deletedAt = (await db.node.findUniqueOrThrow({ where: { id: oldMessage.id } })).deletedAt;
    expect(deletedAt).not.toBeNull();
    await expect(M.deleteNode({}, { nodeRef: oldMessage.id }, ctx(admin.id))).resolves.toBe(true);
    expect((await db.node.findUniqueOrThrow({ where: { id: oldMessage.id } })).deletedAt).toEqual(deletedAt);

    // The ALLOCATOR counter deliberately does NOT restart, even though the
    // live Channel watermark above does. Existing cursors then see an empty
    // room now and cannot hide the next message; the next seq still exceeds
    // every old cursor. Pinned so nobody conflates the two numbers again.
    const posted = await M.createChannelMessage({}, { channelRef: reborn.id, body: 'fresh' }, ctx(admin.id));
    expect(posted.seq).toBeGreaterThan(2);
    const after = await Q.channelMessages(null, { channelRef: reborn.id }, ctx(admin.id));
    expect(after.items.map((m: { body: string }) => m.body)).toEqual(['fresh']);
  });

  it('the default team-chat convenience path uses the SAME clean-reuse core (#1226)', async () => {
    const current = await Q.channels(null, { filter: { memoryRef: appMem.urn } }, ctx(admin.id));
    const first = current.items.find((c: { loc: string }) => c.loc === 'chats:team')!;
    await M.createTeamChatMessage({}, { appRef: app.urn, body: 'old secret' }, ctx(admin.id));
    await M.deleteChannel({}, { ref: first.id }, ctx(admin.id));

    const fresh = await M.createTeamChatMessage({}, { appRef: app.urn, body: 'fresh room' }, ctx(admin.id));
    expect(fresh.seq).toBeGreaterThan(1);
    const reborn = await db.channel.findUniqueOrThrow({ where: { id: first.id } });
    const page = await Q.channelMessages(null, { channelRef: reborn.id }, ctx(admin.id));
    expect(page.items.map((m: { body: string }) => m.body)).toEqual(['fresh room']);
  });

  it('serializes orphan cleanup before reuse so it cannot delete the fresh incarnation (#1226)', async () => {
    const current = await Q.channels(null, { filter: { memoryRef: appMem.urn } }, ctx(admin.id));
    const first = current.items.find((c: { loc: string }) => c.loc === 'chats:team')!;
    await M.createChannelMessage({}, { channelRef: first.id, body: 'old transcript' }, ctx(admin.id));
    const messages = await db.node.findUniqueOrThrow({
      where: { loc_memoryId: { memoryId: appMem.id, loc: 'chats:team:messages' } },
    });
    await M.deleteChannel({}, { ref: first.id }, ctx(admin.id));

    let signalHeld!: () => void;
    let signalRelease!: () => void;
    const lockHeld = new Promise<void>((resolve) => { signalHeld = resolve; });
    const mayRelease = new Promise<void>((resolve) => { signalRelease = resolve; });
    const holder = db.$transaction(async (tx) => {
      await lockMemoryForChannelChange(tx, appMem.id);
      signalHeld();
      await mayRelease;
    }, { timeout: 20_000 });

    await lockHeld;
    // Queue cleanup first. The pg_locks barrier proves it has reached the
    // shared memory key; a sleep could pass without exercising the race.
    const deleting = M.deleteNode(
      {}, { nodeRef: messages.id, recursive: true }, ctx(admin.id),
    );
    try {
      await waitForChannelMemoryLockWaiter(appMem.id);
      const recreating = ensureChannelWithRoot(db, {
        memoryId: appMem.id, loc: 'chats:team', name: 'team', createdBy: admin.id,
      });
      signalRelease();
      await holder;
      await deleting;
      const { channel } = await recreating;

      await M.createChannelMessage({}, { channelRef: channel.id, body: 'fresh transcript' }, ctx(admin.id));
      const page = await Q.channelMessages(null, { channelRef: channel.id }, ctx(admin.id));
      expect(page.items.map((m: { body: string }) => m.body)).toEqual(['fresh transcript']);
    } finally {
      signalRelease();
      await holder.catch(() => undefined);
    }
  }, 20_000);

  it('serializes edge creation behind reuse and refuses the deleted transcript endpoint (#1226)', async () => {
    const { channel } = await ensureChannelWithRoot(db, {
      memoryId: appMem.id, loc: 'chats:edge-race', name: 'edge-race', createdBy: admin.id,
    });
    const oldMessage = await M.createChannelMessage(
      {}, { channelRef: channel.id, body: 'old transcript' }, ctx(admin.id),
    );
    const source = await db.node.create({
      data: { id: generateId(), memoryId: appMem.id, loc: 'edge-race-source', name: 'source' },
    });
    await M.deleteChannel({}, { ref: channel.id }, ctx(admin.id));

    let signalHeld!: () => void;
    let signalRelease!: () => void;
    const held = new Promise<void>((resolve) => { signalHeld = resolve; });
    const release = new Promise<void>((resolve) => { signalRelease = resolve; });
    const holder = db.$transaction(async (tx) => {
      await lockMemoryForChannelChange(tx, appMem.id);
      signalHeld();
      await release;
    }, { timeout: 20_000 });

    await held;
    const reusing = ensureChannelWithRoot(db, {
      memoryId: appMem.id, loc: 'chats:edge-race', name: 'edge-race', createdBy: admin.id,
    });
    try {
      // Queue reuse first, then prove createEdge has resolved the still-live old
      // message and is waiting on the same key before releasing the holder.
      await waitForChannelMemoryLockWaiter(appMem.id);
      const linking = M.createEdge(
        {},
        { sourceRef: source.id, targetRef: oldMessage.nodeId, name: 'points-to-old-message' },
        ({ ...ctx(admin.id), roles: ['CONTRIBUTOR'] }) as Context,
      );
      await waitForChannelMemoryLockWaiter(appMem.id, 10_000, 2);
      signalRelease();
      await holder;
      await reusing;
      await expect(linking).rejects.toMatchObject({ extensions: { code: 'NODE_NOT_FOUND' } });
      expect(await db.edge.count({
        where: { targetId: oldMessage.nodeId, deletedAt: null },
      })).toBe(0);
    } finally {
      signalRelease();
      await holder.catch(() => undefined);
    }
  }, 20_000);

  it('reuse treats underscores literally while tombstoning the old transcript (#1226)', async () => {
    const { channel } = await ensureChannelWithRoot(db, {
      memoryId: appMem.id, loc: 'chats_team', name: 'underscored', createdBy: admin.id,
    });
    await M.createChannelMessage({}, { channelRef: channel.id, body: 'old' }, ctx(admin.id));
    const unrelated = await db.node.create({
      data: { id: generateId(), memoryId: appMem.id, loc: 'chatsXteam:messages:0001', name: 'unrelated' },
    });
    const messages = await db.node.findUniqueOrThrow({
      where: { loc_memoryId: { memoryId: appMem.id, loc: 'chats_team:messages' } },
    });
    await M.deleteChannel({}, { ref: channel.id }, ctx(admin.id));
    await M.deleteNode({}, { nodeRef: messages.id, recursive: true }, ctx(admin.id));
    expect((await db.node.findUniqueOrThrow({ where: { id: unrelated.id } })).deletedAt).toBeNull();
    await ensureChannelWithRoot(db, {
      memoryId: appMem.id, loc: 'chats_team', name: 'underscored', createdBy: admin.id,
    });
    expect((await db.node.findUniqueOrThrow({ where: { id: unrelated.id } })).deletedAt).toBeNull();
  }, 20_000);

  it('rolls reuse back with typed SESSION_EXPIRED if the encryption key expires while waiting (#1226)', async () => {
    const privateMem = await db.memory.create({
      data: {
        id: generateId(), organizationId: org.id, urn: `${org.urn}:private-${generateId()}`,
        name: 'private', class: 'private', userId: admin.id,
      },
    });
    const { channel, rootId } = await ensureChannelWithRoot(db, {
      memoryId: privateMem.id, loc: 'chats:secret', name: 'secret', createdBy: admin.id,
    });
    const old = await M.createChannelMessage({}, { channelRef: channel.id, body: 'old secret' }, ctx(admin.id));
    await M.deleteChannel({}, { ref: channel.id }, ctx(admin.id));

    const key = generateDataKey();
    sessionKeyCache.set('reuse-session', privateMem.id, key);
    const root = await db.node.findUniqueOrThrow({ where: { id: rootId } });
    const encrypted = encryptNodeFields(
      { abstract: root.abstract, content: root.content, data: root.data },
      { id: privateMem.id, isEncrypted: true },
    );
    await db.$transaction([
      db.memory.update({ where: { id: privateMem.id }, data: { isEncrypted: true } }),
      db.node.update({
        where: { id: rootId },
        data: {
          abstract: encrypted.abstract,
          content: encrypted.content,
          data: encrypted.data as any,
        },
      }),
    ]);

    let signalHeld!: () => void;
    let signalRelease!: () => void;
    const held = new Promise<void>((resolve) => { signalHeld = resolve; });
    const release = new Promise<void>((resolve) => { signalRelease = resolve; });
    const holder = db.$transaction(async (tx) => {
      await lockMemoryForChannelChange(tx, privateMem.id);
      signalHeld();
      await release;
    }, { timeout: 20_000 });

    await held;
    const reusing = ensureChannelWithRoot(db, {
      memoryId: privateMem.id, loc: 'chats:secret', name: 'secret', createdBy: admin.id,
    });
    try {
      await waitForChannelMemoryLockWaiter(privateMem.id);
      sessionKeyCache.evict('reuse-session');
      signalRelease();
      await holder;
      await expect(reusing).rejects.toMatchObject({ extensions: { code: 'SESSION_EXPIRED' } });
      expect((await db.node.findUniqueOrThrow({ where: { id: rootId } })).deletedAt).not.toBeNull();
      expect((await db.channel.findUniqueOrThrow({ where: { id: channel.id } })).deletedAt).not.toBeNull();
      expect((await db.node.findUniqueOrThrow({ where: { id: old.nodeId } })).deletedAt).toBeNull();
    } finally {
      sessionKeyCache.clear();
      signalRelease();
      await holder.catch(() => undefined);
      await reusing.catch(() => undefined);
    }
  }, 20_000);

  it("a dead Channel's refusal does not name an operation that cannot be reached (#1226)", async () => {
    // The issue's third requirement, and it survived the op carve-out: a dead
    // Channel still refuses `create`, and the old remedy offered
    // createTeamChatMessage / hadron_team_chat_post — which resolve only LIVE
    // Channels (@copilot, PR #1257).
    const ch = await Q.channels(null, { filter: { memoryRef: appMem.urn } }, ctx(admin.id));
    const target = ch.items.find((c: { loc: string }) => c.loc === 'chats:team')!;
    await M.deleteChannel({}, { ref: target.id }, ctx(admin.id));

    const err = await M.createNode(
      {}, { input: { memoryId: appMem.urn, loc: 'chats:team:messages:9999', name: 'squat' } }, ctx(admin.id),
    ).catch((e: unknown) => e as { message: string; extensions: Record<string, unknown> });

    expect(err.extensions).toMatchObject({ code: 'LOC_PROTECTED', channelLive: false });
    // Names the reservation and a REACHABLE remedy...
    expect(err.message).toContain('DELETED');
    expect(err.message).toContain('createChannel');
    // ...and not the operations of a Channel that is gone.
    expect(err.message).not.toContain('createTeamChatMessage');
    expect(err.message).not.toContain('hadron_team_chat_post');
  });

  it("a LIVE Channel's refusal still names its own posting operation (#1226 control)", async () => {
    const err = await M.createNode(
      {}, { input: { memoryId: appMem.urn, loc: 'chats:team:messages:0009', name: 'm' } }, ctx(admin.id),
    ).catch((e: unknown) => e as { message: string; extensions: Record<string, unknown> });
    expect(err.extensions).toMatchObject({ code: 'LOC_PROTECTED', channelLive: true });
    expect(err.message).toContain('createTeamChatMessage');
    expect(err.message).not.toContain('DELETED');
  });

  it('a tombstoned Channel still reserves its ROOT and ancestors against mutating delete (#1226 P1)', async () => {
    // @codex P1 on PR #1257. `Channel.chatRoot` is `onDelete: Cascade`, so a
    // HARD delete of the tombstoned root physically removes the node, cascades
    // the Channel row away, and takes the reservation with it — after which a
    // generic writer can occupy the address. The carve-out releases the
    // orphaned SUBTREE; it must not release the root or the path to it.
    const ch = await Q.channels(null, { filter: { memoryRef: appMem.urn } }, ctx(admin.id));
    const target = ch.items.find((c: { loc: string }) => c.loc === 'chats:team')!;
    await M.createChannelMessage({}, { channelRef: target.id, body: 'x' }, ctx(admin.id));
    const rootId = (await db.node.findFirstOrThrow({
      where: { memoryId: appMem.id, loc: 'chats:team' }, select: { id: true },
    })).id;
    await M.deleteChannel({}, { ref: target.id }, ctx(admin.id));

    // A repeated default soft delete is an idempotent no-op (and matches MCP),
    // so it does not threaten the reservation. A HARD delete would mutate the
    // row and cascade the Channel away, and is still refused.
    await expect(M.deleteNode({}, { nodeRef: rootId }, ctx(admin.id))).resolves.toBe(true);
    await expect(
      M.deleteNode({}, { nodeRef: rootId, hard: true }, ctx(admin.id)),
    ).rejects.toMatchObject({ extensions: { code: 'LOC_PROTECTED' } });

    // And so does an ANCESTOR — deleting `chats` would take the root with it.
    const ancestorId = (await db.node.findFirstOrThrow({
      where: { memoryId: appMem.id, loc: 'chats' }, select: { id: true },
    })).id;
    await expect(
      M.deleteNode({}, { nodeRef: ancestorId, hard: true }, ctx(admin.id)),
    ).rejects.toMatchObject({ extensions: { code: 'LOC_PROTECTED' } });

    // The reservation survived, so the address cannot be occupied.
    await expect(
      M.createNode({}, { input: { memoryId: appMem.urn, loc: 'chats:team', name: 'squat' } }, ctx(admin.id)),
    ).rejects.toMatchObject({ extensions: { code: 'LOC_PROTECTED' } });
  });

  it('the lock helpers gate, and the Channel owner passes with ownedByOperation', async () => {
    await db.$transaction(async (tx) => {
      await expect(lockAncestorsForCreate(tx, appMem.id, 'chats:team:messages:0002')).rejects.toBeInstanceOf(LocProtectedError);
    });
    await db.$transaction(async (tx) => {
      await expect(lockLocForWrite(tx, appMem.id, 'chats:team')).rejects.toBeInstanceOf(LocProtectedError);
    });
    await db.$transaction(async (tx) => {
      await lockAncestorsForCreate(tx, appMem.id, 'chats:team:messages:0002', { owns: 'channel' });
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

  it('re-reads under the memory lock so a stale tombstone snapshot cannot overwrite a reused Channel (#1226)', async () => {
    const deletedAt = new Date(Date.now() - 60_000);
    const root = await db.node.create({
      data: {
        id: generateId(), memoryId: appMem.id, loc: 'chats:team', name: 'Team chat',
        nodeType: 'chat', data: { messageCount: 4 }, deletedAt,
      },
    });

    let signalHeld!: () => void;
    let signalRelease!: () => void;
    const held = new Promise<void>((resolve) => { signalHeld = resolve; });
    const release = new Promise<void>((resolve) => { signalRelease = resolve; });
    const holder = db.$transaction(async (tx) => {
      await lockMemoryForChannelChange(tx, appMem.id);
      signalHeld();
      await release;
      // This transaction stands in for the reuse that won the memory lock
      // immediately before the queued backfill: same stable root/Channel ids,
      // new live incarnation.
      await tx.node.update({ where: { id: root.id }, data: { deletedAt: null, deletedBy: null } });
      await tx.channel.create({
        data: {
          id: generateId(), memoryId: appMem.id, loc: root.loc, name: 'team',
          chatRootNodeId: root.id, lastSeq: 0, incarnation: 2, createdBy: admin.id,
        },
      });
    }, { timeout: 20_000 });

    await held;
    const running = backfillChannels(db, { apply: true });
    try {
      await waitForChannelMemoryLockWaiter(appMem.id);
      signalRelease();
      await holder;
      await running;
      const row = await db.channel.findUniqueOrThrow({ where: { chatRootNodeId: root.id } });
      expect(row.deletedAt).toBeNull();
      expect(row.lastSeq).toBe(0);
    } finally {
      signalRelease();
      await holder.catch(() => undefined);
      await running.catch(() => undefined);
    }
  }, 20_000);
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

  it('emits NO address for a COMPOUND legacy team-space host memory, whose flattened URN would not round-trip', async () => {
    // Copilot on PR #1172, measured: a LEGACY team space is stored as
    // `<app-urn>:<agent-slug>:shared` (still supported —
    // resolveAppTeamSpaceMemoryIds), so the flat v2 join emits
    // `hrn:node:<org>:<app>:<agent>:shared:chats:team`, which the resolver
    // splits as memory `<org>:<app>` + loc `<agent>:shared:chats:team` and
    // therefore REJECTS. Emitting it would hand a client an address this very
    // server refuses — the defect `findings:graphql-urn-canonical-on-read`
    // exists about, and the reason the round-trip test above needs a fixture
    // of each shape rather than the two-atom one only.
    const agent = await db.agent.findFirstOrThrow({ where: { organizationId: org.id } });
    const legacyMem = await db.memory.create({
      data: { id: generateId(), organizationId: org.id, urn: `${app.urn}:${agent.name}:shared`, name: 'legacy', class: 'app', appId: app.id },
    });
    const { channel } = await ensureChannelWithRoot(db, { memoryId: legacyMem.id, loc: 'chats:team', name: 'team', createdBy: admin.id });
    const ChannelType = (resolvers as any).Channel;
    expect(await ChannelType.chatRootUrn(channel, {}, ctx(admin.id))).toBeNull();
    // The flat form it WOULD have emitted is exactly the one that resolves to
    // nothing — asserted, so the null above is a measurement and not a guess.
    expect(await Q.channel({}, { ref: `hrn:node:${legacyMem.urn}:chats:team` }, ctx(admin.id))).toBeNull();
    // The Channel itself is perfectly addressable by id.
    expect((await Q.channel({}, { ref: channel.id }, ctx(admin.id)))?.id).toBe(channel.id);
    // The LIST path eager-loads the host memory's urn (#1172, Copilot: a
    // per-row lookup on a 200-row page is a straight N+1, and this repo
    // eager-loads rather than reaching for a DataLoader). Assert the field
    // agrees on BOTH paths, since only one of them hydrates it.
    const page = await Q.channels({}, { filter: { memoryRef: legacyMem.urn } }, ctx(admin.id));
    expect(page.total).toBe(1);
    expect(await ChannelType.chatRootUrn(page.items[0], {}, ctx(admin.id))).toBeNull();
    const flat = await Q.channels({}, { filter: { memoryRef: appMem.urn } }, ctx(admin.id));
    for (const item of flat.items) {
      expect(await ChannelType.chatRootUrn(item, {}, ctx(admin.id))).toBe(`hrn:node:${appMem.urn}:${item.loc}`);
    }
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
