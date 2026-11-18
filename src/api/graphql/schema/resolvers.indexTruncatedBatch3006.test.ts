/**
 * #3006 — Node.indexTruncated reads the parent's own column when the projection carries it, and otherwise
 * batches the fallback: every projected parent resolved in the same tick shares ONE query.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers } from './resolvers.js';

let memoryId: string;
const field = (n: unknown, ctx: unknown) => (resolvers.Node as any).indexTruncated(n, {}, ctx);

/** A request context whose node reads are counted (findUnique and findMany both). */
function countingCtx(): { ctx: any; calls: () => number } {
  let calls = 0;
  const node = new Proxy(db.node as any, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (prop === 'findUnique' || prop === 'findMany' || prop === 'findFirst') {
        return (...args: unknown[]) => { calls += 1; return v.apply(target, args); };
      }
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { ctx: { db: { ...db, node } as any, userId: generateId(), roles: ['ADMIN'] }, calls: () => calls };
}
async function makeNodes(counts: Array<number | null>): Promise<string[]> {
  const ids: string[] = [];
  for (const [i, c] of counts.entries()) {
    const id = generateId();
    await db.node.create({ data: { id, memoryId, loc: `n${i}`, name: `n${i}`, nodeType: 'info', embeddingTruncatedChunks: c } as any });
    ids.push(id);
  }
  return ids;
}

beforeEach(async () => {
  await cleanDb(db);
  memoryId = (await createDbOrgAndGraph(db, { orgName: 'it3006', graphName: 'it3006/test' })).graph.id;
});

describe('#3006 Node.indexTruncated fallback', () => {
  it('a list of projected parents (no column) costs a bounded number of reads, not one per node', async () => {
    const ids = await makeNodes([5, null, 7, 0, 9, null, 3, 2]);
    const { ctx, calls } = countingCtx();
    const out = await Promise.all(ids.map((id) => field({ id }, ctx)));
    expect(out).toEqual([{ omittedChunks: 5 }, null, { omittedChunks: 7 }, null, { omittedChunks: 9 }, null, { omittedChunks: 3 }, { omittedChunks: 2 }]);
    expect(calls()).toBe(1);
  });

  it('a full-row parent carries the column: no read at all, null stays null', async () => {
    const { ctx, calls } = countingCtx();
    const out = await Promise.all([
      field({ id: 'a', embeddingTruncatedChunks: 4 }, ctx),
      field({ id: 'b', embeddingTruncatedChunks: null }, ctx),
      field({ id: 'c', embeddingTruncatedChunks: 0 }, ctx),
    ]);
    expect(out).toEqual([{ omittedChunks: 4 }, null, null]);
    expect(calls()).toBe(0);
  });

  it('a mixed list reads only for the parents without the column, in one query', async () => {
    const ids = await makeNodes([6, 8]);
    const { ctx, calls } = countingCtx();
    const out = await Promise.all([
      field({ id: ids[0] }, ctx),
      field({ id: 'x', embeddingTruncatedChunks: 1 }, ctx),
      field({ id: ids[1] }, ctx),
    ]);
    expect(out).toEqual([{ omittedChunks: 6 }, { omittedChunks: 1 }, { omittedChunks: 8 }]);
    expect(calls()).toBe(1);
  });

  it('a node that no longer exists resolves null, and the same id twice shares the row', async () => {
    const [id] = await makeNodes([4]);
    const { ctx, calls } = countingCtx();
    const out = await Promise.all([field({ id }, ctx), field({ id }, ctx), field({ id: generateId() }, ctx)]);
    expect(out).toEqual([{ omittedChunks: 4 }, { omittedChunks: 4 }, null]);
    expect(calls()).toBe(1);
  });

  it('separate requests (contexts) never share a batch', async () => {
    const [id] = await makeNodes([4]);
    const a = countingCtx();
    const b = countingCtx();
    await Promise.all([field({ id }, a.ctx), field({ id }, b.ctx)]);
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(1);
  });
});
