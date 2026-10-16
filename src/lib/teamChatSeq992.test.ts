/** #992: the durable team-chat seq key, through the canonical storage writer. */
import { beforeEach, describe, expect, it } from 'vitest';
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
