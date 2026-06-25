/**
 * searchReplaceInNodes — bulk literal/regex search-and-replace across selected
 * nodes. Covers selection (nodeIds / memoryIds / prefix), field coverage,
 * dryRun, the name/abstract guards, version snapshots, and regex mode.
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
let memory: { id: string; urn: string };

function ctx(): Context {
  return { db, roles: ['ADMIN'], userId: admin.id };
}

async function makeNode(loc: string, fields: Record<string, unknown>) {
  return db.node.create({
    data: { id: generateId(), memoryId: memory.id, loc, name: loc, ...fields },
  });
}

function call(input: Record<string, unknown>) {
  return resolvers.Mutation.searchReplaceInNodes({}, { input } as never, ctx());
}

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({
    data: { id: generateId(), name: 'sr-org', urn: 'sr-org' },
  });
  admin = await db.user.create({
    data: { githubId: 7777, githubUsername: 'sr-admin', roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });
  memory = await resolvers.Mutation.createMemory({}, { orgId: org.id, name: 'sr-mem' }, ctx());
});

describe('searchReplaceInNodes — selection + replacement', () => {
  it('replaces across content/description/tags for all nodes in a memory', async () => {
    const a = await makeNode('a', {
      content: 'the cat sat',
      description: 'a cat',
      tags: ['cat', 'pet'],
    });
    const b = await makeNode('b', { content: 'no match here' });

    const res = await call({
      oldText: 'cat',
      newText: 'dog',
      memoryIds: [memory.id],
      fields: ['content', 'description', 'tags'],
    });

    // createMemory seeds a root node, so the memory holds more than just a/b;
    // assert on what changed rather than the exact scanned count.
    expect(res.nodesScanned).toBeGreaterThanOrEqual(2);
    expect(res.nodesChanged).toBe(1);
    expect(res.totalReplacements).toBe(3); // content + description + 1 tag

    const updatedA = await db.node.findUnique({ where: { id: a.id } });
    expect(updatedA?.content).toBe('the dog sat');
    expect(updatedA?.description).toBe('a dog');
    expect(updatedA?.tags).toEqual(['dog', 'pet']);

    const updatedB = await db.node.findUnique({ where: { id: b.id } });
    expect(updatedB?.content).toBe('no match here'); // untouched
  });

  it('dryRun reports matches without writing', async () => {
    const a = await makeNode('a', { content: 'cat cat' });
    const res = await call({
      oldText: 'cat',
      newText: 'dog',
      memoryIds: [memory.id],
      fields: ['content'],
      dryRun: true,
    });
    expect(res.dryRun).toBe(true);
    expect(res.totalReplacements).toBe(2);
    expect(res.results[0].fields).toEqual([{ field: 'content', matches: 2 }]);

    const unchanged = await db.node.findUnique({ where: { id: a.id } });
    expect(unchanged?.content).toBe('cat cat'); // nothing written
  });

  it('prefix narrows the memory selection on loc-path boundaries', async () => {
    const under = await makeNode('auth:tokens', { content: 'cat' });
    const parent = await makeNode('auth', { content: 'cat' });
    const sibling = await makeNode('authoring', { content: 'cat' }); // must NOT match
    const other = await makeNode('billing', { content: 'cat' });

    const res = await call({
      oldText: 'cat',
      newText: 'dog',
      memoryIds: [memory.id],
      prefix: 'auth',
      fields: ['content'],
    });

    expect(res.nodesChanged).toBe(2); // 'auth' + 'auth:tokens'
    expect((await db.node.findUnique({ where: { id: under.id } }))?.content).toBe('dog');
    expect((await db.node.findUnique({ where: { id: parent.id } }))?.content).toBe('dog');
    expect((await db.node.findUnique({ where: { id: sibling.id } }))?.content).toBe('cat');
    expect((await db.node.findUnique({ where: { id: other.id } }))?.content).toBe('cat');
  });

  it('selects explicit nodeIds (deduped against memoryIds)', async () => {
    const a = await makeNode('a', { content: 'cat' });
    await makeNode('b', { content: 'cat' });

    const res = await call({
      oldText: 'cat',
      newText: 'dog',
      nodeIds: [a.id],
      fields: ['content'],
    });
    expect(res.nodesScanned).toBe(1);
    expect(res.nodesChanged).toBe(1);
  });

  it('writes a NodeVersion snapshot for each changed node', async () => {
    const a = await makeNode('a', { content: 'cat' });
    await call({ oldText: 'cat', newText: 'dog', nodeIds: [a.id], fields: ['content'] });
    const versions = await db.nodeVersion.findMany({ where: { nodeId: a.id } });
    expect(versions).toHaveLength(1);
    expect(versions[0].content).toBe('cat'); // pre-change snapshot
  });

  // #88: an explicit reason lands in each changed node's version snapshot
  // (editedBy), matching hadron_update_node's `reason`.
  it('records an explicit reason in each version snapshot (editedBy)', async () => {
    const a = await makeNode('a', { content: 'cat' });
    await call({
      oldText: 'cat',
      newText: 'dog',
      nodeIds: [a.id],
      fields: ['content'],
      reason: 'rename across corpus',
    });
    const versions = await db.nodeVersion.findMany({ where: { nodeId: a.id } });
    expect(versions[0].editedBy).toBe('rename across corpus');
  });

  it('supports regex mode with backreferences', async () => {
    const a = await makeNode('a', { content: 'reach bob@acme today' });
    await call({
      oldText: '(\\w+)@(\\w+)',
      newText: '$2.$1',
      nodeIds: [a.id],
      fields: ['content'],
      regex: true,
    });
    expect((await db.node.findUnique({ where: { id: a.id } }))?.content).toBe(
      'reach acme.bob today',
    );
  });
});

describe('searchReplaceInNodes — guards', () => {
  it('rejects a replacement that would empty a required name', async () => {
    const a = await makeNode('only-name', { name: 'cat' });
    await expect(
      call({ oldText: 'cat', newText: '', nodeIds: [a.id], fields: ['name'] }),
    ).rejects.toThrow(/would leave it empty/i);
  });

  it('rejects an abstract that would exceed the 2000-char cap', async () => {
    const a = await makeNode('a', { abstract: 'x' });
    await expect(
      call({
        oldText: 'x',
        newText: 'y'.repeat(2001),
        nodeIds: [a.id],
        fields: ['abstract'],
      }),
    ).rejects.toThrow(/2000/);
  });

  it('requires at least one of nodeIds / memoryIds', async () => {
    await expect(
      call({ oldText: 'a', newText: 'b', fields: ['content'] }),
    ).rejects.toThrow(/nodeIds.*memoryIds/);
  });

  it('rejects prefix without memoryIds', async () => {
    await expect(
      call({ oldText: 'a', newText: 'b', nodeIds: ['x'], prefix: 'auth', fields: ['content'] }),
    ).rejects.toThrow(/prefix/i);
  });

  it('rejects an empty fields list', async () => {
    await expect(
      call({ oldText: 'a', newText: 'b', memoryIds: [memory.id], fields: [] }),
    ).rejects.toThrow(/field/i);
  });

  it('rejects an invalid regex pattern', async () => {
    await expect(
      call({ oldText: '(', newText: 'b', memoryIds: [memory.id], fields: ['content'], regex: true }),
    ).rejects.toThrow(/invalid search pattern/i);
  });
});
