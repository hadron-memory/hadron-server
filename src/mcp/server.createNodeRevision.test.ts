/**
 * Regression coverage for issue #976 — hadron_create_node's UPSERT branch
 * wrote no NodeRevision.
 *
 * hadron_create_node is create-OR-update (#543). Until this fix, re-minting an
 * existing loc overwrote the row's content with no recoverable history, while
 * every sibling write surface snapshots the pre-edit state: hadron_update_node,
 * hadron_replace_text / hadron_update_node_data (via the GraphQL resolver),
 * hadron_move_node, and writeNodeCore's own `if (existing)` branch. The tell in
 * production was `Node.revSeq = 0` on a node with a post-creation write in
 * usage_events — revSeq is bumped inside the same tx as each revision insert
 * (#696), so a pruned or cleared history would still leave it > 0.
 *
 * The parity test is the load-bearing one: it pins create-over-existing and
 * hadron_update_node to the SAME snapshot shape, so the two surfaces cannot
 * drift apart again.
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

describe('hadron_create_node over an existing loc — revision history (#976)', () => {
  it('snapshots the overwritten content and bumps revSeq', async () => {
    const node = await seedNode('ops:overwrite-me');

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
    expect(after?.revSeq).toBe(1);
    expect(after?.content).toBe('Corrected content');
  });

  it('records the clobbered fields in `changes`, including those reset by omission', async () => {
    const node = await seedNode('ops:clobber');

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
    const node = await seedNode('ops:stamped');

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
    const child = await seedNode('ops:nested:deep');

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
    expect(created?.revSeq).toBe(0);
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

  it('produces the same snapshot shape as hadron_update_node (parity)', async () => {
    // Two identical nodes, the same edit applied through each surface. The
    // snapshots must agree on everything but their own identity/timestamps —
    // that equivalence is what stops the two surfaces drifting again.
    const viaCreate = await seedNode('ops:parity-create');
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
});
