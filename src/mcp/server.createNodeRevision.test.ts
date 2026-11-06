/**
 * Regression coverage for issue #976 — hadron_create_node's UPSERT branch
 * wrote no NodeRevision — as it stands after #1181.
 *
 * ORIGINAL BUG (#976): hadron_create_node was create-OR-update (#543), and
 * re-minting an existing loc overwrote the row's content with no recoverable
 * history, while every sibling write surface snapshots the pre-edit state:
 * hadron_update_node, hadron_replace_text / hadron_update_node_data (via the
 * GraphQL resolver), hadron_move_node, and writeNodeCore's own `if (existing)`
 * branch. The tell in production was a node still at its creation revision on a node with a
 * post-creation write in usage_events — revSeq is bumped inside the same tx as
 * each revision insert (#696), so a pruned or cleared history would still leave
 * it above its creation value.
 *
 * WHAT #1181 CHANGED, and why most of this file moved: hadron_create_node no
 * longer overwrites a LIVE loc at all — it refuses, matching the GraphQL
 * createNode mutation and the runner tool. So "create over an existing live
 * row" is no longer a reachable state, and the tests that drove #976 through it
 * now drive it through the ONE path where create_node still lands on an
 * existing row: RESURRECTING a soft-deleted node. The #976 guarantee is
 * unchanged and still needs its coverage — the prior state must survive the
 * write — it is simply only reachable over a tombstone now.
 *
 * Note this makes the original bug harder to hit rather than merely audited:
 * #976 made a silent overwrite recoverable, #1181 stops most of it happening.
 *
 * The parity test remains the load-bearing one: it pins create-over-existing
 * (now: resurrect) and hadron_update_node to the SAME snapshot shape, so the
 * two surfaces cannot drift apart again.
 *
 * Test harness: `createTestableMcpServer` drives the real production closure
 * (auth + canWriteToMemory + Prisma) without an HTTP transport.
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
  memory: { id: string; urn: string };
}

let fx: Fixture;

function adminAuth(): AuthContext {
  return { userId: fx.admin.id, roles: ['ADMIN'], clientId: `user:${fx.admin.id}` };
}

/** Seed a live node directly, bypassing the write surfaces under test. */
async function seedNode(loc: string, over: Record<string, unknown> = {}) {
  return db.node.create({
    data: {
      id: generateId(),
      memoryId: fx.memory.id,
      loc,
      name: 'Original name',
      nodeType: 'info',
      description: 'Original description',
      content: 'Original content',
      tags: ['alpha'],
      ...over,
    },
  });
}

/**
 * Seed a SOFT-DELETED node — since #1181 this is the only state in which
 * hadron_create_node still lands on an existing row (a live one is refused),
 * and therefore the only way to exercise #976's snapshot-the-prior-state
 * guarantee through this surface.
 */
async function seedTombstone(loc: string, over: Record<string, unknown> = {}) {
  return seedNode(loc, { deletedAt: new Date(), deletedBy: fx.admin.id, ...over });
}

