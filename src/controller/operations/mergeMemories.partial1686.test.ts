import * as embeddingQueue from '../../services/embedding/enqueue.js';
/**
 * #1686 — a mergeMemories refusal raised after earlier batches committed
 * reports what was applied (extensions.partialMerge), and the merge resumes
 * when re-run.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { mergeMemoryGraph } from './mergeMemories.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { ApolloServer } from '@apollo/server';
import { typeDefs } from '../../api/graphql/schema/typeDefs.js';
import { formatGraphQLError } from '../../api/graphql/formatError.js';
import { Prisma } from '../../generated/prisma/index.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let admin: { id: string };
let src: { id: string; urn: string };
let dst: { id: string; urn: string };

const as = (): Context => ({ db, userId: admin.id, roles: [] });
const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;
const errorOf = async (p: Promise<unknown>): Promise<GraphQLError> => {
  try { await p; } catch (e) { return e as GraphQLError; }
  throw new Error('expected a refusal');
};
/** Ids sort in the order given, so the keyset scan meets the nodes in that order. */
const node = (memoryId: string, id: string, loc: string, extra: Record<string, unknown> = {}) =>
  db.node.create({ data: { id, memoryId, loc, name: `Title ${loc}`, content: `Body ${loc}`, ...extra } });
// Page and batch size 1: every node commits in its own transaction.
const merge = () => mergeMemoryGraph(db, {
  sourceMemoryId: src.id, targetMemoryId: dst.id, fields: new Set(),
  deleteSourceMem: false, editor: { userId: admin.id, info: null, workerId: null, agentId: null } as never,
  batchSize: 1, classifyPageSize: 1,
});
const live = (memoryId: string) => db.node.count({ where: { memoryId, deletedAt: null, nodeType: { not: 'comment' } } });

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Partial Org', urn: 'partial.example' } });
  admin = await db.user.create({ data: { githubId: 168601, githubUsername: 'partial-admin', handle: 'partial-admin', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  src = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'partial-src' }, as());
  dst = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'partial-dst' }, as());
});

describe('#1686 — a mid-merge refusal reports the partial state', () => {
  // #1684 now refuses a tombstone that is present at the start before any batch
  // commits, so a collision has to APPEAR mid-merge to reach this path: the
  // target row is planted just before the batch that would move 'collide'.
  const plantBeforeLastBatch = (extra: Record<string, unknown>) => {
    const transaction = db.$transaction.bind(db);
    let planted = false;
    return vi.spyOn(db, '$transaction').mockImplementation((async (...args: unknown[]) => {
      if (!planted && (await live(src.id)) === 1) {
        planted = true;
        await node(dst.id, generateId(), 'collide', extra);
      }
      return (transaction as (...a: unknown[]) => unknown)(...args);
    }) as never);
  };

  it('an untyped mid-flight error (a target loc appearing mid-merge) becomes MERGE_PARTIALLY_APPLIED; re-running finishes the merge', async () => {
    await node(src.id, '00000000000000000000000000000001', 'a');
    await node(src.id, '00000000000000000000000000000002', 'b');
    await node(src.id, 'ffffffffffffffffffffffffffffff09', 'collide');
    const before = await live(src.id); // the three, plus the memory's own root node
    const spy = plantBeforeLastBatch({});
    let e: GraphQLError;
    try {
      e = await errorOf(merge());
    } finally {
      spy.mockRestore();
    }
    expect(e.extensions).toMatchObject({
      code: 'MERGE_PARTIALLY_APPLIED',
      partialMerge: { applied: true, relocated: before - 1, folded: 0, remainingSourceNodes: 1, sourceIntact: true },
    });
    expect(e.extensions.causeCode).toBeUndefined(); // a plain Error has no Prisma code to carry
    expect(e.message).toContain('appeared during classification');
    expect(e.message).toContain('partially applied');
    expect(await live(src.id)).toBe(1);

    // The planted target is live, so the re-run folds into it.
    await merge();
    expect(await live(src.id)).toBe(0);
  });

  it('a tombstone appearing mid-merge keeps #1684\'s code and gains the report; re-running after the hard delete finishes', async () => {
    await node(src.id, '00000000000000000000000000000001', 'a');
    await node(src.id, 'ffffffffffffffffffffffffffffff09', 'collide');
    const before = await live(src.id);
    const spy = plantBeforeLastBatch({ deletedAt: new Date() });
    let e: GraphQLError;
    try {
      e = await errorOf(merge());
    } finally {
      spy.mockRestore();
    }
    expect(e.extensions).toMatchObject({
      code: 'MERGE_TARGET_LOC_TOMBSTONED',
      locs: ['collide'],
      partialMerge: { applied: true, relocated: before - 1, folded: 0, remainingSourceNodes: 1, sourceIntact: true },
    });
    expect(await live(src.id)).toBe(1);

    await db.node.deleteMany({ where: { memoryId: dst.id, loc: 'collide' } });
    await merge();
    expect(await live(src.id)).toBe(0);
  });

  it('a typed refusal raised by a later batch (a thread on a folding node, #1682) keeps its code and gains the report', async () => {
    await node(src.id, '00000000000000000000000000000001', 'a');
    const folding = await node(src.id, 'ffffffffffffffffffffffffffffff09', 'collide');
    await node(dst.id, generateId(), 'collide');
    await M.createComment(null, { targetRef: folding.id, body: 'posted mid-merge' }, as());
    // Stand-in for "posted after the preflight": the preflight sees no threads.
    const before = await live(src.id);
    const spy = vi.spyOn(db, '$queryRaw').mockResolvedValueOnce([] as never);
    let e: GraphQLError;
    try {
      e = await errorOf(merge());
    } finally {
      spy.mockRestore();
    }
    expect(e.extensions).toMatchObject({
      code: 'COMMENT_MERGE_FOLDS_THREADS',
      partialMerge: { relocated: before - 1, folded: 0, remainingSourceNodes: 1, sourceIntact: true },
    });
  });

  it('a refusal before any batch committed carries no report: nothing was applied', async () => {
    await node(src.id, '00000000000000000000000000000001', 'a');
    const folding = await node(src.id, 'ffffffffffffffffffffffffffffff09', 'collide');
    await node(dst.id, generateId(), 'collide');
    await M.createComment(null, { targetRef: folding.id, body: 'x' }, as());
    const before = await live(src.id);
    const e = await errorOf(merge());
    expect(e.extensions.code).toBe('COMMENT_MERGE_FOLDS_THREADS');
    expect(e.extensions.partialMerge).toBeUndefined();
    expect(await live(src.id)).toBe(before);
  });

  it('through GraphQL, a failure in the first batch applied nothing and says nothing of a partial merge', async () => {
    // Default page sizes put both nodes in one relocate batch, which rolls back whole.
    await node(src.id, '00000000000000000000000000000001', 'a');
    await node(src.id, '00000000000000000000000000000002', 'b');
    await node(dst.id, generateId(), 'b', { deletedAt: new Date() });
    const before = await live(src.id);
    const e = await errorOf(M.mergeMemories(null, { input: { source: src.id, target: dst.id } }, as()));
    expect((e as GraphQLError).extensions?.partialMerge).toBeUndefined();
    expect(await live(src.id)).toBe(before);
  });
});

