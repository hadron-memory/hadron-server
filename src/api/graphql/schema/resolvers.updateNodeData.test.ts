/**
 * updateNodeData — shallow-merge a JSON patch into a node's `data` bag
 * (issue #366). Covers the merge semantics (patch wins, keys preserved,
 * no-prior-data, nested-value replacement), node resolution by ID and URN,
 * input validation, write-auth gating, and a version snapshot on write.
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
let admin: { id: string };
let member: { id: string };
let memory: { id: string; urn: string };

function ctx(overrides: Partial<Context> = {}): Context {
  return { db, roles: ['ADMIN'], userId: admin.id, ...overrides };
}

async function makeNode(loc: string, data: unknown | null) {
  return db.node.create({
    data: { id: generateId(), memoryId: memory.id, loc, name: loc, data: data as never },
  });
}

const call = (nodeRef: string, data: unknown, c: Context = ctx()) =>
  resolvers.Mutation.updateNodeData({}, { nodeRef, data } as never, c);

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({
    data: { id: generateId(), name: 'und-org', urn: 'und-org' },
  });
  admin = await db.user.create({
    data: { githubId: 8801, githubUsername: 'und-admin', roles: ['ADMIN'] },
  });
  member = await db.user.create({
    data: { githubId: 8802, githubUsername: 'und-member', roles: ['READER'] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });
  memory = await resolvers.Mutation.createMemory({}, { orgId: org.id, name: 'und-mem' }, ctx());
});

describe('updateNodeData — merge semantics', () => {
  it('merges new keys into existing data, preserving untouched keys', async () => {
    const node = await makeNode('n1', { a: 1, b: 2 });
    const res = await call(node.id, { c: 3 });
    expect(res.data).toEqual({ a: 1, b: 2, c: 3 });
  });

  it('the patch wins on key collision (caller overwrites existing value)', async () => {
    const node = await makeNode('n2', { a: 1, b: 2 });
    const res = await call(node.id, { b: 99 });
    expect(res.data).toEqual({ a: 1, b: 99 });
  });

  it('uses the patch verbatim when the node has no prior data', async () => {
    const node = await makeNode('n3', null);
    const res = await call(node.id, { hello: 'world' });
    expect(res.data).toEqual({ hello: 'world' });
  });

  it('replaces a nested value wholesale (shallow, not deep, merge)', async () => {
    const node = await makeNode('n4', { nested: { x: 1, y: 2 }, top: 'keep' });
    const res = await call(node.id, { nested: { z: 3 } });
    // Shallow merge: the whole `nested` object is replaced, not deep-merged.
    expect(res.data).toEqual({ nested: { z: 3 }, top: 'keep' });
  });

  it('persists the merge (re-read returns merged data)', async () => {
    const node = await makeNode('n5', { a: 1 });
    await call(node.id, { b: 2 });
    const reread = await db.node.findUnique({ where: { id: node.id } });
    expect(reread!.data).toEqual({ a: 1, b: 2 });
  });
});

describe('updateNodeData — resolution + validation', () => {
  it('resolves the node by fully-qualified URN', async () => {
    const node = await makeNode('byurn', { a: 1 });
    const res = await call(`hrn:node:${memory.urn}:byurn`, { b: 2 });
    expect(res.data).toEqual({ a: 1, b: 2 });
  });

  it('throws NODE_NOT_FOUND for an unknown node id', async () => {
    await expect(call(generateId(), { a: 1 })).rejects.toThrow(/not found/i);
  });

  it('rejects a non-object patch (array)', async () => {
    const node = await makeNode('n6', { a: 1 });
    await expect(call(node.id, [1, 2, 3])).rejects.toThrow(/must be a JSON object/i);
  });

  it('rejects a scalar patch', async () => {
    const node = await makeNode('n7', { a: 1 });
    await expect(call(node.id, 42)).rejects.toThrow(/must be a JSON object/i);
  });
});

describe('updateNodeData — auth + versioning', () => {
  it('a caller without write access is refused', async () => {
    const node = await makeNode('n8', { a: 1 });
    await expect(
      call(node.id, { b: 2 }, ctx({ roles: ['READER'], userId: member.id })),
    ).rejects.toThrow();
    // Data unchanged after the refusal.
    const reread = await db.node.findUnique({ where: { id: node.id } });
    expect(reread!.data).toEqual({ a: 1 });
  });

  it('snapshots a NodeVersion on write (undo point)', async () => {
    const node = await makeNode('n9', { a: 1 });
    await call(node.id, { b: 2 });
    const versions = await db.nodeVersion.findMany({ where: { nodeId: node.id } });
    expect(versions.length).toBeGreaterThanOrEqual(1);
  });

  // #88/#620: an explicit reason lands in the version snapshot's revLabel
  // (it historically squatted in editedBy, which now carries the editing
  // user's PK) — so CLI edits via updateNodeData carry rationale into history.
  it('records an explicit reason in the version snapshot (revLabel)', async () => {
    const node = await makeNode('n10', { a: 1 });
    await resolvers.Mutation.updateNodeData(
      {},
      { nodeRef: node.id, data: { b: 2 }, reason: 'restore data' } as never,
      ctx(),
    );
    const versions = await db.nodeVersion.findMany({ where: { nodeId: node.id } });
    expect(versions[0]!.revLabel).toBe('restore data');
    expect(versions[0]!.editedBy).toBe(admin.id);
    expect(versions[0]!.changes).toEqual(['data']);
  });

  it('falls back to the caller identity when no reason is given', async () => {
    const node = await makeNode('n11', { a: 1 });
    await call(node.id, { b: 2 });
    const versions = await db.nodeVersion.findMany({ where: { nodeId: node.id } });
    expect(versions[0]!.editedBy).toBe(admin.id);
  });
});
