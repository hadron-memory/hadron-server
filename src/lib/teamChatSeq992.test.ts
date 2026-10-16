/** #992: the durable team-chat seq key, through the canonical storage writer. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { ApolloServer } from '@apollo/server';
import { typeDefs } from '../api/graphql/schema/typeDefs.js';
import { teamChatSeqCandidatesSql, teamChatSeqPreflightSql } from './teamChatSeqPreflight.js';
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
    const gql = new ApolloServer<Context>({ typeDefs, resolvers });
    try {
      const result = await gql.executeOperation({
        query: 'mutation($source: ID!, $target: String!) { cloneNode(sourceRef: $source, targetUrn: $target) { id } }',
        variables: { source: message.id, target: `hrn:node:${targetMemory.urn}:chats:team:messages:wire-duplicate` },
      }, { contextValue: ctx });
      expect(result.body.kind).toBe('single');
      if (result.body.kind === 'single') {
        expect(result.body.singleResult.errors?.[0].extensions.code).toBe('TEAM_CHAT_SEQ_CONFLICT');
        expect(JSON.stringify(result.body.singleResult)).not.toMatch(/P0992|ConnectorError|PostgresError|Prisma|SELECT|INSERT/);
      }
    } finally { await gql.stop(); }

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


describe('#992 canonical classification transitions', () => {
  it('does not trust projection, envelope or a named Channel, and retains a tombstoned root', async () => {
    await store(15, 'first', { messageChannelId: null, data: { __enc: 'ciphertext' } });
    await db.node.update({ where: { id: channel.chatRootNodeId }, data: { deletedAt: new Date() } });
    await expect(store(15, 'second', { messageChannelId: null })).rejects.toMatchObject({ extensions: { code: 'TEAM_CHAT_SEQ_CONFLICT' } });
    await store(15, 'named-a', { loc: 'channels:other:messages:a', messageChannelId: channel.id });
    await store(15, 'named-b', { loc: 'channels:other:messages:b', messageChannelId: channel.id });
  });

  it('leaves an actual named Channel outside the team-only key', async () => {
    const named = await ensureChannelWithRoot(db, { memoryId: memory.id, loc: 'chats:legacy', name: 'legacy', createdBy: null });
    for (const suffix of ['a', 'b']) await store(19, suffix, {
      loc: `chats:legacy:messages:${suffix}`, messageChannelId: named.channel.id,
    });
    expect(await db.teamChatSequenceKey.count({ where: { rootId: named.rootId } })).toBe(0);
    expect(await db.$queryRawUnsafe(teamChatSeqPreflightSql)).toEqual([]);
  });

  it.each(['worker', 'session', 'other-owner'] as const)('does not constrain a %s app-class memory merely called chats:team', async (kind) => {
    const mem = await db.memory.findUniqueOrThrow({ where: { id: memory.id } });
    const agent = await db.agent.create({ data: { organizationId: orgId, name: 'agent', urn: `seq992:agent-${generateId()}` } });
    if (kind === 'worker') {
      await db.worker.create({ data: { appId: mem.appId!, agentId: agent.id, name: 'Worker', slug: 'worker', memoryId: memory.id } });
    } else if (kind === 'session') {
      await db.memory.update({ where: { id: memory.id }, data: { userMemoryOfAgentId: agent.id } });
    } else {
      const owner = await db.user.create({ data: { handle: 'other-owner' } });
      await db.memory.update({ where: { id: memory.id }, data: { organizationId: null, ownerUserId: owner.id } });
    }
    await store(20, 'excluded-a');
    await store(20, 'excluded-b');
    expect(await db.teamChatSequenceKey.count()).toBe(0);
    // Restore a collision-free fixture before cleanDb deletes Worker links.
    await db.node.deleteMany({ where: { memoryId: memory.id, nodeType: 'chat-message' } });
  });

  it('refuses a move or kind change into an occupied canonical key', async () => {
    await store(6, 'first');
    const ordinary = await store(6, 'ordinary', { loc: 'chats:ordinary:messages:x' });
    await expect(db.node.update({ where: { id: ordinary.id }, data: { loc: 'chats:team:messages:moved' } }))
      .rejects.toMatchObject({ extensions: { code: 'TEAM_CHAT_SEQ_CONFLICT' } });
    const summary = await store(6, 'summary', { nodeType: 'abstract' });
    await expect(db.node.update({ where: { id: summary.id }, data: { nodeType: 'chat-message' } }))
      .rejects.toMatchObject({ extensions: { code: 'TEAM_CHAT_SEQ_CONFLICT' } });
  });

  it('refuses adopting collisions when a memory becomes team space', async () => {
    await db.memory.update({ where: { id: memory.id }, data: { class: 'knowledge' } });
    await store(4, 'legacy-a');
    await store(4, 'legacy-b');
    await expect(db.memory.update({ where: { id: memory.id }, data: { class: 'app' } }))
      .rejects.toMatchObject({ extensions: { code: 'TEAM_CHAT_SEQ_CONFLICT' } });
    expect((await db.memory.findUniqueOrThrow({ where: { id: memory.id } })).class).toBe('knowledge');
  });

  it('refuses adopting collisions when a root becomes a chat', async () => {
    await db.node.update({ where: { id: channel.chatRootNodeId }, data: { nodeType: 'info' } });
    await store(4, 'legacy-a');
    await store(4, 'legacy-b');
    await expect(db.node.update({ where: { id: channel.chatRootNodeId }, data: { nodeType: 'chat' } }))
      .rejects.toMatchObject({ extensions: { code: 'TEAM_CHAT_SEQ_CONFLICT' } });
  });

  it('aborts a stale repeatable-read classifier after a membership transition', async () => {
    await db.memory.update({ where: { id: memory.id }, data: { class: 'knowledge' } });
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await client.query('SELECT id FROM memories WHERE id = $1', [memory.id]);
      await db.memory.update({ where: { id: memory.id }, data: { class: 'app' } });
      await expect(client.query(`INSERT INTO nodes(id,memory_id,loc,name,node_type,seq) VALUES($1,$2,'chats:team:messages:stale','stale','chat-message',1)`, [generateId(), memory.id]))
        .rejects.toMatchObject({ code: '40001' });
    } finally { await client.query('ROLLBACK'); await client.end(); }
  });
});

describe('#992 migration and read-only collision preflight', () => {
  it('ships exactly one classifier and one invariant source', () => {
    const sql = readFileSync('prisma/team-chat-seq-invariants.sql', 'utf8');
    expect(sql.split('-- BEGIN CANONICAL CLASSIFIER\n')[1].split(';\n-- END CANONICAL CLASSIFIER')[0])
      .toBe(teamChatSeqCandidatesSql.trimEnd());
    expect(readFileSync('prisma/migrations/20261016110000_team_chat_seq_uniqueness/migration.sql', 'utf8')).toBe(sql);
  });

  it('reports live/tombstone ids, refuses atomically, then installs after synthetic selected repair', async () => {
    const first = await store(3, '003-academy-iris', { deletedAt: new Date() });
    const citation = await db.node.create({ data: { memoryId: memory.id, loc: 'citations:original', name: 'kept', content: 'references archived seq 3' } });
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const sql = readFileSync('prisma/team-chat-seq-invariants.sql', 'utf8');
    try {
      // Recreate the historical unconstrained import, only in this worker's
      // disposable DB. Nothing here is an operator/production repair path.
      await client.query('ALTER TABLE nodes DISABLE TRIGGER team_chat_seq_node_before');
      await client.query('ALTER TABLE nodes DISABLE TRIGGER team_chat_seq_node_after');
      const duplicate = await store(3, 'postmigration-duplicate');
      const before = await db.node.findMany({ where: { memoryId: memory.id }, orderBy: { id: 'asc' } });
      await client.query('BEGIN READ ONLY');
      const report = await client.query(teamChatSeqPreflightSql);
      await client.query('COMMIT');
      expect(report.rows).toHaveLength(1);
      expect(report.rows[0]).toMatchObject({ root_id: channel.chatRootNodeId, seq: 3 });
      expect(report.rows[0].messages.map((m: { id: string }) => m.id).sort()).toEqual([first.id, duplicate.id].sort());
      await expect(client.query(sql)).rejects.toMatchObject({ code: 'P0993' });
      await client.query('ROLLBACK');
      expect(await db.node.findMany({ where: { memoryId: memory.id }, orderBy: { id: 'asc' } })).toEqual(before);
      // Apply the owner's selected disposition ONLY to synthetic fixtures:
      // hard-delete the offending post, keep the archive and citation identity.
      await db.node.delete({ where: { id: duplicate.id } });
      expect((await client.query(teamChatSeqPreflightSql)).rows).toEqual([]);
      await client.query(sql);
      expect((await db.node.findUniqueOrThrow({ where: { id: first.id } })).loc).toBe('chats:team:messages:003-academy-iris');
      expect((await db.node.findUniqueOrThrow({ where: { id: citation.id } })).content).toBe('references archived seq 3');
      await expect(store(3, 'retry')).rejects.toMatchObject({ extensions: { code: 'TEAM_CHAT_SEQ_CONFLICT' } });
    } finally {
      await client.query('ROLLBACK');
      await client.query('ALTER TABLE nodes ENABLE TRIGGER team_chat_seq_node_before');
      await client.query('ALTER TABLE nodes ENABLE TRIGGER team_chat_seq_node_after');
      await client.end();
    }
  });
});
