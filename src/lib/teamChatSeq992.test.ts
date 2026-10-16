/** #992: the durable team-chat seq key, through the canonical storage writer. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import { appendChatMessage } from './chatRoot.js';
import { ensureChannelWithRoot } from './channels.js';

let memory: { id: string };
let channel: { id: string; chatRootNodeId: string; loc: string };
let orgId: string;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'seq992', urn: `seq992-${generateId()}` } });
  orgId = org.id;
  const app = await db.app.create({ data: { organizationId: org.id, name: 'team', urn: `${org.urn}:team` } });
  memory = await db.memory.create({ data: { organizationId: org.id, appId: app.id, class: 'app', name: 'team', urn: `${org.urn}:team-space` } });
  channel = (await ensureChannelWithRoot(db, {
    memoryId: memory.id, loc: 'chats:team', name: 'team', createdBy: null, asDefaultOfAppId: app.id,
  })).channel;
});

function store(seq: number | null, suffix = generateId(), extra: object = {}) {
  // The SAME Node insert as postToRoot's append callback; the caller cannot
  // choose a seq on the public post, so use its storage seam to pin the key.
  return db.node.create({ data: {
    memoryId: memory.id, loc: `${channel.loc}:messages:${suffix}`, name: suffix,
    nodeType: 'chat-message', seq, content: 'body', data: { mentions: [] },
    ...extra,
  } });
}

function append(suffix: string) {
  return appendChatMessage(db, { id: channel.chatRootNodeId, memoryId: memory.id, loc: channel.loc },
    { id: memory.id, isEncrypted: false }, async ({ tx, seq, msgNum }) => tx.node.create({ data: {
      memoryId: memory.id, loc: `${channel.loc}:messages:${msgNum}-${suffix}`, name: suffix,
      nodeType: 'chat-message', seq, messageChannelId: channel.id, content: suffix, data: { mentions: [] },
    } }), { asChannel: true });
}

async function state() {
  return {
    root: await db.node.findUniqueOrThrow({ where: { id: channel.chatRootNodeId } }),
    channel: await db.channel.findUniqueOrThrow({ where: { id: channel.id } }),
    nodes: await db.node.count({ where: { memoryId: memory.id } }),
    edges: await db.edge.count({ where: { memoryId: memory.id } }),
  };
}

describe('#992 team-chat seq uniqueness', () => {
  it.each([false, true])('refuses duplicate even when original tombstoned=%s, without changing the record', async (deleted) => {
    await store(7, 'first', { deletedAt: deleted ? new Date() : null });
    const before = await state();
    await expect(store(7, 'second')).rejects.toMatchObject({ extensions: { code: 'TEAM_CHAT_SEQ_CONFLICT' } });
    expect(await state()).toEqual(before);
  });

  it('allows only one winner in a concurrent duplicate race', async () => {
    const results = await Promise.allSettled([store(8, 'race-a'), store(8, 'race-b')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const loser = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(loser.reason).toMatchObject({ extensions: { code: 'TEAM_CHAT_SEQ_CONFLICT' } });
  });

  it('rolls back the whole append when its canonical insert conflicts', async () => {
    const original = await store(4, 'first');
    const before = await state();
    await expect(appendChatMessage(db,
      { id: channel.chatRootNodeId, memoryId: memory.id, loc: channel.loc },
      { id: memory.id, isEncrypted: false }, async ({ tx }) => {
        // A reply/envelope side effect staged before the insert must roll back
        // too. This deliberately broken storage callback bypasses allocation,
        // which is exactly why the independent DB key is needed.
        await tx.node.update({ where: { id: original.id }, data: { data: { mentions: ['wrong'] } } });
        return tx.node.create({ data: {
          memoryId: memory.id, loc: `${channel.loc}:messages:bad-append`, name: 'bad',
          nodeType: 'chat-message', seq: 4, content: 'duplicate', messageChannelId: channel.id,
        } });
      }, { asChannel: true })).rejects.toMatchObject({ extensions: { code: 'TEAM_CHAT_SEQ_CONFLICT' } });
    expect(await state()).toEqual(before);
    expect((await db.node.findUniqueOrThrow({ where: { id: original.id } })).data).toEqual({ mentions: [] });
  });

  it('refuses an update into an occupied seq and permits revival of the original identity', async () => {
    const first = await store(10, 'first', { deletedAt: new Date() });
    const second = await store(11, 'second');
    await expect(db.node.update({ where: { id: second.id }, data: { seq: 10 } }))
      .rejects.toMatchObject({ extensions: { code: 'TEAM_CHAT_SEQ_CONFLICT' } });
    await expect(db.node.update({ where: { id: first.id }, data: { deletedAt: null } })).resolves.toMatchObject({ seq: 10 });
    expect((await db.node.findUniqueOrThrow({ where: { id: second.id } })).seq).toBe(11);
  });

  it('rejects a duplicate on the real pre-Channel clone/import path', async () => {
    // Historical imports could write before the Channel reserved the root.
    // Removing only the synthetic fixture's Channel recreates that window.
    await db.channel.delete({ where: { id: channel.id } });
    const user = await db.user.create({ data: { githubId: 992, githubUsername: 'seq992-importer' } });
    await db.orgMember.create({ data: { organizationId: orgId, userId: user.id, role: 'ADMIN' } });
    const source = await db.memory.create({ data: { organizationId: orgId, class: 'knowledge', name: 'archive', urn: `seq992:archive-${generateId()}` } });
    const message = await db.node.create({ data: { memoryId: source.id, loc: 'archive:message', name: 'archive', nodeType: 'chat-message', seq: 6, content: 'archive' } });
    const targetMemory = await db.memory.findUniqueOrThrow({ where: { id: memory.id } });
    const ctx: Context = { db, userId: user.id, roles: ['READER'] };
    const M = resolvers.Mutation as any;
    await M.cloneNode({}, { sourceRef: message.id, targetUrn: `hrn:node:${targetMemory.urn}:chats:team:messages:original` }, ctx);
    await expect(M.cloneNode({}, { sourceRef: message.id, targetUrn: `hrn:node:${targetMemory.urn}:chats:team:messages:duplicate` }, ctx))
      .rejects.toMatchObject({ extensions: { code: 'TEAM_CHAT_SEQ_CONFLICT' } });
    expect(await db.node.count({ where: { memoryId: memory.id, nodeType: 'chat-message', seq: 6 } })).toBe(1);
  });

  it('permits equal seq in different team chats', async () => {
    await store(3);
    const otherApp = await db.app.create({ data: { organizationId: orgId, name: 'other', urn: `seq992:other-${generateId()}` } });
    const otherMem = await db.memory.create({ data: { organizationId: orgId, appId: otherApp.id, class: 'app', name: 'other', urn: `seq992:mem-${generateId()}` } });
    const other = await ensureChannelWithRoot(db, { memoryId: otherMem.id, loc: 'chats:team', name: 'team', createdBy: null });
    await expect(db.node.create({ data: { memoryId: otherMem.id, loc: `${other.channel.loc}:messages:same`, name: 'same', nodeType: 'chat-message', seq: 3 } })).resolves.toMatchObject({ seq: 3 });
  });

  it('keeps counterless, summary, foreign and ordinary transcript collisions legal', async () => {
    await store(2, 'numbered');
    await store(null, 'counterless-a');
    await store(null, 'counterless-b');
    await store(2, 'summary', { nodeType: 'abstract' });
    await store(2, 'foreign', { nodeType: 'info' });
    await store(2, 'record', { nodeType: 'record' });
    await store(2, 'ordinary-a', { loc: 'chats:ordinary:messages:a', nodeType: 'record' });
    await store(2, 'ordinary-b', { loc: 'chats:ordinary:messages:b', nodeType: 'record' });
  });

  it('preserves concurrent monotone append and excludes summaries from the maximum', async () => {
    await store(30, 'imported-tombstone', { deletedAt: new Date() });
    await store(999, 'summary', { nodeType: 'abstract' });
    const out = await Promise.all([append('a'), append('b'), append('c')]);
    expect(out.map((r) => r.seq).sort((a, b) => a - b)).toEqual([31, 32, 33]);
    expect((await state()).root.data).toMatchObject({ messageCount: 33 });
  });
});
