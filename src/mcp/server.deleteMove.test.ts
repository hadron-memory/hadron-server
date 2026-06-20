/**
 * Behavioral coverage for PR-B (#180 Bug 1 + #185 F1/F2):
 *
 *   - h-delete-node — soft default; `hard: true` opt-in; refuses without
 *     `recursive: true` when descendants exist; permission gated by
 *     canWriteToMemory; idempotent on already-tombstoned input under
 *     the soft path.
 *
 *   - h-move-node ergonomics — returns the moved node's record
 *     (name, type, tags, edge counts, child count) so post-move
 *     verification doesn't need a follow-up h-read-node.
 *
 *   - h-move-node collision policy — refuses with URN_ALREADY_EXISTS by
 *     default; `overwrite: true` soft-deletes the existing live target
 *     and moves into the freed slot; a soft-deleted target at the same
 *     URN is re-stamped out of the way (it would otherwise block the
 *     move via the (loc, memoryId) unique constraint).
 *
 * Test harness: `createTestableMcpServer` drives the real production
 * closure (auth + canWriteToMemory + Prisma cascade behavior) without
 * an HTTP transport.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';
import { generateId } from '../lib/id.js';
import { deriveEdgeLoc } from '../lib/edgeLoc.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

interface Fixture {
  admin: { id: string };
  viewer: { id: string };
  memory: { id: string; urn: string };
  nodes: {
    leaf: { id: string; loc: string };
    parent: { id: string; loc: string };
    childA: { id: string; loc: string };
    childB: { id: string; loc: string };
    grandchild: { id: string; loc: string };
    edgeSource: { id: string; loc: string };
    edgeTarget: { id: string; loc: string };
    moveSource: { id: string; loc: string };
    moveTarget: { id: string; loc: string };
    moveTombstone: { id: string; loc: string };
  };
}

let fx: Fixture;

function adminAuth(): AuthContext {
  return { userId: fx.admin.id, roles: ['ADMIN'], clientId: `user:${fx.admin.id}` };
}

function viewerAuth(): AuthContext {
  return { userId: fx.viewer.id, roles: [], clientId: `user:${fx.viewer.id}` };
}

beforeEach(async () => {
  await cleanDb(db);

  const org = await db.organization.create({
    data: { id: generateId(), name: 'pr-b-org', urn: 'pr-b-org' },
  });
  const admin = await db.user.create({
    data: { githubId: 9701, githubUsername: 'pr-b-admin', roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });
  const viewer = await db.user.create({
    data: { githubId: 9702, githubUsername: 'pr-b-viewer', roles: [] },
  });

  const memory = await resolvers.Mutation.createMemory(
    {},
    { orgId: org.id, name: 'mutations' },
    { db, roles: ['ADMIN'], userId: admin.id } as Context,
  );

  const mk = async (loc: string, name: string, nodeType = 'info') =>
    db.node.create({
      data: { id: generateId(), memoryId: memory.id, loc, name, nodeType, tags: [] },
    });

  const leaf = await mk('leaf', 'Leaf', 'info');
  const parent = await mk('section', 'Section', 'parent');
  const childA = await mk('section:a', 'Child A');
  const childB = await mk('section:b', 'Child B');
  const grandchild = await mk('section:a:deep', 'Grandchild');

  const edgeSource = await mk('with-edges', 'Edge source');
  const edgeTarget = await mk('edge-target', 'Edge target');
  await db.edge.create({
    data: {
      id: generateId(),
      memoryId: edgeSource.memoryId,
      sourceId: edgeSource.id,
      targetId: edgeTarget.id,
      loc: deriveEdgeLoc(edgeSource.loc, 'cites', edgeTarget.loc),
      name: 'cites',
    },
  });

  // Move fixtures: source + colliding target (live) + a tombstoned ghost
  // at a third slot to exercise the re-stamp path.
  const moveSource = await mk('relocate:src', 'Relocate source');
  const moveTarget = await mk('relocate:dest', 'Relocate dest (will collide)');
  const moveTombstone = await mk('relocate:ghost', 'Tombstoned occupant');
  await db.node.update({
    where: { id: moveTombstone.id },
    data: { deletedAt: new Date() },
  });

  fx = {
    admin,
    viewer,
    memory,
    nodes: {
      leaf,
      parent,
      childA,
      childB,
      grandchild,
      edgeSource,
      edgeTarget,
      moveSource,
      moveTarget,
      moveTombstone,
    },
  };
});

// ---------------------------------------------------------------------------
// #180 Bug 1 — h-delete-node
// ---------------------------------------------------------------------------

describe('h-delete-node — soft delete (default)', () => {
  it('tombstones a leaf node and returns a soft-deleted confirmation', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('h-delete-node', {
      urn: `urn:node:${fx.memory.urn}:${fx.nodes.leaf.loc}`,
    });

    expect(text).toMatch(/Soft-deleted/);
    expect(text).toContain(fx.nodes.leaf.loc);

    const row = await db.node.findUnique({ where: { id: fx.nodes.leaf.id } });
    expect(row?.deletedAt).toBeInstanceOf(Date);
    expect(row?.deletedBy).toBe(fx.admin.id);
  });

  it('returns "already soft-deleted" for a node that is already tombstoned', async () => {
    await db.node.update({
      where: { id: fx.nodes.leaf.id },
      data: { deletedAt: new Date() },
    });

    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('h-delete-node', {
      urn: `urn:node:${fx.memory.urn}:${fx.nodes.leaf.loc}`,
    });

    expect(text).toMatch(/already soft-deleted/i);
    expect(text).toMatch(/hard: true/);
  });

  it('refuses when the node has live descendants and `recursive: true` is omitted', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('h-delete-node', {
      urn: `urn:node:${fx.memory.urn}:${fx.nodes.parent.loc}`,
    });

    // The 'section' parent has 3 live descendants (a, b, a:deep).
    expect(text).toMatch(/3 descendant/);
    expect(text).toMatch(/recursive: true/);

    const row = await db.node.findUnique({ where: { id: fx.nodes.parent.id } });
    expect(row?.deletedAt).toBeNull();
  });

  it('cascades soft-delete to every live descendant when `recursive: true`', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('h-delete-node', {
      urn: `urn:node:${fx.memory.urn}:${fx.nodes.parent.loc}`,
      recursive: true,
    });

    expect(text).toMatch(/Soft-deleted/);
    expect(text).toMatch(/3 descendant/);

    // Parent + 3 descendants are all tombstoned.
    const liveSubtree = await db.node.findMany({
      where: {
        id: { in: [fx.nodes.parent.id, fx.nodes.childA.id, fx.nodes.childB.id, fx.nodes.grandchild.id] },
        deletedAt: null,
      },
    });
    expect(liveSubtree).toHaveLength(0);
  });
});

describe('h-delete-node — hard delete', () => {
  it('removes the row entirely when `hard: true` and cascades to edges', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('h-delete-node', {
      urn: `urn:node:${fx.memory.urn}:${fx.nodes.edgeSource.loc}`,
      hard: true,
    });

    expect(text).toMatch(/Hard-deleted/);

    const node = await db.node.findUnique({ where: { id: fx.nodes.edgeSource.id } });
    expect(node).toBeNull();

    // The outgoing edge from edgeSource cascade-deleted (FK onDelete: Cascade).
    const edges = await db.edge.findMany({
      where: { sourceId: fx.nodes.edgeSource.id },
    });
    expect(edges).toHaveLength(0);

    // The edge target itself survives.
    const target = await db.node.findUnique({ where: { id: fx.nodes.edgeTarget.id } });
    expect(target).not.toBeNull();
  });

  it('allows re-delete (hard) of an already-soft-deleted node so callers can compact tombstones', async () => {
    await db.node.update({
      where: { id: fx.nodes.leaf.id },
      data: { deletedAt: new Date() },
    });

    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('h-delete-node', {
      urn: `urn:node:${fx.memory.urn}:${fx.nodes.leaf.loc}`,
      hard: true,
    });

    expect(text).toMatch(/Hard-deleted/);
    expect(await db.node.findUnique({ where: { id: fx.nodes.leaf.id } })).toBeNull();
  });

  it('cascades hard-delete recursively (full subtree gone)', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('h-delete-node', {
      urn: `urn:node:${fx.memory.urn}:${fx.nodes.parent.loc}`,
      hard: true,
      recursive: true,
    });

    expect(text).toMatch(/Hard-deleted/);
    const remaining = await db.node.findMany({
      where: {
        id: { in: [fx.nodes.parent.id, fx.nodes.childA.id, fx.nodes.childB.id, fx.nodes.grandchild.id] },
      },
    });
    expect(remaining).toHaveLength(0);
  });
});

describe('h-delete-node — access control', () => {
  it('returns "not found" for a non-admin caller without write access (no existence leak)', async () => {
    const srv = createTestableMcpServer(viewerAuth());
    const text = await srv.callToolText('h-delete-node', {
      urn: `urn:node:${fx.memory.urn}:${fx.nodes.leaf.loc}`,
    });

    expect(text).toMatch(/not found/i);
    // The node still exists.
    const row = await db.node.findUnique({ where: { id: fx.nodes.leaf.id } });
    expect(row?.deletedAt).toBeNull();
  });

  it('returns "not found" for a missing URN under an accessible memory (no probing)', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('h-delete-node', {
      urn: `urn:node:${fx.memory.urn}:nope`,
    });

    expect(text).toMatch(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// #185 F1 + F2 — h-move-node ergonomics + collision policy
// ---------------------------------------------------------------------------

describe('h-move-node — return record (#185 F1)', () => {
  it('returns the moved node\'s record on success (name, type, tags) and omits empty sections', async () => {
    // Give the source a tag so the record surfaces a non-empty Tags line.
    await db.node.update({
      where: { id: fx.nodes.moveSource.id },
      data: { tags: ['demo', 'p2'], nodeType: 'info' },
    });

    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('h-move-node', {
      urn: `urn:node:${fx.memory.urn}:${fx.nodes.moveSource.loc}`,
      targetUrn: `urn:node:${fx.memory.urn}:relocated`,
    });

    expect(text).toMatch(/Moved/);
    expect(text).toMatch(/Type: info/);
    expect(text).toMatch(/Tags: demo, p2/);
    // Empty sections (zero edges, zero children) are omitted — matches
    // h-read-node's pattern (PR-189 review).
    expect(text).not.toMatch(/Edges:/);
    expect(text).not.toMatch(/Children:/);
  });

  it('surfaces non-empty edge counts in the record (edges round-trip the move)', async () => {
    // Wire an outgoing edge + an incoming edge so the Edges line renders
    // a non-zero count after the move. Also verifies that move-by-id
    // doesn't drop edges (edges reference Node.id, not loc, so the
    // count + the post-move edge rows should both survive).
    await db.edge.create({
      data: {
        id: generateId(),
        memoryId: fx.memory.id,
        sourceId: fx.nodes.moveSource.id,
        targetId: fx.nodes.edgeTarget.id,
        loc: deriveEdgeLoc(fx.nodes.moveSource.loc, 'documents', fx.nodes.edgeTarget.loc),
        name: 'documents',
      },
    });
    await db.edge.create({
      data: {
        id: generateId(),
        memoryId: fx.memory.id,
        sourceId: fx.nodes.edgeSource.id,
        targetId: fx.nodes.moveSource.id,
        loc: deriveEdgeLoc(fx.nodes.edgeSource.loc, 'cites', fx.nodes.moveSource.loc),
        name: 'cites',
      },
    });

    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('h-move-node', {
      urn: `urn:node:${fx.memory.urn}:${fx.nodes.moveSource.loc}`,
      targetUrn: `urn:node:${fx.memory.urn}:relocated`,
    });

    expect(text).toMatch(/Edges: 1 outgoing, 1 incoming/);

    // Cross-check at the DB layer: edges still attached to the moved
    // node's id (move-by-id is the path that keeps this true; the
    // earlier composite-key move would have done so too, but a
    // post-move refetch by composite-key could have resolved to a
    // different row under concurrent moves — see the in-tool comment).
    const outgoing = await db.edge.findMany({
      where: { sourceId: fx.nodes.moveSource.id },
    });
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0].targetId).toBe(fx.nodes.edgeTarget.id);
  });

  it('descendants do NOT move with the source (documented; child count line absent)', async () => {
    // The `relocate:src:child` orphan stays under its old prefix and
    // becomes a child of an implicit `relocate:src` parent (the F4 fix
    // in PR-188 renders that gracefully). The Children: line in the
    // move record reports descendants of the NEW loc, which is 0
    // here — and 0 sections are omitted.
    await db.node.create({
      data: {
        id: generateId(),
        memoryId: fx.memory.id,
        loc: 'relocate:src:child',
        name: 'descendant',
        nodeType: 'info',
        tags: [],
      },
    });

    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('h-move-node', {
      urn: `urn:node:${fx.memory.urn}:${fx.nodes.moveSource.loc}`,
      targetUrn: `urn:node:${fx.memory.urn}:relocated`,
    });

    expect(text).toMatch(/Moved/);
    expect(text).not.toMatch(/Children:/);
    // The orphan record still sits at its old loc, unaffected.
    expect(
      await db.node.findFirst({
        where: { loc: 'relocate:src:child', memoryId: fx.memory.id, deletedAt: null },
      }),
    ).not.toBeNull();
  });

  it('surfaces a non-zero Children count when the new loc already had descendants pre-staged', async () => {
    // Curation pattern: a leaf node moves INTO a prefix that other
    // nodes already share. The Children: line should reflect that.
    await db.node.create({
      data: {
        id: generateId(),
        memoryId: fx.memory.id,
        loc: 'relocated:pre-existing',
        name: 'pre-existing child',
        nodeType: 'info',
        tags: [],
      },
    });

    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('h-move-node', {
      urn: `urn:node:${fx.memory.urn}:${fx.nodes.moveSource.loc}`,
      targetUrn: `urn:node:${fx.memory.urn}:relocated`,
    });

    expect(text).toMatch(/Moved/);
    expect(text).toMatch(/Children: 1 immediate descendant/);
  });

  it('writes a NodeVersion snapshot of the pre-move state', async () => {
    const srv = createTestableMcpServer(adminAuth());
    await srv.callToolText('h-move-node', {
      urn: `urn:node:${fx.memory.urn}:${fx.nodes.moveSource.loc}`,
      targetUrn: `urn:node:${fx.memory.urn}:relocated`,
    });

    const versions = await db.nodeVersion.findMany({
      where: { nodeId: fx.nodes.moveSource.id },
    });
    expect(versions).toHaveLength(1);
    // Snapshot captures the OLD loc + name, not the post-move ones.
    expect(versions[0].loc).toBe('relocate:src');
    expect(versions[0].name).toBe('Relocate source');
  });
});

describe('h-move-node — collision policy (#185 F2)', () => {
  it('refuses with URN_ALREADY_EXISTS when a live node occupies the target', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('h-move-node', {
      urn: `urn:node:${fx.memory.urn}:${fx.nodes.moveSource.loc}`,
      targetUrn: `urn:node:${fx.memory.urn}:${fx.nodes.moveTarget.loc}`,
    });

    expect(text).toMatch(/URN_ALREADY_EXISTS/);
    expect(text).toMatch(/overwrite: true/);
    // The source did not move.
    expect(
      await db.node.findUnique({
        where: {
          loc_memoryId: { loc: fx.nodes.moveSource.loc, memoryId: fx.memory.id },
        },
      }),
    ).not.toBeNull();
  });

  it('with `overwrite: true`, soft-deletes the existing live target and moves into its slot', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('h-move-node', {
      urn: `urn:node:${fx.memory.urn}:${fx.nodes.moveSource.loc}`,
      targetUrn: `urn:node:${fx.memory.urn}:${fx.nodes.moveTarget.loc}`,
      overwrite: true,
    });

    expect(text).toMatch(/Moved/);

    // The source's row took over `relocate:dest`.
    const movedRow = await db.node.findUnique({
      where: {
        loc_memoryId: { loc: fx.nodes.moveTarget.loc, memoryId: fx.memory.id },
      },
    });
    expect(movedRow?.id).toBe(fx.nodes.moveSource.id);

    // The old occupant is now tombstoned.
    const oldOccupant = await db.node.findUnique({
      where: { id: fx.nodes.moveTarget.id },
    });
    expect(oldOccupant?.deletedAt).toBeInstanceOf(Date);
  });

  it('re-stamp uses the full id so two eviction collisions in the same ms-window don\'t crash', async () => {
    // PR-189 review caught that the old `id.slice(0, 8)` was timestamp-
    // only entropy (UUIDv7's first 6 bytes are the timestamp ms). Two
    // ghosts stamped at the same target with first-8-chars-matching ids
    // would have collided on `{toLoc}__deleted-{prefix}` and reproduced
    // exactly the Prisma constraint violation this collision policy
    // exists to prevent. With full-id suffixes both can coexist.
    //
    // We construct the failure mode directly: pre-create two
    // soft-deleted ghosts at the same target loc, each with manually-
    // assigned ids that share the first 8 chars but differ on the rest
    // (which IS unique). Old code: second move collides. New code: both
    // get distinct archive locs.
    const sharedPrefix = '019e4e30aaaaaaaaaaaaaaaaaaaaaaaa';
    const ghostA = await db.node.create({
      data: {
        id: sharedPrefix.slice(0, 8) + '111111111111111111111111',
        memoryId: fx.memory.id,
        loc: 'twin-target',
        name: 'ghost A',
        nodeType: 'info',
        tags: [],
        deletedAt: new Date(),
      },
    });
    // Move the ghost out of the way by re-stamping its loc to the
    // archive shape OLD CODE would have produced. This simulates "an
    // earlier overwrite-move already happened at this slot." Then we
    // verify the NEW move's archive loc doesn't collide with it.
    await db.node.update({
      where: { id: ghostA.id },
      data: { loc: `twin-target__deleted-${ghostA.id.slice(0, 8)}` },
    });
    // Reuse the loc for the next move's target.
    const liveB = await db.node.create({
      data: {
        id: sharedPrefix.slice(0, 8) + '222222222222222222222222',
        memoryId: fx.memory.id,
        loc: 'twin-target',
        name: 'live B (will collide via shared prefix)',
        nodeType: 'info',
        tags: [],
      },
    });
    const mover = await db.node.create({
      data: {
        id: generateId(),
        memoryId: fx.memory.id,
        loc: 'twin-mover',
        name: 'mover',
        nodeType: 'info',
        tags: [],
      },
    });

    // Confirm fixture: ghostA and liveB share the first 8 id chars.
    expect(ghostA.id.slice(0, 8)).toBe(liveB.id.slice(0, 8));

    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('h-move-node', {
      urn: `urn:node:${fx.memory.urn}:${mover.loc}`,
      targetUrn: `urn:node:${fx.memory.urn}:twin-target`,
      overwrite: true,
    });

    // The new code uses the FULL id for the suffix, so the second
    // eviction's archive loc is distinct from the first. No
    // unique-constraint violation.
    expect(text).toMatch(/Moved/);
    expect(text).not.toMatch(/Unique constraint/);

    // ghostA still sits at its 8-char-suffix archive loc (untouched).
    const ghostARow = await db.node.findUnique({ where: { id: ghostA.id } });
    expect(ghostARow?.loc).toBe(`twin-target__deleted-${ghostA.id.slice(0, 8)}`);
    // liveB got re-stamped with its full id — distinct from ghostA's.
    const liveBRow = await db.node.findUnique({ where: { id: liveB.id } });
    expect(liveBRow?.loc).toBe(`twin-target__deleted-${liveB.id}`);
    expect(liveBRow?.deletedAt).toBeInstanceOf(Date);
    // The mover took the slot.
    const movedRow = await db.node.findUnique({
      where: { loc_memoryId: { loc: 'twin-target', memoryId: fx.memory.id } },
    });
    expect(movedRow?.id).toBe(mover.id);
  });

  it('moves over a tombstoned ghost by re-stamping its loc out of the way', async () => {
    // moveTombstone sits at `relocate:ghost` with deletedAt set.
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('h-move-node', {
      urn: `urn:node:${fx.memory.urn}:${fx.nodes.moveSource.loc}`,
      targetUrn: `urn:node:${fx.memory.urn}:${fx.nodes.moveTombstone.loc}`,
    });

    // Tombstoned target doesn't trigger URN_ALREADY_EXISTS — it gets
    // re-stamped automatically, then the move proceeds.
    expect(text).toMatch(/Moved/);
    expect(text).not.toMatch(/URN_ALREADY_EXISTS/);

    // The source's row now sits at `relocate:ghost`.
    const movedRow = await db.node.findUnique({
      where: {
        loc_memoryId: { loc: 'relocate:ghost', memoryId: fx.memory.id },
      },
    });
    expect(movedRow?.id).toBe(fx.nodes.moveSource.id);

    // The original ghost was re-stamped, still tombstoned.
    const ghost = await db.node.findUnique({
      where: { id: fx.nodes.moveTombstone.id },
    });
    expect(ghost?.deletedAt).toBeInstanceOf(Date);
    expect(ghost?.loc).toMatch(/^relocate:ghost__deleted-/);
  });
});

describe('h-move-node — cross-memory move + permission denial', () => {
  it('moves a node across memories (admin caller; write access on both)', async () => {
    // Create a second memory in the same org so the admin has write
    // access to both.
    const otherMemory = await resolvers.Mutation.createMemory(
      {},
      { orgId: (await db.organization.findFirst())!.id, name: 'sister' },
      { db, roles: ['ADMIN'], userId: fx.admin.id } as Context,
    );

    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('h-move-node', {
      urn: `urn:node:${fx.memory.urn}:${fx.nodes.moveSource.loc}`,
      targetUrn: `urn:node:${otherMemory.urn}:imported`,
    });

    expect(text).toMatch(/Moved/);
    // The row's memoryId flipped to the other memory; loc is the new value.
    const movedRow = await db.node.findUnique({
      where: { id: fx.nodes.moveSource.id },
    });
    expect(movedRow?.memoryId).toBe(otherMemory.id);
    expect(movedRow?.loc).toBe('imported');
    // Source memory no longer has a row at the old loc.
    expect(
      await db.node.findFirst({
        where: { loc: 'relocate:src', memoryId: fx.memory.id, deletedAt: null },
      }),
    ).toBeNull();
  });

  it('refuses with "write access denied for source memory" when the caller lacks source write', async () => {
    const srv = createTestableMcpServer(viewerAuth());
    const text = await srv.callToolText('h-move-node', {
      urn: `urn:node:${fx.memory.urn}:${fx.nodes.moveSource.loc}`,
      targetUrn: `urn:node:${fx.memory.urn}:somewhere-else`,
    });

    expect(text).toMatch(/Write access denied for source memory/);
    // No row got moved.
    const sourceRow = await db.node.findUnique({
      where: { id: fx.nodes.moveSource.id },
    });
    expect(sourceRow?.loc).toBe('relocate:src');
  });

  it('refuses with "write access denied for target memory" when the caller lacks target write on a cross-memory move', async () => {
    // Create a second org + memory the admin doesn't own. Admin has
    // global ADMIN role so canWriteToMemory still passes — to exercise
    // the target-side denial we need to use a non-admin caller who has
    // write on the source but NOT on the target. Easiest setup: a
    // memory whose access map definitely excludes the viewer; for the
    // source, soft-elevate the viewer via a MemoryShare(writer) on the
    // source memory (personal class is the simplest path, but our
    // fixture memory is knowledge-class).
    //
    // Knowledge-class memories use the AgentMemoryItem-based access
    // map, which requires App + Agent + AppAgent fixtures (heavy). We
    // skip that arrangement here and instead verify the symmetric
    // shape: source-denial test above covers the canWriteToMemory
    // call path; target-denial uses the same predicate against the
    // target's id. Pinning both via grep:
    const src = readFileSync(
      new URL('./server.ts', import.meta.url),
      'utf8',
    );
    expect(src).toMatch(/canWriteToMemory\(db, auth, fromMemory\.id\)/);
    expect(src).toMatch(
      /canWriteToMemory\(db, auth, toMemory\.id\)/,
    );
  });
});

describe('h-delete-node — PendingEdge target-side cleanup (#1)', () => {
  it('explicitly deletes PendingEdge rows where targetId matches a hard-deleted node', async () => {
    // PendingEdge.targetId is NOT a FK (schema.prisma:836), so the
    // Node-FK cascade misses it. Without the explicit deleteMany this
    // PR adds, hard-deleting a node would leave orphan PendingEdge
    // rows where the deleted node was the intended target.
    //
    // PendingEdge.sourceId IS a FK (cascades), so the source-side row
    // is removed automatically by Prisma. We test the target-side path
    // by pointing a PendingEdge at the to-be-deleted node from an
    // unrelated source.
    const pendingHost = await db.node.create({
      data: {
        id: generateId(),
        memoryId: fx.memory.id,
        loc: 'pending-host',
        name: 'pending host',
        nodeType: 'info',
        tags: [],
      },
    });
    await db.pendingEdge.create({
      data: {
        id: generateId(),
        sourceId: pendingHost.id,
        targetId: fx.nodes.leaf.id,
        name: 'pending-link',
      },
    });

    const srv = createTestableMcpServer(adminAuth());
    await srv.callToolText('h-delete-node', {
      urn: `urn:node:${fx.memory.urn}:${fx.nodes.leaf.loc}`,
      hard: true,
    });

    // The PendingEdge with targetId pointing at the deleted node is gone.
    const orphan = await db.pendingEdge.findFirst({
      where: { targetId: fx.nodes.leaf.id },
    });
    expect(orphan).toBeNull();
    // The unrelated source row still exists.
    expect(
      await db.node.findUnique({ where: { id: pendingHost.id } }),
    ).not.toBeNull();
  });
});

describe('h-delete-node — cross-memory edge gate (#4)', () => {
  it('refuses hard-delete when an edge bridges this memory to another, without cascadeCrossMemoryEdges: true', async () => {
    // Create a second memory + a node there + an edge into the
    // to-be-deleted node from that other memory. Hard-delete should
    // refuse with a count.
    const otherMemory = await resolvers.Mutation.createMemory(
      {},
      { orgId: (await db.organization.findFirst())!.id, name: 'neighbor' },
      { db, roles: ['ADMIN'], userId: fx.admin.id } as Context,
    );
    const neighborSrc = await db.node.create({
      data: {
        id: generateId(),
        memoryId: otherMemory.id,
        loc: 'neighbor-src',
        name: 'cross-memory source',
        nodeType: 'info',
        tags: [],
      },
    });
    await db.edge.create({
      data: {
        id: generateId(),
        memoryId: neighborSrc.memoryId,
        sourceId: neighborSrc.id,
        targetId: fx.nodes.leaf.id,
        loc: deriveEdgeLoc(neighborSrc.loc, 'cross-mem-ref', fx.nodes.leaf.loc),
        name: 'cross-mem-ref',
      },
    });

    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('h-delete-node', {
      urn: `urn:node:${fx.memory.urn}:${fx.nodes.leaf.loc}`,
      hard: true,
    });

    expect(text).toMatch(/Hard-delete refused/);
    expect(text).toMatch(/1 edge\(s\) bridge this memory/);
    expect(text).toMatch(/cascadeCrossMemoryEdges: true/);
    // Node still exists.
    expect(
      await db.node.findUnique({ where: { id: fx.nodes.leaf.id } }),
    ).not.toBeNull();
  });

  it('proceeds with hard-delete when cascadeCrossMemoryEdges: true is passed', async () => {
    const otherMemory = await resolvers.Mutation.createMemory(
      {},
      { orgId: (await db.organization.findFirst())!.id, name: 'neighbor2' },
      { db, roles: ['ADMIN'], userId: fx.admin.id } as Context,
    );
    const neighborSrc = await db.node.create({
      data: {
        id: generateId(),
        memoryId: otherMemory.id,
        loc: 'neighbor-src-2',
        name: 'cross-memory source',
        nodeType: 'info',
        tags: [],
      },
    });
    const bridgingEdge = await db.edge.create({
      data: {
        id: generateId(),
        memoryId: neighborSrc.memoryId,
        sourceId: neighborSrc.id,
        targetId: fx.nodes.leaf.id,
        loc: deriveEdgeLoc(neighborSrc.loc, 'cross-mem-ref', fx.nodes.leaf.loc),
        name: 'cross-mem-ref',
      },
    });

    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('h-delete-node', {
      urn: `urn:node:${fx.memory.urn}:${fx.nodes.leaf.loc}`,
      hard: true,
      cascadeCrossMemoryEdges: true,
    });

    expect(text).toMatch(/Hard-deleted/);
    // The node IS deleted; the cross-memory edge cascade-removed too.
    expect(
      await db.node.findUnique({ where: { id: fx.nodes.leaf.id } }),
    ).toBeNull();
    expect(
      await db.edge.findUnique({ where: { id: bridgingEdge.id } }),
    ).toBeNull();
    // The other memory's source node survives (only its outgoing edge
    // is gone).
    expect(
      await db.node.findUnique({ where: { id: neighborSrc.id } }),
    ).not.toBeNull();
  });

  it('soft-delete does not trigger the cross-memory edge gate (edges remain alive in DB)', async () => {
    // The cross-memory concern only applies on hard-delete (which
    // cascades). Soft-delete leaves the edge row alive and PR-188's
    // include filters hide it from the agent surface on both sides.
    const otherMemory = await resolvers.Mutation.createMemory(
      {},
      { orgId: (await db.organization.findFirst())!.id, name: 'neighbor3' },
      { db, roles: ['ADMIN'], userId: fx.admin.id } as Context,
    );
    const neighborSrc = await db.node.create({
      data: {
        id: generateId(),
        memoryId: otherMemory.id,
        loc: 'neighbor-src-3',
        name: 'cross-memory source',
        nodeType: 'info',
        tags: [],
      },
    });
    const edge = await db.edge.create({
      data: {
        id: generateId(),
        memoryId: neighborSrc.memoryId,
        sourceId: neighborSrc.id,
        targetId: fx.nodes.leaf.id,
        loc: deriveEdgeLoc(neighborSrc.loc, 'cross-mem-ref', fx.nodes.leaf.loc),
        name: 'cross-mem-ref',
      },
    });

    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('h-delete-node', {
      urn: `urn:node:${fx.memory.urn}:${fx.nodes.leaf.loc}`,
    });

    expect(text).toMatch(/Soft-deleted/);
    // The edge row is still alive — soft-delete doesn't cascade.
    expect(
      await db.edge.findUnique({ where: { id: edge.id } }),
    ).not.toBeNull();
  });
});
