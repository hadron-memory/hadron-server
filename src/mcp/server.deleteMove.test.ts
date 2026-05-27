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
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';
import { generateId } from '../lib/id.js';

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
      sourceId: edgeSource.id,
      targetId: edgeTarget.id,
      label: 'cites',
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
  it('returns the moved node\'s record on success (name, type, tags, edge counts, child count)', async () => {
    // Give the source a tag + a child so the record surfaces non-empty fields.
    await db.node.update({
      where: { id: fx.nodes.moveSource.id },
      data: { tags: ['demo', 'p2'], nodeType: 'info' },
    });
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
    expect(text).toMatch(/Type: info/);
    expect(text).toMatch(/Tags: demo, p2/);
    expect(text).toMatch(/Edges: 0 outgoing, 0 incoming/);
    // The descendant did NOT move with the source (documented behavior).
    expect(text).toMatch(/Children: 0 immediate/);
    // The orphan record is still at the old loc, unaffected.
    expect(
      await db.node.findFirst({
        where: { loc: 'relocate:src:child', memoryId: fx.memory.id, deletedAt: null },
      }),
    ).not.toBeNull();
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
