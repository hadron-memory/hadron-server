/**
 * updateNodeProperties — shallow-merge a JSON patch into a node's structured
 * `properties` (#742), the plaintext analogue of updateNodeData. Covers the
 * merge semantics, node resolution by ID + URN, input validation, write-auth
 * gating, a revision snapshot on write, and — the one thing updateNodeData
 * doesn't do — schema-conformance enforcement on the MERGED result.
 *
 * The encrypted-memory case (properties merges + enforces schema with NO active
 * session, because properties is plaintext at rest) lives in
 * resolvers.encryption.test.ts, which already has the session scaffolding.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { generateId } from '../../../lib/id.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let org: { id: string };
let admin: { id: string };
let member: { id: string };
let memory: { id: string; urn: string };

function ctx(overrides: Partial<Context> = {}): Context {
  return { db, roles: ['ADMIN'], userId: admin.id, ...overrides };
}

async function makeNode(loc: string, properties: unknown | null, objectType?: string) {
  return db.node.create({
    data: { id: generateId(), memoryId: memory.id, loc, name: loc, properties: properties as never, ...(objectType ? { objectType } : {}) } as never,
  });
}

const call = (nodeRef: string, properties: unknown, c: Context = ctx()) =>
  (resolvers.Mutation as any).updateNodeProperties({}, { nodeRef, properties }, c);

const updateMemory = (input: Record<string, unknown>) => (resolvers.Mutation as any).updateMemory(null, input, ctx());

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'unp-org', urn: 'unp-org' } });
  admin = await db.user.create({ data: { githubId: 8901, githubUsername: 'unp-admin', roles: ['ADMIN'] } });
  member = await db.user.create({ data: { githubId: 8902, githubUsername: 'unp-member', roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  memory = await resolvers.Mutation.createMemory({}, { orgId: org.id, name: 'unp-mem' }, ctx());
});

describe('updateNodeProperties — merge semantics', () => {
  it('merges new keys into existing properties, preserving untouched keys', async () => {
    const node = await makeNode('n1', { a: 1, b: 2 });
    const res = await call(node.id, { c: 3 });
    expect(res.properties).toEqual({ a: 1, b: 2, c: 3 });
  });

  it('the patch wins on key collision', async () => {
    const node = await makeNode('n2', { a: 1, b: 2 });
    const res = await call(node.id, { b: 99 });
    expect(res.properties).toEqual({ a: 1, b: 99 });
  });

  it('uses the patch verbatim when the node has no prior properties', async () => {
    const node = await makeNode('n3', null);
    const res = await call(node.id, { hello: 'world' });
    expect(res.properties).toEqual({ hello: 'world' });
  });

  it('replaces a nested value wholesale (shallow, not deep, merge)', async () => {
    const node = await makeNode('n4', { nested: { x: 1, y: 2 }, top: 'keep' });
    const res = await call(node.id, { nested: { z: 3 } });
    expect(res.properties).toEqual({ nested: { z: 3 }, top: 'keep' });
  });

  it('persists the merge (re-read returns merged properties)', async () => {
    const node = await makeNode('n5', { a: 1 });
    await call(node.id, { b: 2 });
    const reread = await db.node.findUnique({ where: { id: node.id } });
    expect(reread!.properties).toEqual({ a: 1, b: 2 });
  });

  it('leaves `data` untouched (properties and data are distinct columns)', async () => {
    const node = await db.node.create({
      data: { id: generateId(), memoryId: memory.id, loc: 'n5b', name: 'n5b', properties: { a: 1 } as never, data: { keep: true } as never },
    });
    const res = await call(node.id, { b: 2 });
    expect(res.properties).toEqual({ a: 1, b: 2 });
    expect(res.data).toEqual({ keep: true });
  });
});

describe('updateNodeProperties — resolution + validation', () => {
  it('resolves the node by fully-qualified URN', async () => {
    const node = await makeNode('byurn', { a: 1 });
    const res = await call(`hrn:node:${memory.urn}:byurn`, { b: 2 });
    expect(res.properties).toEqual({ a: 1, b: 2 });
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

describe('updateNodeProperties — auth + versioning', () => {
  it('a caller without write access is refused; properties unchanged', async () => {
    const node = await makeNode('n8', { a: 1 });
    await expect(call(node.id, { b: 2 }, ctx({ roles: ['READER'], userId: member.id }))).rejects.toThrow();
    const reread = await db.node.findUnique({ where: { id: node.id } });
    expect(reread!.properties).toEqual({ a: 1 });
  });

  it('records an explicit reason in the revision snapshot (revLabel)', async () => {
    const node = await makeNode('n9', { a: 1 });
    await (resolvers.Mutation as any).updateNodeProperties({}, { nodeRef: node.id, properties: { b: 2 }, reason: 'patch stage' }, ctx());
    const versions = await db.nodeRevision.findMany({ where: { nodeId: node.id } });
    expect(versions[0]!.revLabel).toBe('patch stage');
    expect(versions[0]!.editedBy).toBe(admin.id);
  });
});

describe('updateNodeProperties — schema conformance (the one thing updateNodeData does not do)', () => {
  const schema = { objectTypes: { competitor: { fields: { name: { type: 'text', required: true }, stage: { type: 'text' } } } } };

  it('accepts a conforming merge on a schema-governed collection', async () => {
    await updateMemory({ id: memory.id, schema });
    const node = await makeNode('c1', { name: 'Letta', stage: 'seed' }, 'competitor');
    // A field-update merge that still satisfies the schema succeeds; `name` (not
    // in the patch) is preserved, so the required field survives the merge.
    const ok = await call(node.id, { stage: 'series-a' });
    expect(ok.properties).toEqual({ name: 'Letta', stage: 'series-a' });
  });

  it('rejects a merge that violates the schema (wrong type on the merged result)', async () => {
    await updateMemory({ id: memory.id, schema: { objectTypes: { competitor: { fields: { name: { type: 'number', required: true } } } } } });
    const node = await makeNode('c2', { name: 42 }, 'competitor');
    // Merge a non-numeric name → violates the number type on the merged result.
    await expect(call(node.id, { name: 'not-a-number' })).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    // The rejected write left properties untouched.
    const reread = await db.node.findUnique({ where: { id: node.id } });
    expect(reread!.properties).toEqual({ name: 42 });
  });

  it('an unschema’d memory accepts any properties merge', async () => {
    const node = await makeNode('free', { a: 1 });
    const res = await call(node.id, { b: 2 });
    expect(res.properties).toEqual({ a: 1, b: 2 });
  });
});