// #1691 review (Diego, P2 ×2).
describe('#1691 — the partial-state contract holds through the resolver and the wire', () => {
  // A Prisma message carries query arguments and schema internals; nothing of it may reach a client.
  const SECRET = 'Invalid `prisma.node.updateMany()` invocation: column "secret_internal_column"';
  const prismaFault = () => new Prisma.PrismaClientKnownRequestError(SECRET, { code: 'P2010', clientVersion: 'test' });
  const api = new ApolloServer<Context>({ typeDefs, resolvers, formatError: formatGraphQLError });
  const runMerge = async (deleteSourceMem: boolean) => {
    const response = await api.executeOperation(
      {
        query: 'mutation($i: MergeMemoriesInput!) { mergeMemories(input: $i) { id } }',
        variables: { i: { source: src.id, target: dst.id, deleteSourceMem } },
      },
      { contextValue: as() },
    );
    if (response.body.kind !== 'single') throw new Error('expected a single response');
    const errors = response.body.singleResult.errors ?? [];
    expect(errors).toHaveLength(1);
    return errors[0];
  };

  it('a mid-merge Prisma failure is redacted on the wire and keeps its partial report', async () => {
    await node(src.id, '00000000000000000000000000000001', 'a');
    await node(src.id, 'ffffffffffffffffffffffffffffff09', 'collide');
    await node(dst.id, generateId(), 'collide');
    const before = await live(src.id);
    // Everything but 'collide' relocates in the first batch (default sizes);
    // 'collide' folds into the target's row in a later one. Fail that one.
    const transaction = db.$transaction.bind(db);
    const spy = vi.spyOn(db, '$transaction').mockImplementation((async (...args: unknown[]) => {
      if ((await live(src.id)) === 1) throw prismaFault();
      return (transaction as (...a: unknown[]) => unknown)(...args);
    }) as never);
    let error;
    try {
      error = await runMerge(false);
    } finally {
      spy.mockRestore();
    }
    expect(JSON.stringify(error)).not.toContain('secret_internal_column');
    expect(JSON.stringify(error)).not.toContain('prisma.node');
    expect(error.message).toContain('partially applied');
    expect(error.extensions).toMatchObject({
      code: 'MERGE_PARTIALLY_APPLIED',
      causeCode: 'P2010',
      partialMerge: { applied: true, relocated: before - 1, folded: 0, remainingSourceNodes: 1, sourceIntact: true },
    });
    expect(await live(src.id)).toBe(1);
  });

  // Fail the resolver's re-index of the target, which runs after the whole merge committed.
  // The post-commit helper is the fault boundary. Intercepting Prisma's
  // extended raw-query proxy itself can recursively re-enter that proxy.
  const failBackfill = () => vi.spyOn(embeddingQueue, 'backfillMemoryEmbeddings')
    .mockRejectedValueOnce(prismaFault());

  for (const deleteSourceMem of [false, true]) {
    it(`a failure after the merge committed reports the completed merge (deleteSourceMem: ${deleteSourceMem})`, async () => {
      expect((await db.memory.findUniqueOrThrow({ where: { id: dst.id } })).vectorIndexEnabled).toBe(true);
      await node(src.id, '00000000000000000000000000000001', 'a');
      await node(src.id, 'ffffffffffffffffffffffffffffff09', 'collide');
      await node(dst.id, generateId(), 'collide');
      const before = await live(src.id);
      const spy = failBackfill();
      let error;
      try {
        error = await runMerge(deleteSourceMem);
      } finally {
        spy.mockRestore();
      }
      expect(JSON.stringify(error)).not.toContain('secret_internal_column');
      expect(error.message).toContain('The merge itself completed');
      expect(error.extensions).toMatchObject({
        code: 'MERGE_PARTIALLY_APPLIED',
        partialMerge: {
          applied: true, relocated: before - 1, folded: 1, remainingSourceNodes: 0,
          sourceIntact: !deleteSourceMem,
          remedy: expect.stringContaining('re-index'),
        },
      });
      // The report is true: everything moved, and the source went only when asked.
      expect(await live(src.id)).toBe(0);
      const source = await db.memory.findUniqueOrThrow({ where: { id: src.id } });
      expect(source.deletedAt !== null).toBe(deleteSourceMem);
    });
  }
});
