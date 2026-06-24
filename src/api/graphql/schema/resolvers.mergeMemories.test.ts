/**
 * mergeMemories — fold a source memory into a target memory. Covers the
 * collide-vs-relocate partition, the per-field merge on collisions (reusing
 * the mergeNodes strategy), edge follow-through, deleteSourceMem, URN inputs,
 * and the v1 guards (same-memory, encrypted, system/app class).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { mergeMemoryGraph } from '../../../controller/operations/mergeMemories.js';
import { generateId } from '../../../lib/id.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let org: { id: string; urn: string };
let admin: { id: string };
let srcMem: { id: string; urn: string };
let tgtMem: { id: string; urn: string };

function ctx(): Context {
  return { db, roles: ['ADMIN'], userId: admin.id };
}

async function makeNode(memoryId: string, loc: string, fields: Record<string, unknown> = {}) {
  return db.node.create({
    data: { id: generateId(), memoryId, loc, name: loc, ...fields },
  });
}

function merge(input: Record<string, unknown>) {
  return resolvers.Mutation.mergeMemories({}, { input } as never, ctx());
}

/** Live nodes in a memory, keyed by loc. */
async function nodesByLoc(memoryId: string) {
  const rows = await db.node.findMany({ where: { memoryId, deletedAt: null } });
  return new Map(rows.map((n) => [n.loc, n]));
}

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({
    data: { id: generateId(), name: 'mm-org', urn: 'mm-org' },
  });
  admin = await db.user.create({
    data: { githubId: 9999, githubUsername: 'mm-admin', roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });
  srcMem = await resolvers.Mutation.createMemory({}, { orgId: org.id, name: 'mm-src' }, ctx());
  tgtMem = await resolvers.Mutation.createMemory({}, { orgId: org.id, name: 'mm-tgt' }, ctx());
});

describe('mergeMemories — partition (collide vs relocate)', () => {
  it('folds colliding nodes and relocates the rest, emptying the source', async () => {
    await makeNode(srcMem.id, 'shared', { content: 'from source', tags: ['s'] });
    await makeNode(srcMem.id, 'srconly', { content: 'only in source' });
    await makeNode(tgtMem.id, 'shared', { content: 'from target', tags: ['t'] });
    await makeNode(tgtMem.id, 'tgtonly', { content: 'only in target' });

    const out = await merge({ source: srcMem.id, target: tgtMem.id });
    expect(out.id).toBe(tgtMem.id);

    const tgt = await nodesByLoc(tgtMem.id);
    // Colliding node folded (target-first concat, tags unioned).
    expect(tgt.get('shared')?.content).toBe('from target\n\nfrom source');
    expect(tgt.get('shared')?.tags).toEqual(['t', 's']);
    // Non-colliding source node relocated with loc unchanged.
    expect(tgt.get('srconly')?.content).toBe('only in source');
    // Pre-existing target node untouched.
    expect(tgt.get('tgtonly')?.content).toBe('only in target');

    // Source is empty (its root node moved over too); source memory still live.
    const srcLive = await db.node.count({ where: { memoryId: srcMem.id, deletedAt: null } });
    expect(srcLive).toBe(0);
    const srcRow = await db.memory.findUnique({ where: { id: srcMem.id } });
    expect(srcRow?.deletedAt).toBeNull();
  });

  it('relocates a node keeping its stable id', async () => {
    const n = await makeNode(srcMem.id, 'keep', { content: 'x' });
    await merge({ source: srcMem.id, target: tgtMem.id });
    const moved = await db.node.findUnique({ where: { id: n.id } });
    expect(moved?.memoryId).toBe(tgtMem.id);
    expect(moved?.loc).toBe('keep');
  });

  it('only merges the selected fields on collisions', async () => {
    await makeNode(srcMem.id, 'shared', { content: 'sc', description: 'sd' });
    await makeNode(tgtMem.id, 'shared', { content: 'tc', description: 'td' });

    await merge({ source: srcMem.id, target: tgtMem.id, include: ['CONTENT'] });

    const tgt = await nodesByLoc(tgtMem.id);
    expect(tgt.get('shared')?.content).toBe('tc\n\nsc');
    expect(tgt.get('shared')?.description).toBe('td'); // untouched
  });
});

