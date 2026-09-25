/**
 * Integration tests for the #620 NodeRevision changes (+ the #619 editor
 * resolution):
 *   - updateNode snapshots the FULL curated subset (properties/data/nodeType/
 *     seq/isRunnable/llmModel/aiAgent/isLink), captures editedBy as the USER
 *     PK, routes the #88 `reason` to revLabel, and computes `changes`.
 *   - restoreNodeRevision round-trips the new fields; a LEGACY snapshot (NULL
 *     nodeType sentinel) leaves the live node's new-field values untouched.
 *   - updateNodeRevision sets/clears revLabel, write-gated like
 *     deleteNodeRevision.
 *   - editedByUser resolves editedBy (User PK) → createdBy fallback →
 *     editedByInfo identity strings ('github:<login>' case-insensitive,
 *     'email:<addr>', 'user:<id>'); free-form legacy strings resolve to null.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { generateId } from '../../../lib/id.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let org: { id: string; urn: string };
let admin: { id: string; handle: string | null };
let memory: { id: string; urn: string };

function ctx(overrides: Partial<Context> = {}): Context {
  return { db, roles: ['ADMIN'], userId: admin.id, ...overrides };
}

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({
    data: { id: generateId(), name: 'nv620-org', urn: 'nv620-org' },
  });
  admin = await db.user.create({
    data: { githubId: 6200, githubUsername: 'nv620-admin', handle: 'nv620-admin', roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });
  memory = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:mem`, name: 'mem', class: 'knowledge' },
  });
});

async function makeNode(loc: string, fields: Record<string, unknown> = {}) {
  return db.node.create({
    data: {
      id: generateId(),
      memoryId: memory.id,
      loc,
      name: loc,
      nodeType: 'info',
      ...(fields as object),
    },
  });
}

describe('updateNode snapshot capture (#620)', () => {
  it('snapshots the full curated subset and computes changes', async () => {
    const n = await makeNode('full', {
      content: 'v1 body',
      abstract: 'v1 abs',
      properties: { claudeSkill: { name: 's' } },
      data: { stage: 1 },
      seq: 5,
      isRunnable: true,
      llmModel: 'claude-fable-5',
      aiAgent: 'claude-code',
      tags: ['a'],
    });

    // #1201 — through the TASK door, because this fixture is runnable and the
    // generic updateNode now refuses any edit whose result is still a runnable
    // node. The subject of this test is unchanged (what the revision captures);
    // only the door it goes through moved.
    await (
      resolvers.Mutation as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
    ).updateTaskNode(
      {},
      { input: { id: n.id, content: 'v2 body', tags: ['a', 'b'], reason: 'tighten wording' } },
      ctx(),
    );

    const revisions = await db.nodeRevision.findMany({ where: { nodeId: n.id } });
    expect(revisions).toHaveLength(1);
    const v = revisions[0];
    // Pre-edit state, full subset.
    expect(v.content).toBe('v1 body');
    expect(v.abstract).toBe('v1 abs');
    expect(v.nodeType).toBe('info');
    expect(v.isLink).toBe(false);
    expect(v.properties).toEqual({ claudeSkill: { name: 's' } });
    expect(v.data).toEqual({ stage: 1 });
    expect(v.seq).toBe(5);
    expect(v.isRunnable).toBe(true);
    // #1201 — `role` joined the curated subset. NULL here (this fixture is
    // governed by its capability, not a label), and it is asserted rather than
    // left out because the escalation #1202 exists for is CLEARING a role: a
    // history that cannot show the role cannot show the un-governing.
    expect(v.role).toBeNull();
    expect(v.llmModel).toBe('claude-fable-5');
    expect(v.aiAgent).toBe('claude-code');
    // #620 editor split + reason routing + change list.
    expect(v.editedBy).toBe(admin.id);
    expect(v.editedByInfo).toBeNull();
    expect(v.revLabel).toBe('tighten wording');
    expect(v.changes).toEqual(['content', 'tags']);
  });

  it('does not report an unchanged supplied field in changes', async () => {
    const n = await makeNode('same', { content: 'stable', description: 'd' });
    await resolvers.Mutation.updateNode(
      {},
      { input: { id: n.id, content: 'stable', description: 'd2' } } as never,
      ctx(),
    );
    const [v] = await db.nodeRevision.findMany({ where: { nodeId: n.id } });
    expect(v.changes).toEqual(['description']);
  });
});

describe('#1323 current revision contract', () => {
  it('initializes the complete at-rest state baseline for direct/raw inserts', async () => {
    const n = await makeNode('revision-insert-baseline', { content: 'fresh bytes' });
    expect(n.revisionContentHash).toMatch(/^[0-9a-f]{32}$/);
  });

  it('reconciles a metadata-only write that bypasses a revisioned writer', async () => {
    const n = await makeNode('revision-metadata-drift', { data: { stage: 1 } });
    await db.node.update({ where: { id: n.id }, data: { data: { stage: 2 } } });

    const drifted = await db.node.findUniqueOrThrow({ where: { id: n.id } });
    expect(await resolvers.Node.revision(drifted as never, {}, ctx())).toBe(2);
    expect(await db.nodeRevision.findUniqueOrThrow({
      where: { nodeId_revNo: { nodeId: n.id, revNo: 1 } },
    })).toMatchObject({
      data: { stage: 2 },
      revLabel: 'Reconciled state changed outside a revisioned writer (#1323)',
    });
  });

  it('applies an ownerRepo-only update without inventing a revision', async () => {
    const n = await makeNode('revision-owner-repo-only', { ownerRepo: 'before/repo' });
    const updated = await resolvers.Mutation.updateNode(
      {},
      { input: { id: n.id, ownerRepo: 'after/repo' } } as never,
      ctx(),
    );

    expect(updated).toMatchObject({ ownerRepo: 'after/repo', revSeq: 1 });
    expect(await db.nodeRevision.count({ where: { nodeId: n.id } })).toBe(0);
  });

  it('upgrades existing counters and hashes once during post-push', async () => {
    const fresh = await makeNode('revision-post-push-fresh', { content: 'before db push' });
    await db.node.update({
      where: { id: fresh.id },
      data: { revSeq: 0, revisionContentHash: null },
    });

    const withHistory = await makeNode('revision-post-push-history', { content: 'current old live' });
    await db.nodeRevision.create({
      data: {
        id: generateId(),
        nodeId: withHistory.id,
        memoryId: memory.id,
        loc: withHistory.loc,
        name: withHistory.name,
        content: 'snapshot one',
        tags: [],
        revNo: 1,
      },
    });
    await db.node.update({
      where: { id: withHistory.id },
      data: { revSeq: 1, revisionContentHash: null },
    });

    const postPushSql = readFileSync(new URL('../../../../prisma/post-push.sql', import.meta.url), 'utf8');
    expect(postPushSql).toContain(
      'SET "rev_seq" = "rev_seq" + 1,\n    "revision_content_hash" = hadron_node_revision_state_hash("nodes")',
    );
    await db.$executeRawUnsafe(`
      UPDATE "nodes"
      SET "rev_seq" = "rev_seq" + 1,
          "revision_content_hash" = hadron_node_revision_state_hash("nodes")
      WHERE "revision_content_hash" IS NULL
    `);

    expect(await db.node.findUniqueOrThrow({ where: { id: fresh.id } })).toMatchObject({ revSeq: 1 });
    expect(await db.node.findUniqueOrThrow({ where: { id: withHistory.id } })).toMatchObject({ revSeq: 2 });

    await db.node.update({ where: { id: fresh.id }, data: { content: 'after raw writer' } });
    const drifted = await db.node.findUniqueOrThrow({ where: { id: fresh.id } });
    expect(await resolvers.Node.revision(drifted as never, {}, ctx())).toBe(2);
    expect(await db.nodeRevision.count({ where: { nodeId: fresh.id } })).toBe(1);

    const updated = await resolvers.Mutation.updateNode(
      {},
      { input: { id: withHistory.id, content: 'next live' } } as never,
      ctx(),
    );
    expect(updated.revSeq).toBe(3);
    expect(
      (await db.nodeRevision.findMany({ where: { nodeId: withHistory.id }, orderBy: { revNo: 'asc' } })).map(
        (revision) => revision.revNo,
      ),
    ).toEqual([1, 2]);
  });

  it('starts at 1, exposes the live revision, and snapshots the predecessor', async () => {
    const n = await makeNode('revision-contract', { content: 'v1' });
    expect(await resolvers.Node.revision(n as never, {}, ctx())).toBe(1);

    const updated = await resolvers.Mutation.updateNode(
      {},
      { input: { id: n.id, content: 'v2' } } as never,
      ctx(),
    );
    expect(await resolvers.Node.revision(updated as never, {}, ctx())).toBe(2);
    const [snapshot] = await db.nodeRevision.findMany({ where: { nodeId: n.id } });
    expect(snapshot).toMatchObject({ revNo: 1, content: 'v1' });
  });

  it('serializes concurrent writes into unique predecessor snapshots', async () => {
    const n = await makeNode('revision-race', { content: 'v1' });
    await resolvers.Node.revision(n as never, {}, ctx());

    await Promise.all([
      resolvers.Mutation.updateNode({}, { input: { id: n.id, content: 'v2-a' } } as never, ctx()),
      resolvers.Mutation.updateNode({}, { input: { id: n.id, content: 'v2-b' } } as never, ctx()),
    ]);

    const live = await db.node.findUniqueOrThrow({ where: { id: n.id } });
    const snapshots = await db.nodeRevision.findMany({
      where: { nodeId: n.id },
      orderBy: { revNo: 'asc' },
    });
    expect(live.revSeq).toBe(3);
    expect(snapshots.map((r) => r.revNo)).toEqual([1, 2]);
    expect(snapshots[0].content).toBe('v1');
    expect(['v2-a', 'v2-b']).toContain(snapshots[1].content);
    expect(['v2-a', 'v2-b']).toContain(live.content);
    expect(live.content).not.toBe(snapshots[1].content);
  });

  it('returns reconciled content and revision from the same canonical read', async () => {
    const n = await makeNode('revision-read-consistency', { content: 'v1' });
    await resolvers.Query.node({}, { ref: n.id, raw: true }, ctx());
    await db.node.update({ where: { id: n.id }, data: { content: 'off-road v2' } });

    const read = await resolvers.Query.node({}, { ref: n.id, raw: true }, ctx());
    expect(read?.content).toBe('off-road v2');
    expect(await resolvers.Node.revision(read as never, {}, ctx())).toBe(2);
  });

  it('reconciles an off-road body returned by findNodes before exposing revision', async () => {
    const n = await makeNode('revision-find-nodes', { content: 'v1' });
    await db.node.update({ where: { id: n.id }, data: { content: 'off-road search body' } });

    const result = await resolvers.Query.findNodes(
      {},
      { filter: { memoryIds: [memory.id] } },
      ctx(),
    );
    const hit = result.hits.find((candidate) => candidate.node.id === n.id)!;
    expect(hit.node.content).toBe('off-road search body');
    expect(await resolvers.Node.revision(hit.node as never, {}, ctx())).toBe(2);
    expect(await db.nodeRevision.count({ where: { nodeId: n.id } })).toBe(1);
  });
});

describe('restoreNodeRevision round-trip (#620)', () => {
  it('restores the new curated fields verbatim', async () => {
    const n = await makeNode('rt', {
      content: 'v1',
      properties: { p: 1 },
      data: { d: 1 },
      seq: 1,
      // #1201 — deliberately NOT runnable. `isRunnable` is a governed signal
      // now, so flipping it here would make both the update and the restore
      // governance-changing writes, which the generic surface refuses. Its
      // capture and restore are covered in resolvers.governedRole1201.test.ts,
      // where the refusal is the subject rather than an obstacle. What this
      // test is about — the OTHER curated fields restoring verbatim — is
      // unchanged.
      isRunnable: false,
    });
    await resolvers.Mutation.updateNode(
      {},
      { input: { id: n.id, content: 'v2', properties: { p: 2 }, data: { d: 2 }, seq: 9 } } as never,
      ctx(),
    );
    const [v1snap] = await db.nodeRevision.findMany({ where: { nodeId: n.id } });

    await resolvers.Mutation.restoreNodeRevision({}, { revisionId: v1snap.id }, ctx());

    const restored = await db.node.findUniqueOrThrow({ where: { id: n.id } });
    expect(restored.content).toBe('v1');
    expect(restored.properties).toEqual({ p: 1 });
    expect(restored.data).toEqual({ d: 1 });
    expect(restored.seq).toBe(1);
    // The pre-restore snapshot recorded what the restore rewrote.
    const preRestore = await db.nodeRevision.findFirst({
      where: { nodeId: n.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(preRestore?.changes).toEqual(
      expect.arrayContaining(['content', 'properties', 'data', 'seq']),
    );
  });

  it('a LEGACY snapshot (NULL nodeType sentinel) leaves uncaptured fields untouched', async () => {
    const n = await makeNode('legacy', {
      content: 'current',
      properties: { keep: true },
      data: { keep: 1 },
      seq: 7,
    });
    // Simulate a pre-#620 snapshot: none of the new columns captured.
    const legacy = await db.nodeRevision.create({
      data: {
        id: generateId(),
        nodeId: n.id,
        memoryId: memory.id,
        loc: n.loc,
        name: 'old-name',
        content: 'old body',
        tags: [],
      },
    });

    await resolvers.Mutation.restoreNodeRevision({}, { revisionId: legacy.id }, ctx());

    const restored = await db.node.findUniqueOrThrow({ where: { id: n.id } });
    // Captured fields restore…
    expect(restored.name).toBe('old-name');
    expect(restored.content).toBe('old body');
    // …but the uncaptured #620 fields are NOT wiped to NULL.
    expect(restored.properties).toEqual({ keep: true });
    expect(restored.data).toEqual({ keep: 1 });
    expect(restored.seq).toBe(7);
    expect(restored.nodeType).toBe('info');
  });
});

describe('updateNodeRevision (#620 revLabel)', () => {
  let revisionId: string;

  beforeEach(async () => {
    const n = await makeNode('lbl', { content: 'v1' });
    await resolvers.Mutation.updateNode({}, { input: { id: n.id, content: 'v2' } } as never, ctx());
    const [v] = await db.nodeRevision.findMany({ where: { nodeId: n.id } });
    revisionId = v.id;
  });

  it('sets and clears the label', async () => {
    const labeled = await resolvers.Mutation.updateNodeRevision(
      {}, { revisionId, revLabel: 'the good one' }, ctx(),
    );
    expect(labeled.revLabel).toBe('the good one');

    const cleared = await resolvers.Mutation.updateNodeRevision(
      {}, { revisionId, revLabel: null }, ctx(),
    );
    expect(cleared.revLabel).toBeNull();
  });

  it('omitting revLabel preserves the existing label (omit-means-preserve)', async () => {
    await resolvers.Mutation.updateNodeRevision({}, { revisionId, revLabel: 'keep me' }, ctx());
    const untouched = await resolvers.Mutation.updateNodeRevision({}, { revisionId }, ctx());
    expect(untouched.revLabel).toBe('keep me');
  });

  it('rejects a label over the 500-char cap', async () => {
    await expect(
      resolvers.Mutation.updateNodeRevision({}, { revisionId, revLabel: 'x'.repeat(501) }, ctx()),
    ).rejects.toThrow('500-character cap');
  });

  it('answers NOT_FOUND for a soft-deleted node (read-gate parity, #618)', async () => {
    const revision = await db.nodeRevision.findUniqueOrThrow({ where: { id: revisionId } });
    await db.node.update({ where: { id: revision.nodeId }, data: { deletedAt: new Date() } });
    await expect(
      resolvers.Mutation.updateNodeRevision({}, { revisionId, revLabel: 'x' }, ctx()),
    ).rejects.toThrow('Node revision not found');
  });

  it('answers NOT_FOUND for a snapshot captured in an unreadable memory (read-gate parity, #602)', async () => {
    // A snapshot whose capture memory belongs to ANOTHER org: even a caller
    // with write access to the node's current memory must not read it back.
    const otherOrg = await db.organization.create({
      data: { id: generateId(), name: 'nv620-other', urn: 'nv620-other' },
    });
    const restrictedMem = await db.memory.create({
      data: { id: generateId(), organizationId: otherOrg.id, urn: 'nv620-other:secret', name: 'secret', class: 'knowledge' },
    });
    const revision = await db.nodeRevision.findUniqueOrThrow({ where: { id: revisionId } });
    const secretSnap = await db.nodeRevision.create({
      data: {
        id: generateId(),
        nodeId: revision.nodeId,
        memoryId: restrictedMem.id,
        loc: 'lbl',
        name: 'secret-era',
      },
    });
    // Org-scoped admin (not global): write access to the node's memory via
    // org role, but no read on the other org's memory.
    await expect(
      resolvers.Mutation.updateNodeRevision(
        {}, { revisionId: secretSnap.id, revLabel: 'x' },
        { db, roles: [], userId: admin.id } as never,
      ),
    ).rejects.toThrow('Node revision not found');
  });

  it('throws NOT_FOUND for an unknown revisionId', async () => {
    await expect(
      resolvers.Mutation.updateNodeRevision({}, { revisionId: 'nope', revLabel: 'x' }, ctx()),
    ).rejects.toThrow('Node revision not found');
  });

  it('denies a caller without write access to the node memory', async () => {
    const outsider = await db.user.create({
      data: { githubId: 6201, githubUsername: 'nv620-out', roles: ['READER'] },
    });
    await expect(
      resolvers.Mutation.updateNodeRevision(
        {}, { revisionId, revLabel: 'x' }, ctx({ roles: ['READER'], userId: outsider.id }),
      ),
    ).rejects.toThrow();
  });
});

describe('editedByUser resolution (#619/#620)', () => {
  const resolve = (nv: Record<string, unknown>) =>
    resolvers.NodeRevision.editedByUser(nv as never, null, ctx());

  it('resolves editedBy as a User PK first', async () => {
    expect(await resolve({ editedBy: admin.id })).toEqual({
      handle: 'nv620-admin',
      urn: 'hrn:user:nv620-admin',
    });
  });

  it('falls back to createdBy when editedBy does not resolve (#619)', async () => {
    expect(
      await resolve({ editedBy: null, createdBy: admin.id, editedByInfo: 'github:nv620-admin' }),
    ).toEqual({ handle: 'nv620-admin', urn: 'hrn:user:nv620-admin' });
  });

  it("resolves a 'github:<login>' editedByInfo via githubUsername, case-insensitively (#619)", async () => {
    expect(await resolve({ editedByInfo: 'github:NV620-Admin' })).toEqual({
      handle: 'nv620-admin',
      urn: 'hrn:user:nv620-admin',
    });
  });

  it("resolves an 'email:<addr>' editedByInfo via the account email", async () => {
    const mailUser = await db.user.create({
      data: { email: 'nv620@example.com', handle: 'nv620-mail', roles: ['READER'] },
    });
    expect(await resolve({ editedByInfo: 'email:NV620@example.com' })).toEqual({
      handle: 'nv620-mail',
      urn: 'hrn:user:nv620-mail',
    });
    void mailUser;
  });

  it("resolves a 'user:<id>' editedByInfo by PK", async () => {
    expect(await resolve({ editedByInfo: `user:${admin.id}` })).toEqual({
      handle: 'nv620-admin',
      urn: 'hrn:user:nv620-admin',
    });
  });

  it('returns null for a legacy free-form reason / commit message', async () => {
    expect(await resolve({ editedByInfo: 'rename across corpus' })).toBeNull();
    expect(await resolve({ editedBy: null, createdBy: null, editedByInfo: null })).toBeNull();
  });

  it('does not resolve an unlinked github login', async () => {
    expect(await resolve({ editedByInfo: 'github:not-a-member' })).toBeNull();
  });
});
