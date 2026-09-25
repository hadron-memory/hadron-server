/**
 * searchReplaceInNodes — bulk literal/regex search-and-replace across selected
 * nodes. Covers selection (nodeIds / memoryIds / prefix), field coverage,
 * dryRun, the name/abstract guards, revision snapshots, and regex mode.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { generateId } from '../../../lib/id.js';
import { ensureChannelWithRoot } from '../../../lib/channels.js';
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

const gqlServer = new ApolloServer<Context>({ typeDefs, resolvers });

async function gqlCall(input: Record<string, unknown>) {
  const res = await gqlServer.executeOperation(
    {
      query: `mutation SearchReplace($input: SearchReplaceInNodesInput!) {
        searchReplaceInNodes(input: $input) {
          nodesSelected
          nodesScanned
          nodesSkipped
          skipCounts { governed protectedAddress }
          nodesChanged
          totalReplacements
          dryRun
        }
      }`,
      variables: { input },
    },
    { contextValue: ctx() },
  );
  if (res.body.kind !== 'single') throw new Error('unexpected incremental response');
  return res.body.singleResult;
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

describe('#1294 — truthful selected/scanned/skipped reporting', () => {
  it('exposes the additive aggregate counters through the executable GraphQL schema', async () => {
    const ordinary = await makeNode('wire:ordinary', { content: 'no match here' });
    const governed = await makeNode('wire:governed', {
      content: 'needle stays',
      role: 'review',
    });

    const result = await gqlCall({
      oldText: 'needle',
      newText: 'changed',
      nodeIds: [ordinary.id, governed.id],
      fields: ['content'],
      dryRun: true,
    });

    expect(result.errors).toBeUndefined();
    expect(result.data?.searchReplaceInNodes).toEqual({
      nodesSelected: 2,
      nodesScanned: 1,
      nodesSkipped: 1,
      skipCounts: { governed: 1, protectedAddress: 0 },
      nodesChanged: 0,
      totalReplacements: 0,
      dryRun: true,
    });
  });

  it.each([true, false])(
    'counts a multiply-governed explicit target once and preserves it (dryRun=%s)',
    async (dryRun) => {
      const ordinary = await makeNode('report:ordinary', { content: 'no match here' });
      const governed = await makeNode('report:governed', {
        content: 'needle stays',
        role: 'review',
        isRunnable: true,
      });

      const res = await call({
        oldText: 'needle',
        newText: 'changed',
        nodeIds: [governed.id, ordinary.id, governed.id],
        fields: ['content'],
        dryRun,
      });

      expect(res).toMatchObject({
        nodesSelected: 2,
        nodesScanned: 1,
        nodesSkipped: 1,
        nodesChanged: 0,
        totalReplacements: 0,
        skipCounts: { governed: 1, protectedAddress: 0 },
      });
      expect((await db.node.findUniqueOrThrow({ where: { id: governed.id } })).content).toBe(
        'needle stays',
      );
      expect(await db.nodeRevision.count({ where: { nodeId: governed.id } })).toBe(0);
    },
  );

  it.each([true, false])(
    'accounts for the complete memory-prefix selection (dryRun=%s)',
    async (dryRun) => {
      await makeNode('scope:ordinary', { content: 'no match here' });
      const governed = await makeNode('scope:governed', {
        content: 'needle stays governed',
        role: 'review',
        isRunnable: true,
      });

      const res = await call({
        oldText: 'needle',
        newText: 'changed',
        memoryIds: [memory.id],
        prefix: 'scope',
        fields: ['content'],
        dryRun,
      });

      expect(res).toMatchObject({
        nodesSelected: 2,
        nodesScanned: 1,
        nodesSkipped: 1,
        nodesChanged: 0,
        totalReplacements: 0,
        skipCounts: { governed: 1, protectedAddress: 0 },
      });
      expect((await db.node.findUniqueOrThrow({ where: { id: governed.id } })).content).toBe(
        'needle stays governed',
      );
    },
  );

  it('reports protected addresses separately and gives governance deterministic precedence', async () => {
    const { rootId } = await ensureChannelWithRoot(db, {
      memoryId: memory.id,
      loc: 'protected',
      name: 'protected',
      createdBy: admin.id,
    });
    await db.node.update({
      where: { id: rootId },
      data: { content: 'needle stays protected' },
    });
    const { rootId: governedRootId } = await ensureChannelWithRoot(db, {
      memoryId: memory.id,
      loc: 'protected-governed',
      name: 'protected-governed',
      createdBy: admin.id,
    });
    await db.node.update({
      where: { id: governedRootId },
      data: {
        content: 'needle stays doubly protected',
        role: 'review',
        isRunnable: true,
      },
    });

    const res = await call({
      oldText: 'needle',
      newText: 'changed',
      nodeIds: [rootId, governedRootId],
      fields: ['content'],
    });

    expect(res).toMatchObject({
      nodesSelected: 2,
      nodesScanned: 0,
      nodesSkipped: 2,
      nodesChanged: 0,
      totalReplacements: 0,
      skipCounts: { governed: 1, protectedAddress: 1 },
    });
    expect((await db.node.findUniqueOrThrow({ where: { id: rootId } })).content).toBe(
      'needle stays protected',
    );
    expect((await db.node.findUniqueOrThrow({ where: { id: governedRootId } })).content).toBe(
      'needle stays doubly protected',
    );
  });

  it('refuses an unauthorized target without returning selection or skip metadata', async () => {
    const otherOrg = await db.organization.create({
      data: { id: generateId(), name: 'other-org', urn: 'other-org' },
    });
    const otherMemory = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: otherOrg.id,
        urn: `${otherOrg.urn}:private-corpus`,
        name: 'private-corpus',
        class: 'knowledge',
      },
    });
    const hidden = await db.node.create({
      data: {
        id: generateId(),
        memoryId: otherMemory.id,
        loc: 'hidden',
        name: 'hidden',
        content: 'needle',
        role: 'review',
      },
    });
    const contributor = await db.user.create({
      data: { githubId: 7778, githubUsername: 'sr-contributor', roles: ['READER'] },
    });
    await db.orgMember.create({
      data: { organizationId: org.id, userId: contributor.id, role: 'CONTRIBUTOR' },
    });
    let caught: unknown;
    try {
      await resolvers.Mutation.searchReplaceInNodes(
        {},
        {
          input: {
            oldText: 'needle',
            newText: 'changed',
            nodeIds: [hidden.id],
            fields: ['content'],
          },
        } as never,
        { db, roles: ['READER'], userId: contributor.id } as Context,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(JSON.stringify(caught)).not.toMatch(/nodesSelected|nodesSkipped|governed/i);
    expect((await db.node.findUniqueOrThrow({ where: { id: hidden.id } })).content).toBe('needle');
  });
});
