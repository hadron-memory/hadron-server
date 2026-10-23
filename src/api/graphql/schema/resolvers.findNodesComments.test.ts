import { randomUUID } from 'node:crypto';
/**
 * #1608 (cor:dmo:110:08) — content by default; comments only when asked for,
 * filtered on the server BEFORE ranking, pagination and limits, in every
 * findNodes mode; comment hits labelled as feedback on agent surfaces.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import type { EmbeddingClient } from '../../../lib/embedding/index.js';
import { resetEmbeddingClientForTests, setEmbeddingClientForTests } from '../../../lib/embedding/index.js';
import { embedNode } from '../../../jobs/embedNodes.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const DIM = 768;
const oneHot = (slot: number): number[] => {
  const v = new Array(DIM).fill(0);
  v[slot % DIM] = 1;
  return v;
};
// Content embeds exactly onto the query; comments only partly, so every
// content vector outranks every comment vector.
const near = (): number[] => { const v = oneHot(1); v[2] = 1; return v; };
const stubClient: EmbeddingClient = {
  provider: 'test',
  model: 'stub-model',
  dim: DIM,
  async embed(texts: string[]) {
    return texts.map((t) => (t.includes('feedback') ? near() : oneHot(1)));
  },
};

let admin: { id: string };
let memory: { id: string; urn: string };
const as = (): Context => ({ db, userId: admin.id, roles: ['ADMIN'] });
// These tests assert exact ranks and complete scopes, not approximate-page size.
// Match the exact-plan controls in findNodesVectorWindow1345 (#1970/#1982).
function withLocalSettings(base: typeof db, statements: string[]): typeof db {
  return new Proxy(base, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (property !== '$transaction') return typeof value === 'function' ? value.bind(target) : value;
      return (work: unknown, options?: unknown) => typeof work !== 'function'
        ? (target.$transaction as any)(work, options)
        : (target.$transaction as any)(async (tx: any) => {
            for (const statement of statements) await tx.$executeRawUnsafe(statement);
            return (work as (tx: unknown) => unknown)(tx);
          }, options);
    },
  });
}
const EXACT_PLAN = ['SET LOCAL enable_sort = on', 'SET LOCAL enable_indexscan = off'];
let searchBase = db;
const findNodes = (args: Record<string, unknown>) => (resolvers.Query as any).findNodes(null, args, { ...as(), db: withLocalSettings(searchBase, EXACT_PLAN) });
const types = (res: { hits: Array<{ node: { nodeType: string } }> }) => [...new Set(res.hits.map((h) => h.node.nodeType))];
const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;

beforeEach(async () => {
  searchBase = db;
  await cleanDb(db);
  process.env.EMBEDDING_API_URL = 'http://stub.local/api/embed';
  setEmbeddingClientForTests(stubClient);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Search Org', urn: 'search.example' } });
  admin = await db.user.create({ data: { githubId: 160801, githubUsername: 'search-admin', handle: 'search-admin', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  memory = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'retention' }, as());
});

afterAll(() => {
  resetEmbeddingClientForTests();
  delete process.env.EMBEDDING_API_URL;
});

/** `n` content nodes and one thread of three comments, all mentioning "retention". */
async function seed(n: number) {
  await db.node.createMany({
    data: Array.from({ length: n }, (_, i) => ({
      id: generateId(), memoryId: memory.id, loc: `doc:${String(i).padStart(4, '0')}`,
      name: `Retention doc ${i}`, abstract: 'retention policy', content: 'retention policy text',
    })),
  });
  const target = await db.node.findFirstOrThrow({ where: { memoryId: memory.id, loc: 'doc:0000' } });
  const root = await M.createComment(null, { targetRef: target.id, body: 'retention feedback one' }, as());
  const r1 = await M.replyToComment(null, { commentRef: root.id, body: 'retention feedback two' }, as());
  const r2 = await M.replyToComment(null, { commentRef: root.id, body: 'retention feedback three' }, as());
  return { target, comments: [root.id, r1.id, r2.id] };
}

