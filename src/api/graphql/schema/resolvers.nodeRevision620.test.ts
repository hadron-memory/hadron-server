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

    await resolvers.Mutation.updateNode(
      {},
      { input: { id: n.id, content: 'v2 body', tags: ['a', 'b'], reason: 'tighten wording' } } as never,
      ctx(),
    );

    const versions = await db.nodeRevision.findMany({ where: { nodeId: n.id } });
    expect(versions).toHaveLength(1);
    const v = versions[0];
    // Pre-edit state, full subset.
    expect(v.content).toBe('v1 body');
    expect(v.abstract).toBe('v1 abs');
    expect(v.nodeType).toBe('info');
    expect(v.isLink).toBe(false);
    expect(v.properties).toEqual({ claudeSkill: { name: 's' } });
    expect(v.data).toEqual({ stage: 1 });
    expect(v.seq).toBe(5);
    expect(v.isRunnable).toBe(true);
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

describe('restoreNodeRevision round-trip (#620)', () => {
  it('restores the new curated fields verbatim', async () => {
    const n = await makeNode('rt', {
      content: 'v1',
      properties: { p: 1 },
      data: { d: 1 },
      seq: 1,
      isRunnable: true,
    });
    await resolvers.Mutation.updateNode(
      {},
      { input: { id: n.id, content: 'v2', properties: { p: 2 }, data: { d: 2 }, seq: 9, isRunnable: false } } as never,
      ctx(),
    );
    const [v1snap] = await db.nodeRevision.findMany({ where: { nodeId: n.id } });

    await resolvers.Mutation.restoreNodeRevision({}, { revisionId: v1snap.id }, ctx());

    const restored = await db.node.findUniqueOrThrow({ where: { id: n.id } });
    expect(restored.content).toBe('v1');
    expect(restored.properties).toEqual({ p: 1 });
    expect(restored.data).toEqual({ d: 1 });
    expect(restored.seq).toBe(1);
    expect(restored.isRunnable).toBe(true);
    // The pre-restore snapshot recorded what the restore rewrote.
    const preRestore = await db.nodeRevision.findFirst({
      where: { nodeId: n.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(preRestore?.changes).toEqual(
      expect.arrayContaining(['content', 'properties', 'data', 'seq', 'isRunnable']),
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
    const version = await db.nodeRevision.findUniqueOrThrow({ where: { id: revisionId } });
    await db.node.update({ where: { id: version.nodeId }, data: { deletedAt: new Date() } });
    await expect(
      resolvers.Mutation.updateNodeRevision({}, { revisionId, revLabel: 'x' }, ctx()),
    ).rejects.toThrow('Node version not found');
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
    const version = await db.nodeRevision.findUniqueOrThrow({ where: { id: revisionId } });
    const secretSnap = await db.nodeRevision.create({
      data: {
        id: generateId(),
        nodeId: version.nodeId,
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
    ).rejects.toThrow('Node version not found');
  });

  it('throws NOT_FOUND for an unknown revisionId', async () => {
    await expect(
      resolvers.Mutation.updateNodeRevision({}, { revisionId: 'nope', revLabel: 'x' }, ctx()),
    ).rejects.toThrow('Node version not found');
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
