/**
 * searchReplaceInNodes — bulk literal/regex search-and-replace across selected
 * nodes. Covers selection (nodeIds / memoryIds / prefix), field coverage,
 * dryRun, the name/abstract guards, revision snapshots, and regex mode.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GraphQLError, buildSchema, type GraphQLInputObjectType } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { generateId } from '../../../lib/id.js';
import { typeDefs } from './typeDefs.js';

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

  it('writes a NodeRevision snapshot for each changed node', async () => {
    const a = await makeNode('a', { content: 'cat' });
    await call({ oldText: 'cat', newText: 'dog', nodeIds: [a.id], fields: ['content'] });
    const versions = await db.nodeRevision.findMany({ where: { nodeId: a.id } });
    expect(versions).toHaveLength(1);
    expect(versions[0].content).toBe('cat'); // pre-change snapshot
  });

  // #88/#620: an explicit reason lands in each changed node's version
  // snapshot as revLabel (it historically squatted in editedBy, which now
  // carries the editing user's PK); `changes` records the rewritten fields.
  it('records an explicit reason in each revision snapshot (revLabel)', async () => {
    const a = await makeNode('a', { content: 'cat' });
    await call({
      oldText: 'cat',
      newText: 'dog',
      nodeIds: [a.id],
      fields: ['content'],
      reason: 'rename across corpus',
    });
    const versions = await db.nodeRevision.findMany({ where: { nodeId: a.id } });
    expect(versions[0].revLabel).toBe('rename across corpus');
    expect(versions[0].editedBy).toBe(admin.id);
    expect(versions[0].changes).toEqual(['content']);
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

describe('searchReplaceInNodes — author-task attestation (#1328)', () => {
  it('refuses a batch with a required task unless its current revision is asserted, then stamps that node', async () => {
    const task = await makeNode('author-task', { isRunnable: true, content: 'instructions' });
    const config = await db.memoryConfig.create({ data: { id: generateId(), memoryId: memory.id } });
    await db.nodeRoleRule.create({
      data: { id: generateId(), configId: config.id, role: 'guide', authorTaskId: task.id, authorTaskRequired: true },
    });
    const guided = await makeNode('guided', { role: 'guide', content: 'cat' });
    const plain = await makeNode('plain', { content: 'cat' });
    const input = { oldText: 'cat', newText: 'dog', nodeIds: [guided.id, plain.id], fields: ['content'] };
    const codeOf = async (extra: Record<string, unknown>) => {
      const error = await call({ ...input, ...extra }).then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(GraphQLError);
      return (error as GraphQLError).extensions.code;
    };

    expect(await codeOf({})).toBe('AUTHOR_TASK_MISSING');
    expect(await codeOf({ authoredWith: { task: generateId(), revision: 1 } })).toBe('AUTHOR_TASK_WRONG_TASK');
    expect(await codeOf({ authoredWith: { task: task.id, revision: 2 } })).toBe('AUTHOR_TASK_STALE_REVISION');
    expect(await db.node.findUniqueOrThrow({ where: { id: plain.id } })).toMatchObject({ content: 'cat' });
    expect(await db.nodeRevision.count({ where: { nodeId: plain.id } })).toBe(0);

    const preview = await call({ ...input, dryRun: true });
    expect(preview.nodesChanged).toBe(2);
    const result = await call({ ...input, authoredWith: { task: task.id, revision: 1 } });
    expect(result.nodesChanged).toBe(2);
    expect(await db.node.findUniqueOrThrow({ where: { id: guided.id } })).toMatchObject({
      content: 'dog', authorshipKind: 'TASK', authoredByTask: task.id, authoredByRevision: 1,
    });
    expect(await db.node.findUniqueOrThrow({ where: { id: plain.id } })).toMatchObject({
      content: 'dog', authorshipKind: null,
    });
  });

  it('exposes authoredWith on the GraphQL bulk replace input', () => {
    const fields = (buildSchema(typeDefs).getType('SearchReplaceInNodesInput') as GraphQLInputObjectType).getFields();
    expect(fields.authoredWith?.type.toString()).toBe('AuthoredWithInput');
  });
});