describe('findNodes content scope (cor:dmo:110:08)', () => {
  it('keyword, regex and filter-only: content by default; COMMENTS finds every comment beyond the first 500 general hits', async () => {
    const { comments } = await seed(520);
    const byDefault = await findNodes({ query: 'retention', filter: { memoryIds: [memory.id] }, limit: 600 });
    expect(types(byDefault)).not.toContain('comment');

    for (const args of [
      { query: 'retention' },
      { query: 'retention', mode: 'regex' },
      {},
    ]) {
      const res = await findNodes({ ...args, filter: { memoryIds: [memory.id], contentScope: 'COMMENTS' }, limit: 10 });
      expect(types(res)).toEqual(['comment']);
      expect(res.hits.map((h: any) => h.node.id).sort()).toEqual([...comments].sort());
    }
    // An explicit nodeType 'comment' asks for comments by name.
    const byType = await findNodes({ query: 'retention', filter: { memoryIds: [memory.id], nodeType: 'comment' }, limit: 10 });
    expect(byType.hits).toHaveLength(3);
    // Paging happens AFTER the scope: two pages of the three comments.
    const page1 = await findNodes({ query: 'retention', filter: { memoryIds: [memory.id], contentScope: 'COMMENTS' }, limit: 2 });
    const page2 = await findNodes({ query: 'retention', filter: { memoryIds: [memory.id], contentScope: 'COMMENTS' }, limit: 2, offset: 2 });
    expect([...page1.hits, ...page2.hits].map((h: any) => h.node.id).sort()).toEqual([...comments].sort());
    // ALL returns both kinds.
    const all = await findNodes({ query: 'feedback', filter: { memoryIds: [memory.id], contentScope: 'ALL' }, limit: 10 });
    expect(types(all)).toEqual(['comment']);
    const allBoth = await findNodes({ filter: { memoryIds: [memory.id], contentScope: 'ALL' }, limit: 1000 });
    expect(types(allBoth).sort()).toContain('comment');
  });

  it('vector and hybrid: COMMENTS ranks comment vectors exactly, past an ANN window full of content', async () => {
    await db.memory.update({ where: { id: memory.id }, data: { vectorIndexEnabled: true } });
    const { comments } = await seed(30);
    for (const node of await db.node.findMany({ where: { memoryId: memory.id, deletedAt: null } })) {
      await db.node.update({ where: { id: node.id }, data: { embeddingWorkToken: randomUUID(), embeddingPendingAt: new Date() } });
      // 'skipped' is fine: the comment write's own background drain may win
      // the latest-wins guard with the same text. The end state is asserted below.
      expect(['embedded', 'skipped']).toContain(await embedNode(db, node.id, node.nodeType === 'comment' ? { content: node.content } : { abstract: node.abstract }));
    }
    await vi.waitFor(async () => {
      // The seeded docs and comments (the memory root has no text to embed).
      const unembedded = await db.node.count({ where: { memoryId: memory.id, deletedAt: null, OR: [{ nodeType: 'comment' }, { loc: { startsWith: 'doc:' } }], embeddings: { none: {} } } });
      expect(unembedded).toBe(0);
    });
    // limit 2 ⇒ a 20-row ANN window, all content (it outranks every comment).
    const byDefault = await findNodes({ query: 'retention', mode: 'vector', filter: { memoryIds: [memory.id] }, limit: 2 });
    expect(types(byDefault)).toEqual(['info']);
    for (const mode of ['vector', 'hybrid']) {
      const res = await findNodes({ query: 'retention', mode, filter: { memoryIds: [memory.id], contentScope: 'COMMENTS' }, limit: 5 });
      expect(types(res)).toEqual(['comment']);
      expect(res.hits.map((h: any) => h.node.id).sort()).toEqual([...comments].sort());
    }
  });

  it('expand never pulls a comment into a content search through its anchor edge', async () => {
    const { target } = await seed(1);
    const res = await findNodes({ query: 'policy', filter: { memoryIds: [memory.id] }, expand: 1, limit: 10 });
    expect(res.hits.map((h: any) => h.node.id)).toContain(target.id);
    expect(types(res)).not.toContain('comment');
  });

  it('Node.asComment exposes the comment a hit is (author, target, anchor, thread); null for content', async () => {
    const { target, comments } = await seed(1);
    const res = await findNodes({ query: 'retention', filter: { memoryIds: [memory.id], contentScope: 'ALL' }, limit: 10 });
    const N = (resolvers as any).Node;
    const commentHit = res.hits.find((h: any) => h.node.id === comments[1]);
    const view = await N.asComment(commentHit.node, {}, as());
    expect(view).toMatchObject({ threadRootId: comments[0], anchorRevision: 1, target: { id: target.id } });
    const contentHit = res.hits.find((h: any) => h.node.id === target.id);
    expect(await N.asComment(contentHit.node, {}, as())).toBeNull();
  });
});