beforeEach(async () => {
  await cleanDb(db);

  const org = await db.organization.create({
    data: { id: generateId(), name: 'issue-976-org', urn: 'issue-976-org' },
  });
  const admin = await db.user.create({
    data: { githubId: 9761, githubUsername: 'issue-976-admin', roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });

  const memory = await resolvers.Mutation.createMemory(
    {},
    { orgId: org.id, name: 'mutations' },
    { db, roles: ['ADMIN'], userId: admin.id } as Context,
  );

  fx = { admin, memory };
});

describe('hadron_create_node over an existing loc — revision history (#976/#1181)', () => {
  it('snapshots the overwritten content and bumps revSeq', async () => {
    const node = await seedTombstone('ops:overwrite-me');

    const text = await createTestableMcpServer(adminAuth()).callToolText('hadron_create_node', {
      urn: `hrn:node:${fx.memory.urn}:${node.loc}`,
      name: 'Corrected name',
      content: 'Corrected content',
    });
    expect(text).toMatch(/Node saved/);

    const revisions = await db.nodeRevision.findMany({ where: { nodeId: node.id } });
    expect(revisions).toHaveLength(1);

    // The snapshot holds the PRE-write state — the whole point: the
    // overwritten wording stays recoverable.
    const [rev] = revisions;
    expect(rev.name).toBe('Original name');
    expect(rev.content).toBe('Original content');
    expect(rev.description).toBe('Original description');
    expect(rev.memoryId).toBe(fx.memory.id);
    expect(rev.revNo).toBe(1);
    // editedBy is the user PK; the #696 counter agrees with the revision.
    expect(rev.editedBy).toBe(fx.admin.id);
    const after = await db.node.findUnique({ where: { id: node.id } });
    expect(after?.revSeq).toBe(2);
    expect(after?.content).toBe('Corrected content');
  });

  it('records the clobbered fields in `changes`, including those reset by omission', async () => {
    const node = await seedTombstone('ops:clobber');

    await createTestableMcpServer(adminAuth()).callToolText('hadron_create_node', {
      urn: `hrn:node:${fx.memory.urn}:${node.loc}`,
      name: 'Corrected name',
      content: 'Corrected content',
      // description + tags deliberately omitted: this surface RESETS them
      // (`description ?? null`, `tags ?? []`), so they are genuine changes.
    });

    const [rev] = await db.nodeRevision.findMany({ where: { nodeId: node.id } });
    expect(rev.changes.sort()).toEqual(['content', 'description', 'name', 'tags']);
  });

  it('stamps updatedBy on the overwrite', async () => {
    const node = await seedTombstone('ops:stamped');

    await createTestableMcpServer(adminAuth()).callToolText('hadron_create_node', {
      urn: `hrn:node:${fx.memory.urn}:${node.loc}`,
      name: 'Corrected name',
      content: 'Corrected content',
    });

    const after = await db.node.findUnique({ where: { id: node.id } });
    expect(after?.updatedBy).toBe(`user:${fx.admin.id}`);
  });

  it('snapshots an overwrite under a parent loc too (the ancestor-lock path)', async () => {
    // The nested loc takes the #664 lockAncestorsForCreate transaction — a
    // different branch of the upsert than a root-level loc, and it must
    // snapshot on the same terms.
    await seedNode('ops');
    const child = await seedTombstone('ops:nested:deep');

    await createTestableMcpServer(adminAuth()).callToolText('hadron_create_node', {
      urn: `hrn:node:${fx.memory.urn}:${child.loc}`,
      name: 'Corrected name',
      content: 'Corrected content',
    });

    const revisions = await db.nodeRevision.findMany({ where: { nodeId: child.id } });
    expect(revisions).toHaveLength(1);
    expect(revisions[0].content).toBe('Original content');
  });

  it('mints NO revision when the loc is free (a real create)', async () => {
    await createTestableMcpServer(adminAuth()).callToolText('hadron_create_node', {
      urn: `hrn:node:${fx.memory.urn}:ops:brand-new`,
      name: 'Brand new',
      content: 'First content',
    });

    const created = await db.node.findFirst({
      where: { memoryId: fx.memory.id, loc: 'ops:brand-new' },
    });
    expect(created).not.toBeNull();
    expect(await db.nodeRevision.count({ where: { nodeId: created!.id } })).toBe(0);
    expect(created?.revSeq).toBe(1);
  });

  it('resurrecting a soft-deleted node still snapshots it (#543 path)', async () => {
    const ghost = await seedNode('ops:ghost', {
      deletedAt: new Date(),
      deletedBy: fx.admin.id,
      content: 'Tombstoned content',
    });

    await createTestableMcpServer(adminAuth()).callToolText('hadron_create_node', {
      urn: `hrn:node:${fx.memory.urn}:${ghost.loc}`,
      name: 'Reborn',
      content: 'Fresh content',
    });

    const revisions = await db.nodeRevision.findMany({ where: { nodeId: ghost.id } });
    expect(revisions).toHaveLength(1);
    expect(revisions[0].content).toBe('Tombstoned content');
  });

  it('records an objectType-only overwrite in `changes`', async () => {
    // objectType is captured by the snapshot and restored on revert, but was
    // missing from TRACKED_NODE_FIELDS — so this diff came back empty (PR #977
    // review, Copilot).
    const node = await seedTombstone('ops:collection', { objectType: 'competitor' });

    await createTestableMcpServer(adminAuth()).callToolText('hadron_create_node', {
      urn: `hrn:node:${fx.memory.urn}:${node.loc}`,
      name: 'Original name',
      description: 'Original description',
      content: 'Original content',
      tags: ['alpha'],
      objectType: 'insight', // the ONLY difference
    });

    const [rev] = await db.nodeRevision.findMany({ where: { nodeId: node.id } });
    expect(rev.objectType).toBe('competitor');
    expect(rev.changes).toContain('objectType');
  });

  it('two concurrent writes to one free loc: one creates, the other is REFUSED', async () => {
    // History of this case, because the guarantee has strengthened twice:
    //
    //   pre-#977  both calls probed BEFORE the transaction, both saw no row,
    //             both took the create branch, and the second silently
    //             overwrote the first with no snapshot (PR #977 review).
    //   #977      the loc write lock serialized them, so the second always saw
    //             the first's committed row and snapshotted it before
    //             overwriting. Nothing was destroyed silently.
    //   #1181     the second now sees a LIVE row and REFUSES. Nothing is
    //             overwritten at all, so there is nothing to snapshot.
    //
    // This is the property #1178 wants from a citation allocator, and it is
    // worth stating plainly because it is easy to assume otherwise: the
    // (loc, memory_id) unique plus the loc write lock plus this gate already
    // make concurrent minting mint-or-refuse. The loser is told, rather than
    // quietly winning.
    const srv = createTestableMcpServer(adminAuth());
    const write = (content: string) =>
      srv.callToolText('hadron_create_node', {
        urn: `hrn:node:${fx.memory.urn}:ops:contested`,
        name: 'Contested',
        content,
      });

    const results = await Promise.all([write('content from A'), write('content from B')]);

    // Exactly one winner and one refusal — not two successes, not two refusals.
    const refused = results.filter((r) => /already exists/i.test(r));
    const saved = results.filter((r) => /Node saved/i.test(r));
    expect(refused).toHaveLength(1);
    expect(saved).toHaveLength(1);

    const rows = await db.node.findMany({
      where: { memoryId: fx.memory.id, loc: 'ops:contested' },
    });
    expect(rows).toHaveLength(1);

    // The winner's content stands, untouched, and no revision was cut because
    // nothing was ever overwritten.
    expect(['content from A', 'content from B']).toContain(rows[0].content);
    expect(rows[0].revSeq).toBe(1);
    expect(await db.nodeRevision.count({ where: { nodeId: rows[0].id } })).toBe(0);
  });

  it('produces the same snapshot shape as hadron_update_node (parity)', async () => {
    // Two identical nodes, the same edit applied through each surface. The
    // snapshots must agree on everything but their own identity/timestamps —
    // that equivalence is what stops the two surfaces drifting again.
    const viaCreate = await seedTombstone('ops:parity-create');
    const viaUpdate = await seedNode('ops:parity-update');

    const srv = createTestableMcpServer(adminAuth());
    await srv.callToolText('hadron_create_node', {
      urn: `hrn:node:${fx.memory.urn}:${viaCreate.loc}`,
      name: 'Corrected name',
      content: 'Corrected content',
      description: 'Original description',
      tags: ['alpha'],
    });
    await srv.callToolText('hadron_update_node', {
      urn: `hrn:node:${fx.memory.urn}:${viaUpdate.loc}`,
      name: 'Corrected name',
      content: 'Corrected content',
    });

    const [createRev] = await db.nodeRevision.findMany({ where: { nodeId: viaCreate.id } });
    const [updateRev] = await db.nodeRevision.findMany({ where: { nodeId: viaUpdate.id } });

    const comparable = (r: typeof createRev) => ({
      name: r.name,
      description: r.description,
      content: r.content,
      abstract: r.abstract,
      tags: r.tags,
      nodeType: r.nodeType,
      revNo: r.revNo,
      editedBy: r.editedBy,
      editedByInfo: r.editedByInfo,
      memoryId: r.memoryId,
      changes: [...r.changes].sort(),
    });
    expect(comparable(createRev)).toEqual(comparable(updateRev));
  });

  it('rolls back both the revision claim and visible MCP update when snapshot insertion fails', async () => {
    const node = await seedNode('ops:rollback');
    // Occupy r1 so the update's predecessor snapshot collides after revSeq is
    // advanced inside the transaction. This forces a failure at the exact seam
    // that used to run outside the visible update and swallow its error.
    await db.nodeRevision.create({
      data: {
        id: generateId(),
        nodeId: node.id,
        memoryId: fx.memory.id,
        loc: node.loc,
        name: 'occupied r1',
        revNo: 1,
      },
    });

    // The transaction still aborts, but #1695 now catches the database fault
    // before the SDK can expose its revision-table diagnostics to the caller.
    const result = await createTestableMcpServer(adminAuth()).callTool('hadron_update_node', {
        urn: `hrn:node:${fx.memory.urn}:${node.loc}`,
        content: 'must not land',
    });
    const requestId = (result as unknown as { structuredContent: { error: { requestId: string } } }).structuredContent.error.requestId;
    expect(result).toEqual({
      isError: true,
      content: [{ type: 'text', text: `[INTERNAL_SERVER_ERROR] Internal server error. Request id: ${requestId}` }],
      structuredContent: { error: { code: 'INTERNAL_SERVER_ERROR', requestId, message: 'Internal server error.' } },
    });

    const after = await db.node.findUniqueOrThrow({ where: { id: node.id } });
    expect(after.content).toBe('Original content');
    expect(after.revSeq).toBe(1);
    expect(await db.nodeRevision.count({ where: { nodeId: node.id } })).toBe(1);
  });
});