describe('mergeMemories — edges', () => {
  it('relocates an edge between two moved nodes into the target memory', async () => {
    const a = await makeNode(srcMem.id, 'a');
    const b = await makeNode(srcMem.id, 'b');
    await db.edge.create({
      data: { id: generateId(), memoryId: srcMem.id, sourceId: a.id, targetId: b.id, loc: 'a:rel:b' },
    });

    await merge({ source: srcMem.id, target: tgtMem.id });

    const edge = await db.edge.findFirst({ where: { sourceId: a.id, targetId: b.id } });
    expect(edge?.memoryId).toBe(tgtMem.id);
  });

  it('transfers a colliding node\'s edge onto its target counterpart', async () => {
    const srcShared = await makeNode(srcMem.id, 'shared');
    const srcChild = await makeNode(srcMem.id, 'child');
    await db.edge.create({
      data: { id: generateId(), memoryId: srcMem.id, sourceId: srcShared.id, targetId: srcChild.id, loc: 'shared:rel:child' },
    });
    const tgtShared = await makeNode(tgtMem.id, 'shared');

    await merge({ source: srcMem.id, target: tgtMem.id }); // EDGES included by default

    // The source 'shared' node is gone; its edge now hangs off the target counterpart.
    expect(await db.node.findUnique({ where: { id: srcShared.id } })).toBeNull();
    const edge = await db.edge.findFirst({ where: { sourceId: tgtShared.id, targetId: srcChild.id } });
    expect(edge).not.toBeNull();
    expect(edge?.memoryId).toBe(tgtMem.id);
  });

  it('keeps an existing target edge that points into a relocating source node', async () => {
    // Regression: an edge already in the target memory (target-node → source-
    // node) is incident to a source node, so it's in the fetched set. It must
    // NOT be dropped as a false self-collision when its source node relocates.
    const tnode = await makeNode(tgtMem.id, 'tnode');
    const snode = await makeNode(srcMem.id, 'snode'); // moves (no target counterpart)
    const edge = await db.edge.create({
      data: { id: generateId(), memoryId: tgtMem.id, sourceId: tnode.id, targetId: snode.id, loc: 'tnode:rel:snode' },
    });

    await merge({ source: srcMem.id, target: tgtMem.id });

    const survived = await db.edge.findUnique({ where: { id: edge.id } });
    expect(survived).not.toBeNull();
    expect(survived?.sourceId).toBe(tnode.id);
    expect(survived?.targetId).toBe(snode.id);
    expect(survived?.memoryId).toBe(tgtMem.id);
  });

  it('does not transfer a colliding node\'s edge when EDGES is excluded', async () => {
    const srcShared = await makeNode(srcMem.id, 'shared');
    const srcChild = await makeNode(srcMem.id, 'child');
    await db.edge.create({
      data: { id: generateId(), memoryId: srcMem.id, sourceId: srcShared.id, targetId: srcChild.id, loc: 'shared:rel:child' },
    });
    const tgtShared = await makeNode(tgtMem.id, 'shared');

    await merge({ source: srcMem.id, target: tgtMem.id, include: ['CONTENT'] });

    // The colliding source node was deleted → its edge cascaded away.
    expect(await db.edge.findFirst({ where: { sourceId: tgtShared.id } })).toBeNull();
    expect(await db.edge.count({ where: { OR: [{ sourceId: srcShared.id }, { targetId: srcShared.id }] } })).toBe(0);
  });
});

describe('mergeMemories — source disposition', () => {
  it('soft-deletes the source memory when deleteSourceMem is true', async () => {
    await makeNode(srcMem.id, 'x', { content: 'x' });
    await merge({ source: srcMem.id, target: tgtMem.id, deleteSourceMem: true });
    const srcRow = await db.memory.findUnique({ where: { id: srcMem.id } });
    expect(srcRow?.deletedAt).not.toBeNull();
    // Nodes still relocated to the target.
    const tgt = await nodesByLoc(tgtMem.id);
    expect(tgt.get('x')?.content).toBe('x');
  });

  it('snapshots a NodeVersion of the target counterpart on a collision merge', async () => {
    await makeNode(srcMem.id, 'shared', { content: 'sc' });
    const tgt = await makeNode(tgtMem.id, 'shared', { content: 'tc' });
    await merge({ source: srcMem.id, target: tgtMem.id, include: ['CONTENT'] });
    const versions = await db.nodeVersion.findMany({ where: { nodeId: tgt.id } });
    expect(versions).toHaveLength(1);
    expect(versions[0].content).toBe('tc'); // pre-merge snapshot
  });
});

describe('mergeMemories — input resolution', () => {
  it('accepts memory URNs for both endpoints', async () => {
    await makeNode(srcMem.id, 'n', { content: 'x' });
    const out = await merge({ source: srcMem.urn, target: tgtMem.urn });
    expect(out.id).toBe(tgtMem.id);
    const tgt = await nodesByLoc(tgtMem.id);
    expect(tgt.get('n')?.content).toBe('x');
  });
});

