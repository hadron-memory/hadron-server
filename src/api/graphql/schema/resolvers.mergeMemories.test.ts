/**
 * mergeMemories — fold a source memory into a target memory. Covers the
 * collide-vs-relocate partition, the per-field merge on collisions (reusing
 * the mergeNodes strategy), edge follow-through, deleteSourceMem, URN inputs,
 * and the v1 guards (same-memory, encrypted, system/app class).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { mergeMemoryGraph } from '../../../controller/operations/mergeMemories.js';
import { lockMemoryForChannelChange } from '../../../lib/channels.js';
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
  it('carries a relocated stamp, clears a changed collision, and retains a no-op collision stamp', async () => {
    const task = await makeNode(tgtMem.id, 'author-task', { nodeType: 'task' });
    const authoredAt = new Date('2026-09-26T20:00:00Z');
    const stamp = {
      authorshipKind: 'TASK' as const,
      authoredByTask: task.id,
      authoredByRevision: 3,
      authoredAt,
    };
    const relocated = await makeNode(srcMem.id, 'relocated', { content: 'source body', ...stamp });
    await makeNode(srcMem.id, 'changed', { content: 'source addition' });
    const changedTarget = await makeNode(tgtMem.id, 'changed', { content: 'target body', ...stamp });
    await makeNode(srcMem.id, 'unchanged');
    const unchangedTarget = await makeNode(tgtMem.id, 'unchanged', { content: 'keep body', ...stamp });

    await merge({ source: srcMem.id, target: tgtMem.id, include: ['CONTENT'] });

    expect(await db.node.findUniqueOrThrow({ where: { id: relocated.id } })).toMatchObject({
      memoryId: tgtMem.id, content: 'source body', ...stamp,
    });
    expect(await db.node.findUniqueOrThrow({ where: { id: changedTarget.id } })).toMatchObject({
      content: 'target body\n\nsource addition', authorshipKind: null,
      authoredByTask: null, authoredByRevision: null, authoredByHuman: null, authoredAt: null,
    });
    expect(await db.nodeRevision.findFirstOrThrow({ where: { nodeId: changedTarget.id } })).toMatchObject({
      content: 'target body', ...stamp,
    });
    expect(await db.node.findUniqueOrThrow({ where: { id: unchangedTarget.id } })).toMatchObject({
      content: 'keep body', ...stamp,
    });
  });

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
  it('waits for the Channel key before holding Memory rows in a fold', async () => {
    await makeNode(srcMem.id, 'shared', { content: 'source' });
    await makeNode(tgtMem.id, 'shared', { content: 'target' });
    await makeNode(tgtMem.id, 'mm-src'); // the created source memory has a root node
    let signalHeld!: () => void;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { signalHeld = resolve; });
    const mayRelease = new Promise<void>((resolve) => { release = resolve; });
    const holder = db.$transaction(async (tx) => {
      await lockMemoryForChannelChange(tx, srcMem.id);
      signalHeld();
      await mayRelease;
    }, { timeout: 20_000 });
    await held;
    const folding = mergeMemoryGraph(db, {
      sourceMemoryId: srcMem.id,
      targetMemoryId: tgtMem.id,
      fields: new Set(['CONTENT']),
      deleteSourceMem: false,
      editor: { userId: admin.id },
      batchSize: 1,
    });
    try {
      await vi.waitFor(async () => {
        const waiting = await db.$queryRaw<Array<{ pid: number }>>`
          SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND query LIKE '%pg_advisory_xact_lock%'
        `;
        expect(waiting.length).toBeGreaterThan(0);
      }, { timeout: 5_000, interval: 25 });
      // The fold is waiting on the Channel key. A final-disposition-style
      // Memory lock must still be available; the old order held FOR SHARE here.
      await db.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '500ms'`;
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM memories WHERE id = ${srcMem.id} FOR NO KEY UPDATE
        `;
        expect(rows).toHaveLength(1);
      });
    } finally {
      release();
      await holder;
    }
    expect((await folding).foldedCount).toBe(2);
  }, 20_000);

  it('soft-deletes the source memory when deleteSourceMem is true', async () => {
    await makeNode(srcMem.id, 'x', { content: 'x' });
    await merge({ source: srcMem.id, target: tgtMem.id, deleteSourceMem: true });
    const srcRow = await db.memory.findUnique({ where: { id: srcMem.id } });
    expect(srcRow?.deletedAt).not.toBeNull();
    // Nodes still relocated to the target.
    const tgt = await nodesByLoc(tgtMem.id);
    expect(tgt.get('x')?.content).toBe('x');
  });

  it('snapshots a NodeRevision of the target counterpart on a collision merge', async () => {
    await makeNode(srcMem.id, 'shared', { content: 'sc' });
    const tgt = await makeNode(tgtMem.id, 'shared', { content: 'tc' });
    await merge({ source: srcMem.id, target: tgtMem.id, include: ['CONTENT'] });
    const versions = await db.nodeRevision.findMany({ where: { nodeId: tgt.id } });
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
      editor: { userId: actorId() },
      batchSize: 1,
      ...extra,
    });
  }

  it('refuses the next batch when encryption flips after a prior batch commits', async () => {
    await makeNode(srcMem.id, 'later', { content: 'must stay in source' });
    const findMany = db.node.findMany.bind(db.node);
    let flipped = false;
    const scan = vi.spyOn(db.node, 'findMany').mockImplementation((async (args: Parameters<typeof findMany>[0]) => {
      const pageId = args?.where?.id;
      if (!flipped && args?.where?.memoryId === srcMem.id &&
        pageId && typeof pageId === 'object' && 'gt' in pageId) {
        flipped = true;
        await db.memory.update({
          where: { id: tgtMem.id }, data: { isEncrypted: true, vectorIndexEnabled: false },
        });
      }
      return findMany(args);
    }) as never);
    try {
      await expect(mergeBatched({ classifyPageSize: 1 })).rejects.toMatchObject({
        extensions: { code: 'ENCRYPTED_MEMORY_MERGE_UNSUPPORTED', memoryId: tgtMem.id },
      });
    } finally {
      scan.mockRestore();
    }
    expect(flipped).toBe(true);
    expect(await db.node.count({ where: { memoryId: srcMem.id, deletedAt: null } })).toBeGreaterThan(0);
    expect(await db.node.count({ where: { memoryId: tgtMem.id, content: 'must stay in source' } })).toBe(0);
  });

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

  it('classifies and relocates correctly across multiple keyset pages', async () => {
    // classifyPageSize=2 forces the classify+relocate scan to page several
    // times. Movers leave the source set as they relocate; the colliding rows
    // left behind must not be re-read (keyset), and a collision sitting in a
    // later page must still be detected.
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push((await makeNode(srcMem.id, `n${i}`, { content: `s${i}` })).id);
    // Give two of them target counterparts (collisions); the other two move.
    await makeNode(tgtMem.id, 'n1', { content: 't1' });
    await makeNode(tgtMem.id, 'n3', { content: 't3' });

    const res = await mergeMemoryGraph(db, {
      sourceMemoryId: srcMem.id,
      targetMemoryId: tgtMem.id,
      fields: new Set(['CONTENT', 'EDGES']),
      deleteSourceMem: false,
      editor: { userId: actorId() },
      batchSize: 1,
      classifyPageSize: 2,
    });
    // 2 collisions folded, the rest (n0, n2 + the source root) relocated.
    expect(res.foldedCount).toBe(2);
    expect(res.relocatedCount).toBe(3);

    const tgt = await nodesByLoc(tgtMem.id);
    expect(tgt.get('n1')?.content).toBe('t1\n\ns1');
    expect(tgt.get('n3')?.content).toBe('t3\n\ns3');
    expect(tgt.get('n0')?.content).toBe('s0');
    expect(tgt.get('n2')?.content).toBe('s2');
    expect(await db.node.count({ where: { memoryId: srcMem.id, deletedAt: null } })).toBe(0);
  });

  it('clamps a non-positive batchSize instead of spinning forever', async () => {
    await makeNode(srcMem.id, 'shared', { content: 'sc' });
    await makeNode(tgtMem.id, 'shared', { content: 'tc' });
    // batchSize=0 would never advance the fold loop without the >= 1 clamp.
    const res = await mergeBatched({ batchSize: 0 });
    expect(res.foldedCount).toBe(1);
    const tgt = await nodesByLoc(tgtMem.id);
    expect(tgt.get('shared')?.content).toBe('tc\n\nsc');
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

// ───── #1117 — abstract-cap refusal through the mergeMemories adapter ─────

describe('mergeMemories — abstract-cap refusal (#1117)', () => {
  it('reports the target length, delta and headroom in message AND extensions, tagged with the target loc', async () => {
    // Colliding loc: combineText joins with a blank line → 1500 + 2 + 1500 = 3002.
    await makeNode(srcMem.id, 'shared', { abstract: 'b'.repeat(1500) });
    await makeNode(tgtMem.id, 'shared', { abstract: 'a'.repeat(1500) });
    let caught: unknown;
    try {
      await merge({ source: srcMem.id, target: tgtMem.id });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(GraphQLError);
    const err = caught as GraphQLError;
    expect(err.extensions?.code).toBe('NodeAbstractTooLongError');
    expect(err.message).toMatch(
      /This edit takes a 1500-character abstract to 3002 \(\+1502\); 500 characters were available\./,
    );
    expect(err.extensions).toMatchObject({
      length: 3002,
      max: 2000,
      currentLength: 1500,
      available: 500,
      loc: 'shared',
    });
  });

  it('an empty-string target abstract (raw row) is a full replacement — bare message, no invented current', async () => {
    // Caps are validation, not invariants, so a raw row can exceed the cap;
    // combineText adopts the source wholesale when the target is empty ('').
    await makeNode(srcMem.id, 'grow', { abstract: 'x'.repeat(2500) });
    await makeNode(tgtMem.id, 'grow', { abstract: '' });
    let caught: unknown;
    try {
      await merge({ source: srcMem.id, target: tgtMem.id });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(GraphQLError);
    const err = caught as GraphQLError;
    expect(err.message).toContain('got 2500 chars');
    expect(err.message).not.toContain('This edit takes');
    expect(err.extensions?.currentLength).toBeUndefined();
  });

  it('an absent target abstract is likewise a full replacement — bare message', async () => {
    await makeNode(srcMem.id, 'fresh', { abstract: 'y'.repeat(2100) });
    await makeNode(tgtMem.id, 'fresh', {});
    let caught: unknown;
    try {
      await merge({ source: srcMem.id, target: tgtMem.id });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(GraphQLError);
    const err = caught as GraphQLError;
    expect(err.message).toContain('got 2100 chars');
    expect(err.message).not.toContain('This edit takes');
    expect(err.extensions?.currentLength).toBeUndefined();
  });
});