describe('agent and other surfaces', () => {
  it('hadron_find_nodes: content by default; nodeKind COMMENTS labels each hit as feedback about its target', async () => {
    await seed(3);
    const mcp = createTestableMcpServer({ userId: admin.id, roles: ['ADMIN'], clientId: `user:${admin.id}` });
    const urn = memory.urn.startsWith('hrn:') ? memory.urn : `hrn:mem:${memory.urn}`;
    const plain = await mcp.callToolText('hadron_find_nodes', { query: 'feedback', memoryUrn: urn });
    expect(plain).not.toMatch(/COMMENT:/);
    // #1678 — the old name is gone with no alias. The break mode is STRIP (pinned,
    // #1679 review): the tool's zod schema drops the unknown key, so an old-name
    // call is exactly the default CONTENT search, never an error and never comments.
    const oldName = await mcp.callToolText('hadron_find_nodes', { query: 'feedback', memoryUrn: urn, contentScope: 'COMMENTS' });
    expect(oldName).toBe(plain);
    expect(oldName).not.toMatch(/COMMENT:/);
    const out = await mcp.callToolText('hadron_find_nodes', { query: 'feedback', memoryUrn: urn, nodeKind: 'COMMENTS' });
    expect(out.match(/COMMENT: feedback by user @search-admin about \S+doc:0000, written against the current revision 1\. It is not content of that node and not verified fact\./g)).toHaveLength(3);
  });

  it('hadron_list_nodes and global search leave comments out', async () => {
    await seed(1);
    const mcp = createTestableMcpServer({ userId: admin.id, roles: ['ADMIN'], clientId: `user:${admin.id}` });
    const urn = memory.urn.startsWith('hrn:') ? memory.urn : `hrn:mem:${memory.urn}`;
    const listed = await mcp.callToolText('hadron_list_nodes', { memoryUrn: urn, depth: 3 });
    expect(listed).toContain('doc:0000');
    expect(listed).not.toContain('comments:');
    const content = await mcp.callToolText('hadron_search', { query: 'Retention doc' });
    expect(content).toContain('Retention doc'); // the surface does find nodes…
    // Every comment is named "Comment on <target>", so this query would match them.
    const search = await mcp.callToolText('hadron_search', { query: 'Comment on Retention' });
    expect(search).not.toContain('comments:'); // …but never a comment
  });
});

