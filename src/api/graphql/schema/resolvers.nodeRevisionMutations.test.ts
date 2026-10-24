/**
 * Integration tests for the node revision-history write surface (#617):
 *   - deleteNodeRevision(revisionId): delete one snapshot; NOT_FOUND on miss.
 *   - clearNodeHistory(nodeRef): delete all snapshots, return the count.
 *   - restoreNodeRevision(revisionId, truncate): the new truncate branch —
 *     restore + collapse newer history in one transaction, no pre-restore
 *     snapshot; the selected row is kept (exclusive boundary).
 *   - nodeRevision(revisionId): single-snapshot read (Display), access-gated.
 *
 * Auth: reads gate on the node's memory READ access, writes on WRITE access
 * (same shape as nodeRevisions / restoreNodeRevision). A non-member is denied.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

let org: { id: string; urn: string };
let memory: { id: string; urn: string };
let node: { id: string; loc: string };
let adminUser: { id: string };
let userMember: { id: string };
let userOutsider: { id: string };

// A global ADMIN sees every fixture memory and passes the write gate.
function adminCtx(): Context {
  return { db, roles: ['ADMIN'], userId: adminUser.id } as Context;
}
function memberCtx(): Context {
  return { db, roles: ['READER'], userId: userMember.id } as Context;
}
function outsiderCtx(): Context {
  return { db, roles: ['READER'], userId: userOutsider.id } as Context;
}

// Three snapshots at monotonically increasing createdAt so the truncate
// boundary (createdAt strictly greater than the selected row) is testable.
const T1 = new Date('2026-01-01T00:00:00Z');
const T2 = new Date('2026-01-02T00:00:00Z');
const T3 = new Date('2026-01-03T00:00:00Z');
let v1: { id: string };
let v2: { id: string };
let v3: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  adminUser = await db.user.create({ data: { roles: ['ADMIN'] } });

  org = await db.organization.create({
    data: { id: generateId(), name: 'nvm-org', urn: 'nvm-org' },
  });
  memory = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:mem`, name: 'mem', class: 'knowledge' },
  });
  node = await db.node.create({
    data: { id: generateId(), memoryId: memory.id, loc: 'guide', name: 'Current', content: 'current body' },
  });
  v1 = await db.nodeRevision.create({
    data: { id: generateId(), nodeId: node.id, memoryId: memory.id, loc: 'guide', name: 'v1', content: 'body-1', createdAt: T1 },
  });
  v2 = await db.nodeRevision.create({
    data: { id: generateId(), nodeId: node.id, memoryId: memory.id, loc: 'guide', name: 'v2', content: 'body-2', createdAt: T2 },
  });
  v3 = await db.nodeRevision.create({
    data: { id: generateId(), nodeId: node.id, memoryId: memory.id, loc: 'guide', name: 'v3', content: 'body-3', createdAt: T3 },
  });

  userMember = await db.user.create({ data: { githubId: 7201, githubUsername: 'nvm-mem', roles: ['READER'] } });
  userOutsider = await db.user.create({ data: { githubId: 7202, githubUsername: 'nvm-out', roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: userMember.id, role: 'READER' } });
});

describe('deleteNodeRevision (#617)', () => {
  it('deletes a single snapshot and returns true', async () => {
    const ok = await resolvers.Mutation.deleteNodeRevision(null, { revisionId: v2.id }, adminCtx());
    expect(ok).toBe(true);
    const remaining = await db.nodeRevision.findMany({ where: { nodeId: node.id } });
    expect(remaining.map((r) => r.id).sort()).toEqual([v1.id, v3.id].sort());
  });

  it('throws NOT_FOUND for an unknown revisionId', async () => {
    await expect(
      resolvers.Mutation.deleteNodeRevision(null, { revisionId: 'cnope00000000000000000000' }, adminCtx()),
    ).rejects.toThrow('Node revision not found');
  });

  it('denies a non-member (no write access)', async () => {
    await expect(
      resolvers.Mutation.deleteNodeRevision(null, { revisionId: v2.id }, outsiderCtx()),
    ).rejects.toThrow('Forbidden');
    // No row was deleted.
    expect(await db.nodeRevision.count({ where: { nodeId: node.id } })).toBe(3);
  });
});

describe('clearNodeHistory (#617)', () => {
  it('deletes all snapshots and returns the count (by ID)', async () => {
    const count = await resolvers.Mutation.clearNodeHistory(null, { nodeRef: node.id }, adminCtx());
    expect(count).toBe(3);
    expect(await db.nodeRevision.count({ where: { nodeId: node.id } })).toBe(0);
  });

  it('accepts a fully-qualified node URN', async () => {
    const count = await resolvers.Mutation.clearNodeHistory(
      null, { nodeRef: `${memory.urn}:${node.loc}` }, adminCtx(),
    );
    expect(count).toBe(3);
  });

  it('throws NODE_NOT_FOUND for an unknown nodeRef', async () => {
    await expect(
      resolvers.Mutation.clearNodeHistory(null, { nodeRef: 'cnope00000000000000000000' }, adminCtx()),
    ).rejects.toThrow('Node not found');
  });

  it('denies a non-member (no write access)', async () => {
    await expect(
      resolvers.Mutation.clearNodeHistory(null, { nodeRef: node.id }, outsiderCtx()),
    ).rejects.toThrow('Forbidden');
    expect(await db.nodeRevision.count({ where: { nodeId: node.id } })).toBe(3);
  });

  // Cleanup op: a soft-deleted node still owns residual history an owner can
  // purge (contrast the read surfaces, which hide tombstoned history).
  it('clears history for a soft-deleted node (cleanup reachable on tombstones)', async () => {
    await db.node.update({ where: { id: node.id }, data: { deletedAt: new Date() } });
    const count = await resolvers.Mutation.clearNodeHistory(null, { nodeRef: node.id }, adminCtx());
    expect(count).toBe(3);
    expect(await db.nodeRevision.count({ where: { nodeId: node.id } })).toBe(0);
  });
});

describe('restoreNodeRevision truncate (#617)', () => {
  it('truncate:true restores + deletes NEWER snapshots, keeps the selected row and older', async () => {
    const restored = await resolvers.Mutation.restoreNodeRevision(
      null, { revisionId: v2.id, truncate: true }, adminCtx(),
    );
    // Node restored to v2.
    expect(restored.name).toBe('v2');
    expect(restored.content).toBe('body-2');
    expect((restored as { revSeq: number }).revSeq).toBe(2);
    // History: v3 (newer) deleted, v2 (selected) + v1 (older) kept, NO
    // pre-restore snapshot added.
    const remaining = await db.nodeRevision.findMany({ where: { nodeId: node.id } });
    expect(remaining.map((r) => r.id).sort()).toEqual([v1.id, v2.id].sort());
  });

  it('truncate:false (default) restores AND adds a pre-restore snapshot', async () => {
    const restored = await resolvers.Mutation.restoreNodeRevision(
      null, { revisionId: v2.id }, adminCtx(),
    );
    expect(restored.name).toBe('v2');
    // 3 originals + 1 snapshot of the pre-restore ("Current") state = 4.
    const all = await db.nodeRevision.findMany({ where: { nodeId: node.id } });
    expect(all).toHaveLength(4);
    expect(all.some((r) => r.name === 'Current' && r.content === 'current body')).toBe(true);
  });

  it('truncate on the NEWEST revision deletes nothing newer (selected kept)', async () => {
    await resolvers.Mutation.restoreNodeRevision(null, { revisionId: v3.id, truncate: true }, adminCtx());
    const remaining = await db.nodeRevision.findMany({ where: { nodeId: node.id } });
    // All three kept (none is newer than v3), no pre-restore snapshot.
    expect(remaining).toHaveLength(3);
  });
});

describe('nodeRevision query (#617 Display)', () => {
  it('returns a single snapshot by id for a reader', async () => {
    const v = await resolvers.Query.nodeRevision(null, { revisionId: v2.id }, memberCtx());
    expect(v?.id).toBe(v2.id);
    expect(v?.name).toBe('v2');
  });

  it('returns null for an unknown revisionId (no existence disclosure)', async () => {
    const v = await resolvers.Query.nodeRevision(null, { revisionId: 'cnope00000000000000000000' }, adminCtx());
    expect(v).toBeNull();
  });

  it('returns null for a non-member (no existence leak)', async () => {
    const v = await resolvers.Query.nodeRevision(null, { revisionId: v2.id }, outsiderCtx());
    expect(v).toBeNull();
  });

  it('returns null when the node is soft-deleted (no tombstoned-history leak)', async () => {
    await db.node.update({ where: { id: node.id }, data: { deletedAt: new Date() } });
    const v = await resolvers.Query.nodeRevision(null, { revisionId: v2.id }, memberCtx());
    expect(v).toBeNull();
  });

  it('resolves editedBy to a user editor (handle + urn only)', async () => {
    const editor = await db.user.create({ data: { githubId: 7301, githubUsername: 'nvm-ed', handle: 'nvm-editor', name: 'Secret Name', email: 'secret@x.com', roles: ['READER'] } });
    await db.nodeRevision.update({ where: { id: v2.id }, data: { editedBy: editor.id } });
    const parent = await db.nodeRevision.findUniqueOrThrow({ where: { id: v2.id } });
    const res = await resolvers.NodeRevision.editedByUser(parent, null, adminCtx());
    expect(res).toEqual({ handle: 'nvm-editor', urn: 'hrn:user:nvm-editor' });
    // Never exposes name/email — the type has no such fields.
    expect(res).not.toHaveProperty('name');
    expect(res).not.toHaveProperty('email');
  });

  it('returns null when editedBy is an app/client principal (not a user id)', async () => {
    const res = await resolvers.NodeRevision.editedByUser({ editedBy: 'capp0000000000000000000x' }, null, adminCtx());
    expect(res).toBeNull();
  });

  it('returns null when editedBy is unset', async () => {
    const res = await resolvers.NodeRevision.editedByUser({ editedBy: null }, null, adminCtx());
    expect(res).toBeNull();
  });

  // spec 047: every user now has a handle (NOT NULL), so an editor always
  // resolves to its `@handle` — the handle-less/null fallback is unreachable.
  it('resolves the editor with its handle', async () => {
    const editor = await db.user.create({ data: { githubId: 7302, githubUsername: 'nvm', roles: ['READER'] } });
    const res = await resolvers.NodeRevision.editedByUser({ editedBy: editor.id }, null, adminCtx());
    expect(res).toMatchObject({ handle: editor.handle, urn: `hrn:user:${editor.handle}` });
  });

  it('returns null for a snapshot captured in a memory the caller cannot read (moved-node leak)', async () => {
    const otherOrg = await db.organization.create({
      data: { id: generateId(), name: 'nvm-other', urn: 'nvm-other' },
    });
    const restrictedMem = await db.memory.create({
      data: { id: generateId(), organizationId: otherOrg.id, urn: 'nvm-other:secret', name: 'secret', class: 'knowledge' },
    });
    const secretSnap = await db.nodeRevision.create({
      data: { id: generateId(), nodeId: node.id, memoryId: restrictedMem.id, loc: 'guide', name: 'secret-era' },
    });
    // Member can read the node's current memory but not the snapshot's memory.
    const v = await resolvers.Query.nodeRevision(null, { revisionId: secretSnap.id }, memberCtx());
    expect(v).toBeNull();
  });
});