describe('mergeMemories — batched / resumable (#363)', () => {
  // Drive the operation directly with batchSize=1 so the colliding-fold and
  // edge-drain loops run across MANY inner transactions — the same code path a
  // very large source memory exercises, without seeding hundreds of rows.
  const actorId = () => admin.id;
  function mergeBatched(extra: Record<string, unknown> = {}) {
    return mergeMemoryGraph(db, {
      sourceMemoryId: srcMem.id,
      targetMemoryId: tgtMem.id,
      fields: new Set(['CONTENT', 'ABSTRACT', 'DESCRIPTION', 'TAGS', 'DATA', 'PROPERTIES', 'EDGES']),
      deleteSourceMem: false,
      actorId: actorId(),
      batchSize: 1,
      ...extra,
    });
  }

  it('folds every colliding node and relocates the rest across many batches', async () => {
    // Several collisions + several relocations, each landing in its own batch.
    for (let i = 0; i < 5; i++) {
      await makeNode(srcMem.id, `shared${i}`, { content: `s${i}` });
      await makeNode(tgtMem.id, `shared${i}`, { content: `t${i}` });
      await makeNode(srcMem.id, `move${i}`, { content: `m${i}` });
    }

    const res = await mergeBatched();
    expect(res.foldedCount).toBe(5);
    expect(res.relocatedCount).toBe(6); // 5 move* + the source root node

    const tgt = await nodesByLoc(tgtMem.id);
    for (let i = 0; i < 5; i++) {
      expect(tgt.get(`shared${i}`)?.content).toBe(`t${i}\n\ns${i}`);
      expect(tgt.get(`move${i}`)?.content).toBe(`m${i}`);
    }
    expect(await db.node.count({ where: { memoryId: srcMem.id, deletedAt: null } })).toBe(0);
  });

  it('re-points an edge spanning two colliding nodes folded in different batches', async () => {
    const c1 = await makeNode(srcMem.id, 'c1');
    const c2 = await makeNode(srcMem.id, 'c2');
    const t1 = await makeNode(tgtMem.id, 'c1');
    const t2 = await makeNode(tgtMem.id, 'c2');
    await db.edge.create({
      data: { id: generateId(), memoryId: srcMem.id, sourceId: c1.id, targetId: c2.id, loc: 'c1:rel:c2' },
    });

    await mergeBatched();

    // Both colliding source nodes gone; the edge now connects the two target
    // counterparts even though they were folded in separate transactions.
    expect(await db.node.findUnique({ where: { id: c1.id } })).toBeNull();
    expect(await db.node.findUnique({ where: { id: c2.id } })).toBeNull();
    const edge = await db.edge.findFirst({ where: { sourceId: t1.id, targetId: t2.id } });
    expect(edge).not.toBeNull();
    expect(edge?.memoryId).toBe(tgtMem.id);
  });

  it('drops an edge whose loc is already taken in the target', async () => {
    // A relocating-node edge whose loc collides with a pre-existing target edge
    // must drop (the (loc, memory) unique index would otherwise be violated).
    const a = await makeNode(srcMem.id, 'a');
    const b = await makeNode(srcMem.id, 'b');
    await db.edge.create({
      data: { id: generateId(), memoryId: srcMem.id, sourceId: a.id, targetId: b.id, loc: 'dup' },
    });
    const ta = await makeNode(tgtMem.id, 'ta');
    const tb = await makeNode(tgtMem.id, 'tb');
    await db.edge.create({
      data: { id: generateId(), memoryId: tgtMem.id, sourceId: ta.id, targetId: tb.id, loc: 'dup' },
    });

    const res = await mergeBatched();
    expect(res.edgesDroppedCount).toBe(1);
    // The pre-existing target edge survives; only one edge at loc 'dup' remains.
    expect(await db.edge.count({ where: { memoryId: tgtMem.id, loc: 'dup' } })).toBe(1);
    expect(await db.edge.count({ where: { memoryId: srcMem.id } })).toBe(0);
  });

  it('is idempotent: re-running completes an interrupted (partial) merge', async () => {
    await makeNode(srcMem.id, 'shared', { content: 'sc' });
    await makeNode(srcMem.id, 'srconly', { content: 'so' });
    await makeNode(tgtMem.id, 'shared', { content: 'tc' });

    // First pass folds + relocates everything.
    await mergeBatched();
    const afterFirst = await nodesByLoc(tgtMem.id);
    expect(afterFirst.get('shared')?.content).toBe('tc\n\nsc');

    // Re-running on the now-empty source is a no-op — crucially it does NOT
    // double-concatenate the folded text (the folded source row is gone).
    const res = await mergeBatched();
    expect(res.foldedCount).toBe(0);
    expect(res.relocatedCount).toBe(0);
    const afterSecond = await nodesByLoc(tgtMem.id);
    expect(afterSecond.get('shared')?.content).toBe('tc\n\nsc');
    expect(afterSecond.get('srconly')?.content).toBe('so');
  });
});

describe('mergeMemories — guards', () => {
  it('rejects merging a memory into itself', async () => {
    await expect(merge({ source: srcMem.id, target: srcMem.id })).rejects.toThrow(/same memory/i);
  });

  it('rejects an encrypted source or target', async () => {
    await db.memory.update({
      where: { id: srcMem.id },
      data: { isEncrypted: true, vectorIndexEnabled: false },
    });
    await expect(merge({ source: srcMem.id, target: tgtMem.id })).rejects.toThrow(/encrypted/i);
  });

  it('rejects a system/app class memory', async () => {
    // class='system' forbids app_id and requires visibility null (CHECK constraints).
    await db.memory.update({ where: { id: srcMem.id }, data: { class: 'system', visibility: null } });
    await expect(merge({ source: srcMem.id, target: tgtMem.id })).rejects.toThrow(/class=/i);
  });
});
