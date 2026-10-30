/**
 * #2832 — NodeFilter.childrenOf (cor:api:090:02): the direct children of a loc, read by loc string alone.
 *
 * A child is exactly `<P>:<one segment>`; "" is the top level; a loc whose parent has no node still counts.
 * The filter must give the SAME set in every findNodes mode and through hadron_find_nodes, narrow only (the
 * access gate and default exclusions are the existing ones), and page and count like any findNodes read.
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import type { EmbeddingClient } from '../../../lib/embedding/index.js';
import { setEmbeddingClientForTests, resetEmbeddingClientForTests } from '../../../lib/embedding/index.js';
import { embedNode } from '../../../jobs/embedNodes.js';
import { isDirectChildLoc } from '../../../lib/childLoc.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const admin = (): Context => ({ db, roles: ['ADMIN'], userId: 'admin-2832' } as Context);
const findNodes = (args: Record<string, unknown>, ctx: Context = admin()) => (resolvers.Query as any).findNodes(null, args, ctx);
const locs = (res: any): string[] => res.hits.map((h: any) => h.node.loc);
const sorted = (res: any): string[] => locs(res).sort();

let graph: { id: string; urn: string };
const mk = (loc: string, extra: Record<string, unknown> = {}) =>
  db.node.create({ data: { id: generateId(), memoryId: graph.id, loc, name: loc, ...extra } as any });
const kids = (childrenOf: string, extra: Record<string, unknown> = {}) =>
  findNodes({ filter: { memoryIds: [graph.id], childrenOf }, limit: 200, ...extra });

beforeEach(async () => {
  await cleanDb(db);
  graph = (await createDbOrgAndGraph(db, { orgName: 'kids-org', graphName: 'kids/graph' })).graph as any;
  for (const l of ['top1', 'top2', 'top1:a', 'top1:b', 'top1:a:x', 'top1:a:y', 'deep:x:y:z', 'deep:x:y:w', 'orphan:child',
    'findings:auth', 'findings:auth:oauth', 'findings:authz:x', 'a_b:c', 'axb:c', 'a%b:c']) {
    await mk(l);
  }
});

describe('#2832 the direct-children rule (filter-only)', () => {
  it('the root, "", is the locs with no colon: no grandchildren, nothing from a deeper level', async () => {
    expect(sorted(await kids(''))).toEqual(['top1', 'top2']);
  });

  it('a top-level loc lists its one-segment children and not its grandchildren', async () => {
    expect(sorted(await kids('top1'))).toEqual(['top1:a', 'top1:b']);
  });

  it('a deep loc lists its children; a parent with no node of its own still has them', async () => {
    expect(sorted(await kids('deep:x:y'))).toEqual(['deep:x:y:w', 'deep:x:y:z']);
    expect(sorted(await kids('orphan'))).toEqual(['orphan:child']); // no node "orphan" exists
    expect(sorted(await kids('deep'))).toEqual([]); // "deep:x" has no node, and "deep:x:y:z" is not a child of "deep"
  });

  it('the colon is the boundary: findings:auth never takes findings:authz, and LIKE metacharacters are literal', async () => {
    expect(sorted(await kids('findings:auth'))).toEqual(['findings:auth:oauth']);
    expect(sorted(await kids('a_b'))).toEqual(['a_b:c']); // "_" is not "any one character"
    expect(sorted(await kids('a%b'))).toEqual(['a%b:c']); // "%" is not "any run"
  });

  it('a childless loc, and a loc nobody has, list nothing (not the whole memory)', async () => {
    expect(sorted(await kids('top2'))).toEqual([]);
    expect(sorted(await kids('nowhere'))).toEqual([]);
  });

  it('absent and null are no filter; the empty string is a value', async () => {
    const all = await findNodes({ filter: { memoryIds: [graph.id] }, limit: 200 });
    expect(all.hits.length).toBe(15);
    expect((await findNodes({ filter: { memoryIds: [graph.id], childrenOf: null }, limit: 200 })).hits.length).toBe(15);
    expect((await kids('')).hits.length).toBe(2);
  });

  it('is scoped to the memory: another memory\'s same loc is not listed', async () => {
    const other = await createDbOrgAndGraph(db, { orgName: 'kids-other', graphName: 'kids/other' });
    await db.node.create({ data: { id: generateId(), memoryId: other.graph.id, loc: 'top1:zzz', name: 'zzz' } as any });
    expect(sorted(await kids('top1'))).toEqual(['top1:a', 'top1:b']);
  });

  it('keeps the default exclusions: soft-deleted and system nodes are not listed unless asked for', async () => {
    await mk('top1:gone', { deletedAt: new Date() });
    await mk('top1:sys', { nodeType: 'system' });
    expect(sorted(await kids('top1'))).toEqual(['top1:a', 'top1:b']);
    const withDeleted = await findNodes({ filter: { memoryIds: [graph.id], childrenOf: 'top1', includeDeleted: true }, limit: 200 });
    expect(sorted(withDeleted)).toEqual(['top1:a', 'top1:b', 'top1:gone']);
    const sys = await findNodes({ filter: { memoryIds: [graph.id], childrenOf: 'top1', nodeType: 'system' }, limit: 200 });
    expect(sorted(sys)).toEqual(['top1:sys']);
  });
});

describe('#2832 paging and total (cor:api:090:04)', () => {
  it('pages the children with the right total; grandchildren are not counted', async () => {
    for (let i = 0; i < 25; i++) {
      const n = String(i).padStart(2, '0');
      await mk(`big:${n}`);
      await mk(`big:${n}:grand`);
    }
    const p1 = await kids('big', { limit: 10, offset: 0, includeTotal: true });
    const p3 = await kids('big', { limit: 10, offset: 20, includeTotal: true });
    expect(p1.total).toBe(25);
    expect(p1.hits.length).toBe(10);
    expect(p3.hits.length).toBe(5);
    expect(locs(p1)[0]).toBe('big:00');
    expect(locs(p3).at(-1)).toBe('big:24');
  });
});

describe('#2832 order: the sibling order of cor:dmo:020:01 unless a sort is named', () => {
  beforeEach(async () => {
    await mk('ord:b');
    await mk('ord:a');
    await mk('ord:d');
    await mk('ord:c');
    await db.node.updateMany({ where: { memoryId: graph.id, loc: 'ord:c' }, data: { seq: 1 } });
    await db.node.updateMany({ where: { memoryId: graph.id, loc: 'ord:d' }, data: { seq: 2 } });
  });

  it('positioned nodes first by position, then the rest by loc', async () => {
    expect(locs(await kids('ord'))).toEqual(['ord:c', 'ord:d', 'ord:a', 'ord:b']);
    expect(locs(await kids('ord', { sort: 'relevance' }))).toEqual(['ord:c', 'ord:d', 'ord:a', 'ord:b']);
  });

  it('an explicit sort wins', async () => {
    expect(locs(await kids('ord', { sort: 'loc' }))).toEqual(['ord:a', 'ord:b', 'ord:c', 'ord:d']);
  });

  it('no childrenOf: the plain browse is still loc order', async () => {
    const r = await findNodes({ filter: { memoryIds: [graph.id], locPrefix: 'ord:' } });
    expect(locs(r)).toEqual(['ord:a', 'ord:b', 'ord:c', 'ord:d']);
  });
});

describe('#2832 every search mode returns only direct children', () => {
  beforeEach(async () => {
    for (const l of ['q:one', 'q:two', 'q:one:deeper', 'q:two:deeper']) await mk(l, { abstract: 'zebra', content: 'zebra body' });
    await mk('elsewhere', { abstract: 'zebra', content: 'zebra body' });
  });

  it('keyword', async () => {
    expect(sorted(await findNodes({ query: 'zebra', mode: 'keyword', filter: { memoryIds: [graph.id], childrenOf: 'q' } }))).toEqual(['q:one', 'q:two']);
    expect(sorted(await findNodes({ query: 'zebra', mode: 'keyword', filter: { memoryIds: [graph.id], childrenOf: '' } }))).toEqual(['elsewhere']);
  });

  it('regex', async () => {
    expect(sorted(await findNodes({ query: 'zebra', mode: 'regex', fields: ['abstract'], filter: { memoryIds: [graph.id], childrenOf: 'q' } }))).toEqual(['q:one', 'q:two']);
  });

  it('hybrid with no vector index falls back to the keyword leg and still honors it', async () => {
    expect(sorted(await findNodes({ query: 'zebra', mode: 'hybrid', filter: { memoryIds: [graph.id], childrenOf: 'q' } }))).toEqual(['q:one', 'q:two']);
  });

  describe('vector and vector-backed hybrid', () => {
    const DIM = 768;
    const oneHot = (slot: number): number[] => { const v = new Array(DIM).fill(0); v[slot % DIM] = 1; return v; };
    const stub = (): EmbeddingClient => ({
      provider: 'test', model: 'stub-model', dim: DIM,
      async embed(texts: string[]) { return texts.map(() => oneHot(1)); },
    });
    afterAll(() => { resetEmbeddingClientForTests(); delete process.env.EMBEDDING_API_URL; });

    it('vector, hybrid and chunk passages are narrowed to the direct children', async () => {
      process.env.EMBEDDING_API_URL = 'http://stub.local/api/embed';
      setEmbeddingClientForTests(stub());
      await db.memory.update({ where: { id: graph.id }, data: { vectorIndexEnabled: true, embeddingSource: 'contentChunks' } });
      for (const n of await db.node.findMany({ where: { memoryId: graph.id, abstract: 'zebra' } })) {
        await db.node.update({ where: { id: n.id }, data: { embeddingWorkToken: randomUUID(), embeddingPendingAt: new Date() } });
        expect(await embedNode(db, n.id)).toBe('embedded');
      }
      const f = { memoryIds: [graph.id], childrenOf: 'q' };
      expect(sorted(await findNodes({ query: 'zebra', mode: 'vector', filter: f }))).toEqual(['q:one', 'q:two']);
      expect(sorted(await findNodes({ query: 'zebra', mode: 'hybrid', filter: f }))).toEqual(['q:one', 'q:two']);
      const root = await findNodes({ query: 'zebra', mode: 'vector', filter: { memoryIds: [graph.id], childrenOf: '' } });
      expect(sorted(root)).toEqual(['elsewhere']);
      const chunks = await findNodes({ query: 'zebra', mode: 'vector', granularity: 'chunk', filter: f });
      const parentLocs = (await db.node.findMany({ where: { id: { in: chunks.passages.map((p: any) => p.parentNodeId) } }, select: { loc: true } })).map((n) => n.loc);
      expect(parentLocs.length).toBeGreaterThan(0);
      expect([...new Set(parentLocs)].sort()).toEqual(['q:one', 'q:two']);
    });
  });
});

describe('#2832 access parity: the filter only narrows', () => {
  it('a caller who cannot read the memory gets exactly what locPrefix gives them: nothing', async () => {
    const stranger = await db.user.create({ data: { githubId: 283201, githubUsername: 'stranger-2832', roles: ['READER'] } });
    const ctx: Context = { db, userId: stranger.id, roles: ['READER'] } as Context;
    const viaChildren = await findNodes({ filter: { memoryIds: [graph.id], childrenOf: 'top1' } }, ctx);
    const viaPrefix = await findNodes({ filter: { memoryIds: [graph.id], locPrefix: 'top1:' } }, ctx);
    expect(viaChildren).toEqual(viaPrefix);
    expect(viaChildren.hits).toEqual([]);
    const ranked = await findNodes({ query: 'top1', mode: 'keyword', filter: { memoryIds: [graph.id], childrenOf: 'top1' } }, ctx);
    expect(ranked.hits).toEqual([]);
  });
});

describe('#2832 the same rule in TypeScript (hydration re-check)', () => {
  it.each([
    ['top1:a', 'top1', true], ['top1:a:x', 'top1', false], ['top1', 'top1', false], ['top1', '', true],
    ['a:b', '', false], ['', '', false], ['findings:authz:x', 'findings:auth', false], ['a_b:c', 'axb', false],
  ])('isDirectChildLoc(%j, %j) = %s', (loc, parent, want) => {
    expect(isDirectChildLoc(loc, parent)).toBe(want);
  });
});

describe('#2832 appNodes rejects the filter instead of ignoring it', () => {
  it('names the unsupported filter', async () => {
    const org = await db.organization.create({ data: { id: generateId(), name: 'org-2832', urn: 'org-2832.example' } });
    const app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'App', urn: 'org-2832.example:app' } });
    await expect((resolvers.Query as any).appNodes(null, { appRef: app.id, filter: { childrenOf: 'x' } }, admin()))
      .rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });
});

describe('#2832 hadron_find_nodes takes childrenOf', () => {
  it('lists the direct children, the top level for "", and nothing outside', async () => {
    const user = await db.user.create({ data: { githubId: 283202, githubUsername: 'mcp-2832', roles: ['OWNER'] } });
    const mcp = createTestableMcpServer({ userId: user.id, roles: ['OWNER'], clientId: `user:${user.id}` } as never);
    const memoryUrn = `hrn:mem:${graph.urn}`;
    const t1 = await mcp.callToolText('hadron_find_nodes', { query: '*', memoryUrn, childrenOf: 'top1', limit: 50 } as never);
    expect(t1).toContain(':top1:a');
    expect(t1).toContain(':top1:b');
    expect(t1).not.toContain(':top1:a:x');
    expect(t1).not.toContain(':top2');
    const root = await mcp.callToolText('hadron_find_nodes', { query: '*', memoryUrn, childrenOf: '', limit: 50 } as never);
    expect(root).toContain(':top1');
    expect(root).toContain(':top2');
    expect(root).not.toContain(':top1:a');
    expect(root).toContain('Found 2 node');
  });
});
