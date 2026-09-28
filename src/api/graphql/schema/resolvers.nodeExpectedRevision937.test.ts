/**
 * #937 — public single-node update doors expose the #1339 revSeq guard.
 *
 * These are deliberately resolver-level concurrency tests: two callers keep
 * the same Node.revision, one commits, and the stale caller then reaches the
 * real transactional write core. The refusal must leave the winner's live
 * state, revision and history untouched.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let admin: { id: string };
let outsider: { id: string };
let memoryId: string;

const ctx = (userId = admin.id): Context => ({
  db,
  roles: userId === admin.id ? ['ADMIN'] : ['READER'],
  userId,
}) as Context;

const gqlServer = new ApolloServer<Context>({ typeDefs, resolvers });

beforeEach(async () => {
  vi.restoreAllMocks();
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: 'occ-org', urn: 'occ-org' },
  });
  admin = await db.user.create({
    data: { githubId: 93701, githubUsername: 'occ-admin', handle: 'occ-admin', roles: ['ADMIN'] },
  });
  outsider = await db.user.create({
    data: { githubId: 93702, githubUsername: 'occ-outsider', handle: 'occ-outsider', roles: ['READER'] },
  });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  memoryId = (
    await db.memory.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: `${org.urn}:nodes`,
        name: 'nodes',
        class: 'knowledge',
      },
    })
  ).id;
});

const seed = (loc: string, extra: Record<string, unknown> = {}) =>
  db.node.create({
    data: {
      id: generateId(),
      memoryId,
      loc,
      name: loc,
      content: 'version one',
      abstract: 'summary one',
      ...extra,
    },
  });

async function update(
  door: 'updateNode' | 'updateTaskNode' | 'updateReviewNode' | 'updateSpecNode',
  input: Record<string, unknown>,
  context = ctx(),
) {
  return (resolvers.Mutation[door] as unknown as (
    parent: unknown,
    args: { input: Record<string, unknown> },
    context: Context,
  ) => Promise<unknown>)({}, { input }, context);
}

function isConflict(error: unknown): boolean {
  return error instanceof GraphQLError && error.extensions.code === 'NODE_WRITE_CONFLICT';
}

describe('GraphQL expectedRevision (#937)', () => {
  it('accepts expectedRevision through the executable GraphQL schema', async () => {
    const node = await seed('occ:wire');
    const result = await gqlServer.executeOperation(
      {
        query: `
          mutation UpdateWithBaseline($input: UpdateNodeInput!) {
            updateNode(input: $input) { id revision content }
          }
        `,
        variables: { input: { id: node.id, expectedRevision: 1, content: 'wire edit' } },
      },
      { contextValue: ctx() },
    );
    if (result.body.kind !== 'single') throw new Error('unexpected incremental response');
    expect(result.body.singleResult.errors).toBeUndefined();
    expect(result.body.singleResult.data?.updateNode).toMatchObject({
      id: node.id,
      revision: 2,
      content: 'wire edit',
    });
  });

  it('refuses stale full-content replacement without changing the winner, revision or history', async () => {
    const node = await seed('occ:content');
    const revisionReadByAAndB = await resolvers.Node.revision(node as never, {}, ctx());
    expect(revisionReadByAAndB).toBe(1);

    await update('updateNode', {
      id: node.id,
      expectedRevision: revisionReadByAAndB,
      content: 'writer B',
    });
    const afterB = await db.node.findUniqueOrThrow({ where: { id: node.id } });
    expect(afterB).toMatchObject({ content: 'writer B', revSeq: 2 });
    expect(await db.nodeRevision.count({ where: { nodeId: node.id } })).toBe(1);

    await expect(
      update('updateNode', {
        id: node.id,
        expectedRevision: revisionReadByAAndB,
        content: 'stale writer A',
      }),
    ).rejects.toSatisfy(isConflict);

    expect(await db.node.findUniqueOrThrow({ where: { id: node.id } })).toMatchObject({
      content: 'writer B',
      revSeq: 2,
    });
    expect(await db.nodeRevision.count({ where: { nodeId: node.id } })).toBe(1);
  });

  it.each([
    ['updateTaskNode', { isRunnable: true }],
    ['updateReviewNode', { role: 'review' }],
    ['updateSpecNode', { role: 'spec' }],
  ] as const)('%s enforces the same baseline for abstract replacement', async (door, kind) => {
    const node = await seed(`occ:${door}`, kind);
    await update(door, { id: node.id, expectedRevision: 1, abstract: 'writer B summary' });
    await expect(
      update(door, { id: node.id, expectedRevision: 1, abstract: 'stale writer A summary' }),
    ).rejects.toSatisfy(isConflict);

    expect(await db.node.findUniqueOrThrow({ where: { id: node.id } })).toMatchObject({
      abstract: 'writer B summary',
      revSeq: 2,
    });
    expect(await db.nodeRevision.count({ where: { nodeId: node.id } })).toBe(1);
  });

  it('refuses a pre-drift baseline and rolls the reconciliation back with the refusal', async () => {
    const node = await seed('occ:drift');
    await db.node.update({ where: { id: node.id }, data: { content: 'raw drift' } });

    await expect(
      update('updateNode', { id: node.id, expectedRevision: 1, content: 'must not overwrite drift' }),
    ).rejects.toSatisfy(isConflict);

    expect(await db.node.findUniqueOrThrow({ where: { id: node.id } })).toMatchObject({
      content: 'raw drift',
      revSeq: 1,
    });
    expect(await db.nodeRevision.count({ where: { nodeId: node.id } })).toBe(0);
  });

  it('refuses a stale guard even when the requested value is already current', async () => {
    const node = await seed('occ:no-op');
    await update('updateNode', { id: node.id, expectedRevision: 1, content: 'version two' });

    await expect(
      update('updateNode', { id: node.id, expectedRevision: 1, content: 'version two' }),
    ).rejects.toSatisfy(isConflict);

    expect(await db.node.findUniqueOrThrow({ where: { id: node.id } })).toMatchObject({ revSeq: 2 });
    expect(await db.nodeRevision.count({ where: { nodeId: node.id } })).toBe(1);
  });

  it('consumes the guard for an ownerRepo-only change so the baseline cannot be reused', async () => {
    const node = await seed('occ:owner-repo', { ownerRepo: 'before/repo' });
    await update('updateNode', {
      id: node.id,
      expectedRevision: 1,
      ownerRepo: 'writer-b/repo',
    });

    await expect(
      update('updateNode', {
        id: node.id,
        expectedRevision: 1,
        ownerRepo: 'stale-writer-a/repo',
      }),
    ).rejects.toSatisfy(isConflict);

    expect(await db.node.findUniqueOrThrow({ where: { id: node.id } })).toMatchObject({
      ownerRepo: 'writer-b/repo',
      revSeq: 2,
    });
    expect(await db.nodeRevision.count({ where: { nodeId: node.id } })).toBe(1);
  });

  it('keeps omission backward-compatible', async () => {
    const node = await seed('occ:omitted');
    await update('updateNode', { id: node.id, content: 'unguarded edit' });
    expect(await db.node.findUniqueOrThrow({ where: { id: node.id } })).toMatchObject({
      content: 'unguarded edit',
      revSeq: 2,
    });
  });

  it('treats an explicit GraphQL null precondition like omission', async () => {
    const node = await seed('occ:null');
    const result = await gqlServer.executeOperation(
      {
        query: `
          mutation UpdateWithoutBaseline($input: UpdateNodeInput!) {
            updateNode(input: $input) { id revision content }
          }
        `,
        variables: { input: { id: node.id, expectedRevision: null, content: 'unguarded null edit' } },
      },
      { contextValue: ctx() },
    );
    if (result.body.kind !== 'single') throw new Error('unexpected incremental response');
    expect(result.body.singleResult.errors).toBeUndefined();
    expect(result.body.singleResult.data?.updateNode).toMatchObject({
      id: node.id,
      revision: 2,
      content: 'unguarded null edit',
    });
  });

  it.each([0, -1, 1.5, 2_147_483_648])('rejects invalid expectedRevision %s before writing', async (bad) => {
    const node = await seed(`occ:invalid:${String(bad).replace('.', '-')}`);
    await expect(
      update('updateNode', { id: node.id, expectedRevision: bad, content: 'must not land' }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof GraphQLError &&
        error.extensions.code === 'BAD_USER_INPUT' &&
        error.extensions.field === 'expectedRevision',
    );
    expect(await db.node.findUniqueOrThrow({ where: { id: node.id } })).toMatchObject({
      content: 'version one',
      revSeq: 1,
    });
  });

  // Added in review (@Andi, PR #1352): the resolver-level validation exists
  // precisely BECAUSE internal delegates and resolver tests bypass the GraphQL
  // Int coercion, so a test that only goes through the schema cannot hold it.
  // Deleting the check left the suite green before these cases.
  it('rejects a non-positive, non-integer or over-32-bit precondition at the resolver seam', async () => {
    const node = await seed('guard:invalid');
    for (const bad of [0, -1, 1.5, 2_147_483_648, Number.NaN, Number.POSITIVE_INFINITY]) {
      const error = await update('updateNode', {
        id: node.id,
        content: 'should not land',
        expectedRevision: bad,
      }).catch((e: unknown) => e);
      expect(error, `expectedRevision: ${bad}`).toBeInstanceOf(GraphQLError);
      expect((error as GraphQLError).extensions.code, `expectedRevision: ${bad}`).toBe('BAD_USER_INPUT');
      expect((error as GraphQLError).extensions.field, `expectedRevision: ${bad}`).toBe('expectedRevision');
      // Refused before any write: the content must be untouched.
      const after = await db.node.findUniqueOrThrow({ where: { id: node.id } });
      expect(after.content).toBe('version one');
      expect(after.revSeq).toBe(node.revSeq);
    }
  });

  it('does not turn the precondition into a revision oracle for an unreadable node', async () => {
    const node = await seed('occ:concealed');
    let caught: unknown;
    try {
      await update(
        'updateNode',
        { id: node.id, expectedRevision: 937, content: 'must not land' },
        ctx(outsider.id),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GraphQLError);
    const gql = caught as GraphQLError;
    expect(gql.extensions.code).not.toBe('NODE_WRITE_CONFLICT');
    expect(JSON.stringify(gql.extensions)).not.toMatch(/revision/i);
    expect(await db.node.findUniqueOrThrow({ where: { id: node.id } })).toMatchObject({
      content: 'version one',
      revSeq: 1,
    });
  });
});
