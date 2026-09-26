/** #1391: a move preserves each published node address through the alias map. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import { resolveNodeRef } from './entityRef/nodeRef.js';
import { moveNodeSubtree } from './nodeSubtreeMove.js';
import { recordUrnRename } from './urnAlias.js';
import { NodeNotFoundError } from './entityRef/errors.js';
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
const createNode = (memoryId: string, loc: string) => db.node.create({
  data: { id: generateId(), memoryId, loc, name: loc, content: `body of ${loc}` },
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
    expect((await resolvers.Query.node(null, { ref: oldChild }, graphCtx()))?.id).toBe(child.id);
    expect(await resolvers.Query.resolveUrn(null, { urn: oldChild }, graphCtx()))
      .toMatchObject({ kind: 'node', id: child.id, memoryId: source.id });

    const occupant = await createNode(source.id, 'old');
    expect(await resolveNodeRef(db, oldRoot)).toEqual({ id: occupant.id });
    expect((await resolvers.Query.node(null, { ref: oldRoot }, graphCtx()))?.id).toBe(occupant.id);
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
      // This is the source-URN SELECT in moveNodeSubtree waiting on the rename
      // row lock. Without NO KEY UPDATE, the move would read the stale old URN and
      // could commit an alias key that never named its post-rename address.
      await vi.waitFor(async () => {
        const waiting = await db.$queryRaw<Array<{ pid: number }>>`
          SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND query LIKE '%FROM memories WHERE id%' AND query LIKE '%FOR NO KEY UPDATE%'
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
    await expect(db.$transaction(async (tx) => {
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
