/**
 * Resolver-level behavior for the findNodes `where` predicate (#719): the
 * structured JSONB filter threaded through the no-query browse and the lexical
 * (keyword) path, scope intersection, the datetime guard end-to-end, and the
 * BAD_USER_INPUT surfaces (malformed tree; where + vector/hybrid).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const ctx = (o: Partial<Context> = {}): Context => ({ db, ...o });
const admin = () => ctx({ roles: ['ADMIN'], userId: 'admin-where' });
const findNodes = (args: Record<string, unknown>, c: Context = admin()) =>
  (resolvers.Query as any).findNodes(null, args, c);

let graph: { id: string };
const mkNode = (fields: Record<string, unknown>) =>
  db.node.create({ data: { id: generateId(), memoryId: graph.id, ...fields } as any });
const locs = (res: any): string[] => res.hits.map((h: any) => h.node.loc).sort();

beforeEach(async () => {
  await cleanDb(db);
  const made = await createDbOrgAndGraph(db, { orgName: 'nww-org', graphName: 'nww/graph' });
  graph = made.graph;
  await mkNode({ loc: 'insight.a', name: 'Letta memory insight', properties: { sourceKind: 'substack', extractedAt: '2026-07-10T00:00:00Z' } });
  await mkNode({ loc: 'insight.b', name: 'Reddit memory insight', properties: { sourceKind: 'reddit', extractedAt: '2026-06-01T00:00:00Z' } });
  await mkNode({ loc: 'insight.c', name: 'Substack junk note', properties: { sourceKind: 'substack', extractedAt: 'not-a-date' } });
  await mkNode({ loc: 'insight.d', name: 'Substack insight recent', properties: { sourceKind: 'substack', extractedAt: '2026-07-15T00:00:00Z' } });
});

describe('findNodes where — no-query browse', () => {
  it('filters by an eq property predicate (unscored list)', async () => {
    const res = await findNodes({ filter: { where: { path: ['sourceKind'], eq: 'substack' } } });
    expect(locs(res)).toEqual(['insight.a', 'insight.c', 'insight.d']);
    expect(res.hits[0].score).toBeNull();
  });

  it('datetime range drops junk/missing dates without a 500 (guard end-to-end)', async () => {
    const res = await findNodes({
      filter: {
        where: {
          and: [
            { path: ['sourceKind'], eq: 'substack' },
            { path: ['extractedAt'], as: 'datetime', gte: '2026-07-01T00:00:00Z' },
          ],
        },
      },
    });
    // a (07-10) and d (07-15) match; c ('not-a-date') drops via the guard.
    expect(locs(res)).toEqual(['insight.a', 'insight.d']);
  });

  it('intersects the predicate with the memoryIds scope', async () => {
    const other = await createDbOrgAndGraph(db, { orgName: 'other-org', graphName: 'other/graph' });
    await db.node.create({
      data: { id: generateId(), memoryId: other.graph.id, loc: 'x', name: 'x', properties: { sourceKind: 'substack' } } as any,
    });
    const res = await findNodes({ filter: { memoryIds: [graph.id], where: { path: ['sourceKind'], eq: 'substack' } } });
    expect(locs(res)).toEqual(['insight.a', 'insight.c', 'insight.d']); // the other memory's substack node is out of scope
  });
});

describe('findNodes where — keyword + where (filter-then-rank)', () => {
  it('keyword ranks within the where-filtered set', async () => {
    const res = await findNodes({
      query: 'insight',
      mode: 'keyword',
      filter: { where: { path: ['sourceKind'], eq: 'substack' } },
    });
    // 'insight' matches a, b, d; where substack keeps a, d (b is reddit; c has no 'insight').
    expect(locs(res)).toEqual(['insight.a', 'insight.d']);
    expect(res.hits.every((h: any) => typeof h.score === 'number')).toBe(true);
  });
});

describe('findNodes where — BAD_USER_INPUT surfaces', () => {
  it('rejects a malformed where (two operators on one leaf)', async () => {
    await expect(findNodes({ filter: { where: { path: ['x'], eq: 'a', ne: 'b' } } })).rejects.toMatchObject({
      extensions: { code: 'BAD_USER_INPUT' },
    });
  });

  it('rejects where combined with an explicit mode hybrid', async () => {
    await expect(
      findNodes({ query: 'insight', mode: 'hybrid', filter: { where: { path: ['sourceKind'], eq: 'substack' } } }),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });

  it('rejects where combined with an explicit mode vector', async () => {
    await expect(
      findNodes({ query: 'insight', mode: 'vector', filter: { where: { path: ['sourceKind'], eq: 'substack' } } }),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });
});