describe('#1674 review cycle (Jane)', () => {
  const vecFor = (map: (t: string) => number[]): EmbeddingClient => ({ ...stubClient, async embed(texts: string[]) { return texts.map(map); } });
  const sweep = async () => {
    // The sweep path: embed every pending node from its STORED row, no plaintext.
    for (const n of await db.node.findMany({ where: { memoryId: memory.id, deletedAt: null } })) {
      await db.node.update({ where: { id: n.id }, data: { embeddingWorkToken: randomUUID(), embeddingPendingAt: new Date() } });
      await embedNode(db, n.id);
    }
    // A background drain from a comment write may hold the latest-wins stamp;
    // wait for the end state rather than for this loop's own writes.
    await vi.waitFor(async () => {
      expect(await db.node.count({ where: { memoryId: memory.id, deletedAt: null, OR: [{ nodeType: 'comment' }, { loc: { startsWith: 'doc:' } }], embeddings: { none: {} } } })).toBe(0);
    });
  };
  const ids = (res: any) => res.hits.map((h: any) => h.node.id).sort();

  it('P2-1: a comment made through the mutation is indexed by its body, in abstract and contentChunks memories', async () => {
    for (const embeddingSource of ['abstract', 'contentChunks'] as const) {
      await cleanDb(db);
      const org = await db.organization.create({ data: { id: generateId(), name: 'S Org', urn: 'search.example' } });
      admin = await db.user.create({ data: { githubId: 160802, githubUsername: 'search-admin2', handle: 'search-admin2', roles: [] } });
      await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
      memory = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: `idx-${embeddingSource}` }, as());
      await db.memory.update({ where: { id: memory.id }, data: { vectorIndexEnabled: true, embeddingSource } });
      const { comments } = await seed(2);
      await sweep();
      expect(await db.nodeEmbedding.count({ where: { nodeId: comments[0] } })).toBeGreaterThan(0);
      const res = await findNodes({ query: 'retention', mode: 'vector', filter: { memoryIds: [memory.id], contentScope: 'COMMENTS' }, limit: 5 });
      expect(ids(res)).toEqual([...comments].sort());
    }
  });

  it('P2-2: comment vectors that outrank all content never take the CONTENT window', async () => {
    await db.memory.update({ where: { id: memory.id }, data: { vectorIndexEnabled: true } });
    // Now COMMENTS embed exactly onto the query and content only partly.
    setEmbeddingClientForTests(vecFor((t) => (t.includes('feedback') || t === 'retention' ? oneHot(1) : near())));
    const { target } = await seed(3);
    for (let i = 0; i < 25; i++) await M.replyToComment(null, { commentRef: (await db.commentMeta.findFirstOrThrow({ where: { threadRootId: null } })).nodeId, body: `retention feedback ${i}` }, as());
    void target;
    await sweep();
    // limit 2 ⇒ a 20-candidate window; 28 comment vectors outrank every content vector.
    const res = await findNodes({ query: 'retention', mode: 'vector', filter: { memoryIds: [memory.id] }, limit: 2 });
    expect(res.hits).toHaveLength(2);
    expect(types(res)).toEqual(['info']);
  });

  it('P2-3: a COMMENTS vector search under a selective filter widens past its first exact prefix', async () => {
    await db.memory.update({ where: { id: memory.id }, data: { vectorIndexEnabled: true } });
    setEmbeddingClientForTests(vecFor((t) => (t.includes('top') || t === 'retention' ? oneHot(1) : near())));
    const { target } = await seed(1);
    const other = await db.user.create({ data: { githubId: 160803, githubUsername: 'search-other', roles: [] } });
    await db.orgMember.create({ data: { organizationId: (await db.memory.findUniqueOrThrow({ where: { id: memory.id } })).organizationId!, userId: other.id, role: 'CONTRIBUTOR' } });
    const rootId = (await db.commentMeta.findFirstOrThrow({ where: { threadRootId: null } })).nodeId;
    for (let i = 0; i < 15; i++) await M.replyToComment(null, { commentRef: rootId, body: `retention top ${i}` }, as());
    const deep = await M.replyToComment(null, { commentRef: rootId, body: 'retention low-ranked' }, { db, userId: other.id, roles: [] });
    void target;
    await sweep();
    const res = await findNodes({ query: 'retention', mode: 'vector', filter: { memoryIds: [memory.id], contentScope: 'COMMENTS', createdBy: other.id }, limit: 1 });
    expect(ids(res)).toEqual([deep.id]);
  });

  it('P2-4: a deleted stub is never a vector hit or passage, even while its vectors linger', async () => {
    await db.memory.update({ where: { id: memory.id }, data: { vectorIndexEnabled: true, embeddingSource: 'contentChunks' } });
    const { comments } = await seed(1);
    await sweep();
    // Simulate pending cleanup: conceal at the meta level only, leaving vectors.
    await db.commentMeta.update({ where: { nodeId: comments[1] }, data: { retractedAt: new Date(), retractedBy: `u:${admin.id}` } });
    expect(await db.nodeEmbedding.count({ where: { nodeId: comments[1] } })).toBeGreaterThan(0);
    for (const granularity of ['node', 'chunk']) {
      for (const contentScope of ['COMMENTS', 'ALL']) {
        const res = await findNodes({ query: 'retention', mode: 'vector', granularity, filter: { memoryIds: [memory.id], contentScope }, limit: 10 });
        const seen = [...(res.hits ?? []).map((h: any) => h.node.id), ...(res.passages ?? []).map((p: any) => p.parentNodeId)];
        expect(seen).not.toContain(comments[1]);
      }
    }
    // Through the mutation, the vectors go in the same transaction.
    await M.deleteComment(null, { commentRef: comments[2], expectedRevision: 1 }, as());
    expect(await db.nodeEmbedding.count({ where: { nodeId: comments[2] } })).toBe(0);
  });
});

