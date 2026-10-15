/** #1664 (cor:dmo:110:02) — merges carry comment threads with their targets. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { mergeMemoryGraph } from '../../controller/operations/mergeMemories.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let admin: { id: string };
let orgId: string;
let src: { id: string; urn: string };
let dst: { id: string; urn: string };

const as = (): Context => ({ db, userId: admin.id, roles: [] });
const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;
const Q = resolvers.Query as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;
const node = (memoryId: string, loc: string) => db.node.create({
  data: { id: generateId(), memoryId, loc, name: `Title ${loc}`, content: `Body ${loc}` },
});
const errorOf = async (p: Promise<unknown>): Promise<GraphQLError> => {
  try { await p; } catch (e) { return e as GraphQLError; }
  throw new Error('expected a refusal');
};
// Batch and page size 1: every relocated node commits in its own transaction,
// so a thread that didn't travel WITH its target would break the invariants.
const merge = (fields: string[] = []) => mergeMemoryGraph(db, {
  sourceMemoryId: src.id, targetMemoryId: dst.id, fields: new Set(fields as never[]),
  deleteSourceMem: false, editor: { userId: admin.id, info: null, workerId: null, agentId: null } as never,
  batchSize: 1, classifyPageSize: 1,
});

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Merge Org', urn: 'merge.example' } });
  orgId = org.id;
  admin = await db.user.create({ data: { githubId: 166401, githubUsername: 'merge-admin', handle: 'merge-admin', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  src = await resolvers.Mutation.createMemory(null, { orgId, name: 'merge-src' }, as());
  dst = await resolvers.Mutation.createMemory(null, { orgId, name: 'merge-dst' }, as());
});

describe('mergeMemories carries threads (cor:dmo:110:02)', () => {
  it('moves every thread, live and deleted, with its target, batch by batch', async () => {
    // A target whose id sorts AFTER its comments' (an importer's forced id), so
    // id-ordered paging would reach a comment before its target: it must not
    // relocate on its own.
    const a = await db.node.create({ data: { id: 'f'.repeat(32), memoryId: src.id, loc: 'a', name: 'Title a', content: 'Body a' } });
    const b = await node(src.id, 'b');
    const root = await M.createComment(null, { targetRef: a.id, body: 'on a' }, as());
    const reply = await M.replyToComment(null, { commentRef: root.id, body: 'reply' }, as());
    const gone = await M.createComment(null, { targetRef: b.id, body: 'on b' }, as());
    await M.deleteCommentThread(null, { commentRef: gone.id, reason: 'old' }, as());

    const result = await merge();
    expect(result.relocatedCount).toBe(3); // the root node and a, b — never the comments themselves
    for (const id of [root.id, reply.id, gone.id]) {
      expect((await db.node.findUniqueOrThrow({ where: { id } })).memoryId).toBe(dst.id);
      expect((await db.edge.findFirstOrThrow({ where: { sourceId: id } })).memoryId).toBe(dst.id);
    }
    const page = await Q.commentThreads(null, { targetRef: a.id }, as());
    expect(page.items[0]).toMatchObject({ root: { id: root.id, memoryId: dst.id }, replyCount: 1 });
  });

  it('refuses a merge into a private memory while live threads exist; nothing moves', async () => {
    const a = await node(src.id, 'a');
    await M.createComment(null, { targetRef: a.id, body: 'x' }, as());
    const priv = await resolvers.Mutation.createMemory(null, { orgId, name: 'merge-priv', memoryClass: 'private' }, as());
    dst = priv;
    expect((await errorOf(merge())).extensions).toMatchObject({
      code: 'COMMENT_MOVE_UNCOMMENTABLE', class: 'private', nodes: [{ nodeId: a.id, loc: 'a', comments: 1 }],
    });
    expect((await db.node.findUniqueOrThrow({ where: { id: a.id } })).memoryId).toBe(src.id);
  });

  it('carries live threads into a system memory (#1935: only private refuses)', async () => {
    const a = await node(src.id, 'a');
    const t = await M.createComment(null, { targetRef: a.id, body: 'x' }, as());
    await db.memory.update({ where: { id: dst.id }, data: { class: 'system', visibility: null } });
    await merge();
    expect((await db.node.findUniqueOrThrow({ where: { id: t.id } })).memoryId).toBe(dst.id);
  });

  it('refuses folding a commented node (its anchor cannot move); after the admin deletes the thread the merge folds it', async () => {
    const a = await node(src.id, 'shared');
    await node(dst.id, 'shared');
    const t = await M.createComment(null, { targetRef: a.id, body: 'x' }, as());
    expect((await errorOf(merge(['CONTENT']))).extensions).toMatchObject({
      code: 'COMMENT_MERGE_FOLDS_THREADS', nodes: [{ nodeId: a.id, loc: 'shared', comments: 1 }],
    });
    expect((await db.node.findUniqueOrThrow({ where: { id: a.id } })).deletedAt).toBeNull();

    await M.deleteCommentThread(null, { commentRef: t.id, reason: 'clearing for the merge' }, as());
    const result = await merge(['CONTENT', 'EDGES']);
    expect(result.foldedCount).toBe(1);
    // The folded node is gone, and its deleted thread with it.
    expect(await db.node.findUnique({ where: { id: a.id } })).toBeNull();
    expect(await db.node.findUnique({ where: { id: t.id } })).toBeNull();
  });

  it('the GraphQL mergeMemories carries too', async () => {
    const a = await node(src.id, 'g');
    const c = await M.createComment(null, { targetRef: a.id, body: 'x' }, as());
    await M.mergeMemories(null, { input: { source: src.id, target: dst.id } }, as());
    expect((await db.node.findUniqueOrThrow({ where: { id: c.id } })).memoryId).toBe(dst.id);
  });
});

describe('mergeNodes and threads', () => {
  it('moving the source\'s edges keeps its threads on it; deleting a commented source refuses', async () => {
    const a = await node(src.id, 'na');
    const b = await node(src.id, 'nb');
    const c = await M.createComment(null, { targetRef: a.id, body: 'x' }, as());
    await M.mergeNodes(null, { input: { source: a.id, target: b.id, include: ['CONTENT', 'EDGES'] } }, as());
    expect((await db.edge.findFirstOrThrow({ where: { sourceId: c.id } })).targetId).toBe(a.id);
    expect((await errorOf(M.mergeNodes(null, { input: { source: a.id, target: b.id, include: ['CONTENT'], deleteSource: true } }, as()))).extensions)
      .toMatchObject({ code: 'COMMENT_MERGE_FOLDS_THREADS', nodes: [{ nodeId: a.id, loc: 'na', comments: 1 }] });
  });
});

describe('#1682 review cycle', () => {
  it('Baloo P2: mergeNodes deleteSource re-checks live threads UNDER the source lock', async () => {
    const a = await node(src.id, 'race-a');
    const b = await node(src.id, 'race-b');
    const c = await M.createComment(null, { targetRef: a.id, body: 'posted after the pre-check' }, as());
    // The refusal now exists ONLY under the source lock (the pre-lock count
    // that raced, and disclosed before authorization, is gone): removing the
    // in-lock check fails this.
    expect((await errorOf(M.mergeNodes(null, { input: { source: a.id, target: b.id, include: ['CONTENT'], deleteSource: true } }, as()))).extensions)
      .toMatchObject({ code: 'COMMENT_MERGE_FOLDS_THREADS', nodes: [{ nodeId: a.id, loc: 'race-a', comments: 1 }] });
    // Nothing was destroyed.
    expect(await db.node.findUnique({ where: { id: c.id } })).not.toBeNull();
    expect(await db.node.findUnique({ where: { id: a.id } })).not.toBeNull();
  });

  it('Baloo P3-2: a live thread that appears after the preflight still refuses with the typed code', async () => {
    const a = await node(src.id, 'late');
    const priv = await resolvers.Mutation.createMemory(null, { orgId, name: 'merge-priv2', memoryClass: 'private' }, as());
    dst = priv;
    await M.createComment(null, { targetRef: a.id, body: 'x' }, as());
    // Stand-in for "posted after the preflight": skip the preflight's view.
    const spy = vi.spyOn(db, '$queryRaw').mockResolvedValueOnce([] as never);
    try {
      expect((await errorOf(merge())).extensions).toMatchObject({
        code: 'COMMENT_MOVE_UNCOMMENTABLE', class: 'private', nodes: [{ nodeId: a.id, loc: 'late', comments: 1 }],
      });
    } finally {
      spy.mockRestore();
    }
    expect((await db.node.findUniqueOrThrow({ where: { id: a.id } })).memoryId).toBe(src.id);
  });
});

// #1684 / #1710 review (Diego P2): carried DELETED comments keep their locs, so
// a target tombstone at one of them collides on the total (loc, memory) index.
describe('mergeMemories: a target tombstone at a carried comment\'s loc (#1684)', () => {
  /** A live parent with one DELETED thread; returns the parent and the comment row. */
  async function parentWithDeletedThread(loc: string) {
    const parent = await node(src.id, loc);
    const c = await M.createComment(null, { targetRef: parent.id, body: 'old' }, as());
    await M.deleteCommentThread(null, { commentRef: c.id, reason: 'old' }, as());
    return { parent, comment: await db.node.findUniqueOrThrow({ where: { id: c.id } }) };
  }
  const tombstoneAt = (loc: string) => db.node.create({
    data: { id: generateId(), memoryId: dst.id, loc, name: 'gone', deletedAt: new Date() },
  });

  it('refuses MERGE_TARGET_LOC_TOMBSTONED for a NON-colliding parent\'s deleted comment, before any batch relocates', async () => {
    const bystander = await node(src.id, 'aaa-bystander');
    const { parent, comment } = await parentWithDeletedThread('p');
    expect(comment.deletedAt).not.toBeNull();
    await tombstoneAt(comment.loc);

    const err = await errorOf(merge());
    expect(err).toBeInstanceOf(GraphQLError);
    expect(err.extensions).toMatchObject({ code: 'MERGE_TARGET_LOC_TOMBSTONED', memoryId: dst.id, loc: comment.loc, count: 1 });
    // Batch and page size 1, yet nothing committed: the preflight refused.
    for (const id of [bystander.id, parent.id, comment.id]) {
      expect((await db.node.findUniqueOrThrow({ where: { id } })).memoryId).toBe(src.id);
    }
  });

  it('a tombstone at a carried comment\'s loc that appears AFTER the preflight is refused by the carry, not a raw P2002', async () => {
    const { parent, comment } = await parentWithDeletedThread('p');
    // The relocate page re-reads the target schema between the preflight and
    // its batch transaction; plant the tombstone there.
    const real = db.memory.findUnique.bind(db.memory);
    let planted = false;
    const spy = vi.spyOn(db.memory, 'findUnique').mockImplementation((async (args: { select?: { schema?: boolean } }) => {
      if (!planted && args?.select?.schema) {
        planted = true;
        await tombstoneAt(comment.loc);
      }
      return real(args as never);
    }) as never);
    try {
      const err = await errorOf(merge());
      expect(planted).toBe(true);
      expect(err.extensions).toMatchObject({ code: 'MERGE_TARGET_LOC_TOMBSTONED', loc: comment.loc });
    } finally {
      spy.mockRestore();
    }
    // The parent's batch rolled back with its thread.
    expect((await db.node.findUniqueOrThrow({ where: { id: parent.id } })).memoryId).toBe(src.id);
    expect((await db.node.findUniqueOrThrow({ where: { id: comment.id } })).memoryId).toBe(src.id);
  });

  it('a FOLDING parent\'s deleted thread is destroyed, not carried, so a tombstone at its loc does not refuse', async () => {
    const { comment } = await parentWithDeletedThread('shared');
    await node(dst.id, 'shared');
    const tomb = await tombstoneAt(comment.loc);
    await merge();
    expect(await db.node.findUnique({ where: { id: comment.id } })).toBeNull();
    expect((await db.node.findUniqueOrThrow({ where: { id: tomb.id } })).memoryId).toBe(dst.id);
  });

  it('an ordinary deleted source node never moves, so a target tombstone at its loc does not refuse', async () => {
    const gone = await db.node.create({ data: { id: generateId(), memoryId: src.id, loc: 'gone', name: 'g', deletedAt: new Date() } });
    await tombstoneAt('gone');
    await merge();
    expect((await db.node.findUniqueOrThrow({ where: { id: gone.id } })).memoryId).toBe(src.id);
  });
});
