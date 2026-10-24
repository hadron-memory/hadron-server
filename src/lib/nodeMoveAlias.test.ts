import { withIncludeHistoryClientTransaction } from './includes/includeHistoryFence.js';
/** #1391: a move preserves each published node address through the alias map. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import { resolveNodeRef } from './entityRef/nodeRef.js';
import { moveNodeSubtree } from './nodeSubtreeMove.js';
import { recordUrnRename } from './urnAlias.js';
import { AmbiguousLegacyUrnError, NodeNotFoundError } from './entityRef/errors.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from '../mcp/server.js';
import type { AuthContext } from '../middleware/auth.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/mirrorNodeMove.js', () => ({
  mirrorNodeMoveToGit: vi.fn().mockResolvedValue(undefined),
}));

let mover: { id: string };
let reader: { id: string };
let source: { id: string; urn: string };
let target: { id: string; urn: string };

const nodeUrn = (memory: { urn: string }, loc: string) => `hrn:node:${memory.urn}:${loc}`;
const graphCtx = (userId = mover.id): Context => ({ db, userId, roles: userId === mover.id ? ['ADMIN'] : [] });
const mcpAuth = (userId = mover.id): AuthContext => ({
  userId, roles: userId === mover.id ? ['ADMIN'] : [], clientId: `user:${userId}`,
});
// #1591: aliases record a node's PUBLISHED address, which only a minted node
// has. In production every pre-#1591 node was backfilled as minted; these
// fixtures are minted the same way. Unminted moves: specCorpus.test.ts.
const createNode = (memoryId: string, loc: string) => db.node.create({
  data: {
    id: generateId(), memoryId, loc, name: loc, content: `body of ${loc}`,
    mintedAt: new Date(), mintedByInfo: 'test',
  },
});
const aliasesFor = (id: string) => db.urnAlias.findMany({
  where: { entityType: 'NODE', entityId: id }, orderBy: { urn: 'asc' },
});

beforeEach(async () => {
  await cleanDb(db);
  const orgA = await db.organization.create({
    data: { id: generateId(), name: 'Alias A', urn: 'alias-a.example' },
  });
  const orgB = await db.organization.create({
    data: { id: generateId(), name: 'Alias B', urn: 'alias-b.example' },
  });
  mover = await db.user.create({ data: { githubId: 139101, githubUsername: 'alias-mover', roles: ['ADMIN'] } });
  reader = await db.user.create({ data: { githubId: 139102, githubUsername: 'alias-reader', roles: [] } });
  await db.orgMember.createMany({ data: [
    { organizationId: orgA.id, userId: mover.id, role: 'ADMIN' },
    { organizationId: orgB.id, userId: mover.id, role: 'ADMIN' },
    { organizationId: orgA.id, userId: reader.id, role: 'READER' },
  ] });
  source = await db.memory.create({ data: {
    id: generateId(), organizationId: orgA.id, urn: `${orgA.urn}:source`,
    name: 'source', class: 'knowledge', visibility: 'ORGANIZATION',
  } });
  target = await db.memory.create({ data: {
    id: generateId(), organizationId: orgB.id, urn: `${orgB.urn}:target`,
    name: 'target', class: 'knowledge', visibility: 'ORGANIZATION',
  } });
});

describe('node move URN aliases', () => {
  it('records the root and every descendant on a same-memory move; a live occupant wins', async () => {
    const root = await createNode(source.id, 'old');
    const child = await createNode(source.id, 'old:child');
    const oldRoot = nodeUrn(source, 'old');
    const oldChild = nodeUrn(source, 'old:child');

    await resolvers.Mutation.moveNode(null, { sourceRef: root.id, targetUrn: nodeUrn(source, 'new') }, graphCtx());
    expect((await aliasesFor(root.id)).map((a) => a.urn)).toEqual([`${source.urn}:old`]);
    expect((await aliasesFor(child.id)).map((a) => a.urn)).toEqual([`${source.urn}:old:child`]);
    expect(await resolveNodeRef(db, oldRoot)).toEqual({ id: root.id });
    expect(await resolveNodeRef(db, oldChild)).toEqual({ id: child.id });
    expect(await resolveNodeRef(db, 'old', source.id)).toEqual({ id: root.id });
    expect((await resolvers.Query.node(null, { ref: oldChild }, graphCtx()))?.id).toBe(child.id);
    expect(await resolvers.Query.resolveUrn(null, { urn: oldChild }, graphCtx()))
      .toMatchObject({ kind: 'node', id: child.id, memoryId: source.id });

    const occupant = await createNode(source.id, 'old');
    expect(await resolveNodeRef(db, oldRoot)).toEqual({ id: occupant.id });
    expect(await resolveNodeRef(db, 'old', source.id)).toEqual({ id: occupant.id });
    expect((await resolvers.Query.node(null, { ref: oldRoot }, graphCtx()))?.id).toBe(occupant.id);
  });

  it('routes authorized update and delete refs through the moved address', async () => {
    const node = await createNode(source.id, 'old');
    const old = nodeUrn(source, 'old');
    await resolvers.Mutation.moveNode(null, {
      sourceRef: node.id, targetUrn: nodeUrn(source, 'new'),
    }, graphCtx());
    await resolvers.Mutation.updateNode(null, {
      input: { id: old, content: 'updated through old address' },
    }, graphCtx());
    expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).content)
      .toBe('updated through old address');
    await resolvers.Mutation.deleteNode(null, { nodeRef: old }, graphCtx());
    expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).deletedAt)
      .not.toBeNull();
  });

  it('keeps a short loc scoped to its memory after that memory is renamed', async () => {
    const root = await createNode(source.id, 'old');
    await resolvers.Mutation.moveNode(null, {
      sourceRef: root.id, targetUrn: nodeUrn(source, 'new'),
    }, graphCtx());
    await db.$transaction(async (tx) => {
      await recordUrnRename(tx, {
        entityType: 'MEMORY', entityId: source.id,
        oldUrn: source.urn, newUrn: 'alias-a.example:renamed',
      });
      await tx.memory.update({
        where: { id: source.id }, data: { urn: 'alias-a.example:renamed' },
      });
    });

    expect(await resolveNodeRef(db, 'old', source.id)).toEqual({ id: root.id });
  });

  it('returns null for a missing loc scoped to a readable memory', async () => {
    const caller = graphCtx(reader.id);
    for (const ref of ['missing', 'aa:bb:cc']) {
      expect(await resolvers.Query.node(null, { ref, memoryRef: source.id }, caller))
        .toBeNull();
    }
  });

  it('keeps the address published before a memory rename alive after a later node move', async () => {
    const root = await createNode(source.id, 'old');
    const publishedBeforeMemoryRename = nodeUrn(source, 'old');
    const oldMemoryUrn = source.urn;
    const newMemoryUrn = 'alias-a.example:renamed';
    await db.$transaction(async (tx) => {
      await recordUrnRename(tx, {
        entityType: 'MEMORY', entityId: source.id,
        oldUrn: oldMemoryUrn, newUrn: newMemoryUrn,
      });
      await tx.memory.update({ where: { id: source.id }, data: { urn: newMemoryUrn } });
    });

    await resolvers.Mutation.moveNode(null, {
      sourceRef: root.id, targetUrn: `hrn:node:${newMemoryUrn}:new`,
    }, graphCtx());
    expect(await resolveNodeRef(db, publishedBeforeMemoryRename)).toEqual({ id: root.id });
    expect((await resolvers.Query.node(null, { ref: publishedBeforeMemoryRename }, graphCtx()))?.id)
      .toBe(root.id);
    const mcp = createTestableMcpServer(mcpAuth());
    expect(await mcp.callToolText('hadron_get_node', {
      urn: publishedBeforeMemoryRename,
    })).toContain('body of old');
    expect(await mcp.callToolText('hadron_get_nodes', {
      refs: [publishedBeforeMemoryRename],
    })).toContain('body of old');

    // Another live memory may later claim the freed old memory URN. It is not
    // a live NODE address until it has this loc, so the historical memory's
    // alias must still lead to the moved node. Once the slot is occupied, the
    // live node wins the full published address.
    const replacement = await db.memory.create({ data: {
      id: generateId(), organizationId: (await db.memory.findUniqueOrThrow({ where: { id: source.id } })).organizationId,
      urn: oldMemoryUrn, name: 'replacement', class: 'knowledge', visibility: 'ORGANIZATION',
    } });
    expect(await resolveNodeRef(db, publishedBeforeMemoryRename)).toEqual({ id: root.id });
    expect((await resolvers.Query.node(null, { ref: publishedBeforeMemoryRename }, graphCtx()))?.id)
      .toBe(root.id);
    expect(await mcp.callToolText('hadron_get_node', { urn: publishedBeforeMemoryRename }))
      .toContain('body of old');
    const occupant = await createNode(replacement.id, 'old');
    expect(await resolveNodeRef(db, publishedBeforeMemoryRename)).toEqual({ id: occupant.id });
  });

  it('reads a moved legacy literal #data loc through MCP single and batch fallbacks', async () => {
    const literal = await createNode(source.id, 'legacy#data');
    const published = nodeUrn(source, 'legacy#data');
    await resolvers.Mutation.moveNode(null, {
      sourceRef: literal.id, targetUrn: nodeUrn(source, 'new'),
    }, graphCtx());
    const mcp = createTestableMcpServer(mcpAuth());
    const single = await mcp.callToolText('hadron_get_node', { urn: published });
    const batch = await mcp.callToolText('hadron_get_nodes', { refs: [published] });
    expect(single).toContain('body of legacy#data');
    expect(batch).toContain('body of legacy#data');
    expect(single).not.toContain('Fragment: data');
    expect(batch).not.toContain('Fragment: data');
  });

  it('serializes a move with a concurrent memory rename before recording the source key', async () => {
    const root = await createNode(source.id, 'old');
    const oldMemoryUrn = source.urn;
    const newMemoryUrn = 'alias-a.example:renamed';
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
    let releaseRename!: () => void;
    const holdRename = new Promise<void>((resolve) => { releaseRename = resolve; });
    const rename = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM memories WHERE id = ${source.id} FOR UPDATE`;
      await recordUrnRename(tx, {
        entityType: 'MEMORY', entityId: source.id,
        oldUrn: oldMemoryUrn, newUrn: newMemoryUrn,
      });
      await tx.memory.update({ where: { id: source.id }, data: { urn: newMemoryUrn } });
      signalLocked();
      await holdRename;
    });
    await locked;

    const moving = resolvers.Mutation.moveNode(null, {
      sourceRef: root.id, targetUrn: `hrn:node:${oldMemoryUrn}:new`,
    }, graphCtx());
    try {
      // The encryption-flip fence now waits on the rename row lock before
      // reconciliation or the later source-URN read. It also pins the URN
      // through that read, so the alias uses the post-rename address.
      await vi.waitFor(async () => {
        const waiting = await db.$queryRaw<Array<{ pid: number }>>`
          SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND query LIKE '%FROM memories WHERE id%'
            AND query LIKE '%FOR NO KEY UPDATE%'
        `;
        expect(waiting.length).toBeGreaterThan(0);
      }, { timeout: 5_000, interval: 25 });
    } finally {
      releaseRename();
    }
    await rename;
    await moving;
    expect(await resolveNodeRef(db, `hrn:node:${newMemoryUrn}:old`)).toEqual({ id: root.id });
    expect(await resolveNodeRef(db, `hrn:node:${oldMemoryUrn}:old`)).toEqual({ id: root.id });
  });

  it('records cross-memory aliases and applies the target memory gate on GraphQL and MCP reads', async () => {
    const root = await createNode(source.id, 'old');
    const child = await createNode(source.id, 'old:child');
    const oldRoot = nodeUrn(source, 'old');
    const oldChild = nodeUrn(source, 'old:child');
    const mcp = createTestableMcpServer(mcpAuth());

    const moved = await mcp.callToolText('hadron_move_node', {
      urn: oldRoot, targetUrn: nodeUrn(target, 'new'),
    });
    expect(moved).toContain('new');
    expect((await aliasesFor(root.id)).map((a) => a.urn)).toEqual([`${source.urn}:old`]);
    expect((await aliasesFor(child.id)).map((a) => a.urn)).toEqual([`${source.urn}:old:child`]);
    expect(await resolveNodeRef(db, oldChild)).toEqual({ id: child.id });
    await expect(resolveNodeRef(db, 'old:child', source.id)).rejects.toThrow(NodeNotFoundError);
    expect((await resolvers.Query.node(null, { ref: oldChild }, graphCtx()))?.id).toBe(child.id);
    expect(await mcp.callToolText('hadron_get_node', { urn: oldChild })).toContain('body of old:child');
    expect(await mcp.callToolText('hadron_get_nodes', { refs: [oldRoot, oldChild] }))
      .toContain('body of old:child');
    await vi.waitFor(async () => {
      const reads = await db.usageEvent.findMany({ where: { nodeId: child.id, type: 'read' } });
      expect(reads.length).toBeGreaterThanOrEqual(2);
      expect(reads.every((event) => event.nodeLoc === 'new:child' && event.memoryId === target.id))
        .toBe(true);
    });

    const readerMcp = createTestableMcpServer(mcpAuth(reader.id));
    expect(await resolvers.Query.node(null, { ref: oldChild }, graphCtx(reader.id))).toBeNull();
    expect(await resolvers.Query.resolveUrn(null, { urn: oldChild }, graphCtx(reader.id))).toBeNull();
    const absent = nodeUrn(source, 'never-existed');
    const deniedSingle = await readerMcp.callToolText('hadron_get_node', { urn: oldChild });
    const absentSingle = await readerMcp.callToolText('hadron_get_node', { urn: absent });
    expect(deniedSingle.replace(oldChild, '<ref>')).toBe(absentSingle.replace(absent, '<ref>'));
    expect(await readerMcp.callToolText('hadron_get_nodes', { refs: [oldChild] }))
      .toContain('Unavailable');
  });

  it('can read a moved target without access to its old memory, but an unreadable live occupant still wins', async () => {
    const root = await createNode(target.id, 'old');
    const old = nodeUrn(target, 'old');
    await resolvers.Mutation.moveNode(null, {
      sourceRef: root.id, targetUrn: nodeUrn(source, 'new'),
    }, graphCtx());

    const readerMcp = createTestableMcpServer(mcpAuth(reader.id));
    expect((await resolvers.Query.node(null, { ref: old }, graphCtx(reader.id)))?.id).toBe(root.id);
    expect(await readerMcp.callToolText('hadron_get_node', { urn: old })).toContain('body of old');
    expect(await readerMcp.callToolText('hadron_get_nodes', { refs: [old] })).toContain('body of old');

    await createNode(target.id, 'old');
    expect(await resolvers.Query.node(null, { ref: old }, graphCtx(reader.id))).toBeNull();
    expect(await readerMcp.callToolText('hadron_get_node', { urn: old }))
      .toContain('Memory not found');
  });

  it('conceals ambiguous moved addresses from outsiders and isolates batch refs', async () => {
    const old = nodeUrn(source, 'draft');
    const first = await createNode(source.id, 'draft');
    await resolvers.Mutation.moveNode(null, {
      sourceRef: first.id, targetUrn: nodeUrn(target, 'archive:one'),
    }, graphCtx());
    const second = await createNode(source.id, 'draft');
    await resolvers.Mutation.moveNode(null, {
      sourceRef: second.id, targetUrn: nodeUrn(target, 'archive:two'),
    }, graphCtx());
    const safe = await createNode(source.id, 'safe');
    const absent = nodeUrn(source, 'absent');

    await expect(resolveNodeRef(db, old)).rejects.toMatchObject({
      candidateNodeIds: expect.arrayContaining([first.id, second.id]),
    });
    await expect(resolveNodeRef(db, old)).rejects.toBeInstanceOf(AmbiguousLegacyUrnError);
    await expect(resolvers.Query.node(null, { ref: old }, graphCtx())).rejects
      .toBeInstanceOf(AmbiguousLegacyUrnError);
    await expect(resolvers.Query.resolveUrn(null, { urn: old }, graphCtx())).rejects
      .toBeInstanceOf(AmbiguousLegacyUrnError);

    const outsider = graphCtx(reader.id);
    expect(await resolvers.Query.node(null, { ref: old }, outsider)).toBeNull();
    expect(await resolvers.Query.resolveUrn(null, { urn: old }, outsider)).toBeNull();
    expect(await resolvers.Query.node(null, { ref: absent }, outsider)).toBeNull();
    expect(await resolvers.Query.channel(null, { ref: old }, outsider)).toBeNull();
    for (const ref of [old, absent]) {
      await expect(resolvers.Mutation.updateNode(null, {
        input: { id: ref, content: 'probe' },
      }, outsider)).rejects.toMatchObject({ extensions: { code: 'NODE_NOT_FOUND' } });
      await expect(resolvers.Mutation.deleteNode(null, { nodeRef: ref }, outsider))
        .rejects.toMatchObject({ extensions: { code: 'NODE_NOT_FOUND' } });
      await expect(resolvers.Mutation.moveNode(null, {
        sourceRef: ref, targetUrn: nodeUrn(source, 'probe'),
      }, outsider)).rejects.toMatchObject({ extensions: { code: 'NODE_NOT_FOUND' } });
    }

    const outsiderMcp = createTestableMcpServer(mcpAuth(reader.id));
    const denied = await outsiderMcp.callToolText('hadron_get_node', { urn: old });
    const missing = await outsiderMcp.callToolText('hadron_get_node', { urn: absent });
    expect(denied.replace(old, '<ref>')).toBe(missing.replace(absent, '<ref>'));
    expect(await outsiderMcp.callToolText('hadron_channel_read', { channel: old }))
      .toContain('channel_not_found');
    for (const auth of [mcpAuth(), mcpAuth(reader.id)]) {
      const batch = await createTestableMcpServer(auth).callToolText('hadron_get_nodes', {
        refs: [old, nodeUrn(source, 'safe')],
      });
      expect(batch).toContain('body of safe');
      expect(batch).toContain('Unavailable');
      expect(batch).toContain(old);
    }
    const graphBatch = await resolvers.Query.nodeBatch(null, {
      refs: [old, safe.id],
    }, outsider);
    expect(graphBatch.nodes).toEqual([expect.objectContaining({ id: safe.id })]);
    expect(graphBatch.unavailable).toContain(old);
  });

  it('refuses a globally ambiguous alias with one readable claimant without identifying the hidden one', async () => {
    const old = nodeUrn(source, 'shared-old');
    const visible = await createNode(source.id, 'visible');
    const hidden = await createNode(target.id, 'hidden');
    await db.urnAlias.createMany({ data: [visible.id, hidden.id].map((entityId) => ({
      urn: `${source.urn}:shared-old`, entityType: 'NODE' as const, entityId,
      reason: 'RENAME' as const, replacedByUrn: `${source.urn}:visible`,
    })) });

    const caller = graphCtx(reader.id);
    await expect(resolvers.Query.node(null, { ref: old }, caller))
      .rejects.toBeInstanceOf(AmbiguousLegacyUrnError);
    await expect(resolvers.Query.resolveUrn(null, { urn: old }, caller))
      .rejects.toBeInstanceOf(AmbiguousLegacyUrnError);
    await expect(resolvers.Mutation.deleteNode(null, { nodeRef: old }, caller))
      .rejects.toBeInstanceOf(AmbiguousLegacyUrnError);

    const outward = await createTestableMcpServer(mcpAuth(reader.id))
      .callToolText('hadron_get_node', { urn: old })
      .catch((error: unknown) => String(error));
    expect(outward).toContain('AMBIGUOUS_LEGACY_URN');
    expect(outward).not.toContain(hidden.id);
    expect(outward).not.toContain(target.urn);
    expect(outward).not.toContain('hidden');
  });

  it('conceals ambiguity inherited from two historical memory holders', async () => {
    const published = nodeUrn(target, 'same');
    const first = await createNode(target.id, 'same');
    const originalMemoryUrn = target.urn;
    const renamedFirst = `${originalMemoryUrn}-one`;
    await db.$transaction(async (tx) => {
      await recordUrnRename(tx, {
        entityType: 'MEMORY', entityId: target.id,
        oldUrn: originalMemoryUrn, newUrn: renamedFirst,
      });
      await tx.memory.update({ where: { id: target.id }, data: { urn: renamedFirst } });
    });
    const secondMemory = await db.memory.create({ data: {
      id: generateId(), organizationId: (await db.memory.findUniqueOrThrow({ where: { id: target.id } })).organizationId,
      urn: originalMemoryUrn, name: 'second', class: 'knowledge', visibility: 'ORGANIZATION',
    } });
    const second = await createNode(secondMemory.id, 'same');
    await db.$transaction(async (tx) => {
      await recordUrnRename(tx, {
        entityType: 'MEMORY', entityId: secondMemory.id,
        oldUrn: originalMemoryUrn, newUrn: `${originalMemoryUrn}-two`,
      });
      await tx.memory.update({
        where: { id: secondMemory.id }, data: { urn: `${originalMemoryUrn}-two` },
      });
    });

    await expect(resolveNodeRef(db, published)).rejects.toMatchObject({
      candidateNodeIds: expect.arrayContaining([first.id, second.id]),
    });
    await createNode(source.id, 'safe');
    expect(await resolvers.Query.node(null, { ref: published }, graphCtx(reader.id))).toBeNull();
    const mcp = createTestableMcpServer(mcpAuth(reader.id));
    expect(await mcp.callToolText('hadron_get_node', { urn: published }))
      .toContain('Memory not found');
    const batch = await mcp.callToolText('hadron_get_nodes', {
      refs: [published, nodeUrn(source, 'safe')],
    });
    expect(batch).toContain('Unavailable');
    expect(batch).toContain('body of safe');
    await expect(resolvers.Mutation.deleteNode(null, { nodeRef: published }, graphCtx(reader.id)))
      .rejects.toMatchObject({ extensions: { code: 'NODE_NOT_FOUND' } });
  });

  it('conceals an unreadable Channel among ambiguous node alias claimants', async () => {
    const old = nodeUrn(source, 'old-channel');
    const channelRoot = await createNode(target.id, 'chats:one');
    const other = await createNode(target.id, 'notes:other');
    await db.channel.create({ data: {
      id: generateId(), memoryId: target.id, loc: 'chats:one', name: 'one',
      chatRootNodeId: channelRoot.id,
    } });
    await db.urnAlias.createMany({ data: [channelRoot.id, other.id].map((entityId) => ({
      urn: `${source.urn}:old-channel`, entityType: 'NODE' as const, entityId,
      reason: 'RENAME' as const, replacedByUrn: `${target.urn}:chats:one`,
    })) });
    expect(await resolvers.Query.channel(null, { ref: old }, graphCtx(reader.id))).toBeNull();
    expect(await createTestableMcpServer(mcpAuth(reader.id)).callToolText(
      'hadron_channel_read', { channel: old },
    )).toContain('channel_not_found');
  });

  it('coalesces projections when a batch reads many moved descendant addresses', async () => {
    const root = await createNode(source.id, 'bulk');
    const oldRefs = [nodeUrn(source, 'bulk')];
    for (let i = 0; i < 12; i++) {
      const loc = `bulk:c${String(i).padStart(2, '0')}`;
      await createNode(source.id, loc);
      oldRefs.push(nodeUrn(source, loc));
    }
    await resolvers.Mutation.moveNode(null, {
      sourceRef: root.id, targetUrn: nodeUrn(source, 'new'),
    }, graphCtx());

    const projectionQueries = vi.spyOn(db.node, 'findMany');
    try {
      const text = await createTestableMcpServer(mcpAuth()).callToolText('hadron_get_nodes', {
        refs: oldRefs,
      });
      expect(text).toContain('returned 13 node(s)');
      expect(text).toContain('body of bulk:c11');
      expect(projectionQueries.mock.calls.filter(([arg]) =>
        arg?.where && 'OR' in arg.where && arg.include && 'outgoingEdges' in arg.include,
      )).toHaveLength(1);
    } finally {
      projectionQueries.mockRestore();
    }
  });

  it('does not persist aliases on a refused move and does not resurrect a deleted target', async () => {
    const root = await createNode(source.id, 'old');
    await createNode(source.id, 'occupied');
    const old = nodeUrn(source, 'old');
    await expect(resolvers.Mutation.moveNode(
      null, { sourceRef: root.id, targetUrn: nodeUrn(source, 'occupied') }, graphCtx(),
    )).rejects.toMatchObject({ extensions: { code: 'NODE_ALREADY_EXISTS' } });
    expect(await aliasesFor(root.id)).toEqual([]);
    expect(await resolveNodeRef(db, old)).toEqual({ id: root.id });

    await resolvers.Mutation.moveNode(null, { sourceRef: root.id, targetUrn: nodeUrn(source, 'new') }, graphCtx());
    await db.node.update({ where: { id: root.id }, data: { deletedAt: new Date() } });
    await expect(resolveNodeRef(db, old)).rejects.toBeInstanceOf(NodeNotFoundError);
    expect(await resolvers.Query.node(null, { ref: old }, graphCtx())).toBeNull();
  });

  it('rolls aliases back with the move when the enclosing transaction aborts', async () => {
    const root = await createNode(source.id, 'old');
    const child = await createNode(source.id, 'old:child');
    await expect(withIncludeHistoryClientTransaction(db, async (tx) => {
      await moveNodeSubtree(tx, {
        source: root, destLoc: 'new', editor: { userId: mover.id },
      });
      throw new Error('abort after alias insertion and rebase');
    })).rejects.toThrow('abort after alias insertion and rebase');
    expect(await aliasesFor(root.id)).toEqual([]);
    expect(await aliasesFor(child.id)).toEqual([]);
    expect((await db.node.findUniqueOrThrow({ where: { id: root.id } })).loc).toBe('old');
    expect((await db.node.findUniqueOrThrow({ where: { id: child.id } })).loc).toBe('old:child');
  });

  it('deduplicates a repeated move through the same old address', async () => {
    const root = await createNode(source.id, 'a');
    await resolvers.Mutation.moveNode(null, { sourceRef: root.id, targetUrn: nodeUrn(source, 'b') }, graphCtx());
    await resolvers.Mutation.moveNode(null, { sourceRef: root.id, targetUrn: nodeUrn(source, 'a') }, graphCtx());
    await resolvers.Mutation.moveNode(null, { sourceRef: root.id, targetUrn: nodeUrn(source, 'b') }, graphCtx());
    await resolvers.Mutation.moveNode(null, { sourceRef: root.id, targetUrn: nodeUrn(source, 'b') }, graphCtx());
    expect((await aliasesFor(root.id)).map((a) => a.urn)).toEqual([`${source.urn}:a`, `${source.urn}:b`]);
    expect(await resolveNodeRef(db, nodeUrn(source, 'a'))).toEqual({ id: root.id });
  });
});