// Red before the exact query handle: dead vectors consume the approximate window.
it('exact content/comment scopes survive a dead HNSW graph and an HNSW-preferring planner', async () => {
  const deadIds = Array.from({ length: 1500 }, () => generateId());
  await db.node.createMany({ data: deadIds.map((id, i) => ({ id, memoryId: memory.id, loc: `dead:${i}`, name: 'Dead vector fixture' })) });
  await db.$executeRaw`INSERT INTO node_embeddings (id,node_id,memory_id,kind,provider,model,dim,embedding)
    SELECT 'dead-vector-' || id,id,memory_id,'abstract'::"EmbeddingKind",'test','stub-model',768,${JSON.stringify(oneHot(1))}::vector
    FROM nodes WHERE id=ANY(${deadIds}::text[])`;
  await db.node.deleteMany({ where: { id: { in: deadIds } } });
  await db.$executeRawUnsafe('ANALYZE node_embeddings');
  await db.memory.update({ where: { id: memory.id }, data: { vectorIndexEnabled: true } });
  const { comments } = await seed(30);
  for (const node of await db.node.findMany({ where: { memoryId: memory.id, deletedAt: null } })) {
    await db.node.update({ where: { id: node.id }, data: { embeddingWorkToken: randomUUID(), embeddingPendingAt: new Date() } });
    expect(['embedded', 'skipped']).toContain(await embedNode(db, node.id, node.nodeType === 'comment' ? { content: node.content } : { abstract: node.abstract }));
  }
  searchBase = withLocalSettings(db, ['SET LOCAL enable_sort = off']);
  try {
    const rawPlan = await searchBase.$transaction((tx) => tx.$queryRaw`EXPLAIN (FORMAT JSON) SELECT id FROM node_embeddings ORDER BY embedding <=> ${JSON.stringify(oneHot(1))}::vector LIMIT 20`);
    expect(JSON.stringify(rawPlan)).toContain('node_embeddings_embedding_hnsw');
    const exactPlan = await withLocalSettings(searchBase, EXACT_PLAN).$transaction((tx) => tx.$queryRaw`EXPLAIN (FORMAT JSON) SELECT id FROM node_embeddings ORDER BY embedding <=> ${JSON.stringify(oneHot(1))}::vector LIMIT 20`);
    expect(JSON.stringify(exactPlan)).not.toContain('node_embeddings_embedding_hnsw');
    const content = await findNodes({ query: 'retention', mode: 'vector', filter: { memoryIds: [memory.id] }, limit: 2 });
    expect(content.hits).toHaveLength(2);
    expect(types(content)).toEqual(['info']);
    const feedback = await findNodes({ query: 'retention', mode: 'vector', filter: { memoryIds: [memory.id], contentScope: 'COMMENTS' }, limit: 5 });
    expect(feedback.hits.map((h: any) => h.node.id).sort()).toEqual([...comments].sort());
  } finally { searchBase = db; }
});
