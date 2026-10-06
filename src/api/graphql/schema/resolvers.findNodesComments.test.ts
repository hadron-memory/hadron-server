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
const findNodes = (args: Record<string, unknown>) => (resolvers.Query as any).findNodes(null, args, as());
const types = (res: { hits: Array<{ node: { nodeType: string } }> }) => [...new Set(res.hits.map((h) => h.node.nodeType))];
const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;

beforeEach(async () => {
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
  const target = await db.node.findFirstOrThrow({ where: { loc: 'doc:0000' } });
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
      await db.node.update({ where: { id: node.id }, data: { embeddingPendingAt: new Date() } });
      expect(await embedNode(db, node.id, node.nodeType === 'comment' ? { content: node.content } : { abstract: node.abstract })).toBe('embedded');
    }
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
  it('hadron_find_nodes: content by default; COMMENTS labels each hit as feedback about its target', async () => {
    await seed(3);
    const mcp = createTestableMcpServer({ userId: admin.id, roles: ['ADMIN'], clientId: `user:${admin.id}` });
    const urn = memory.urn.startsWith('hrn:') ? memory.urn : `hrn:mem:${memory.urn}`;
    const plain = await mcp.callToolText('hadron_find_nodes', { query: 'feedback', memoryUrn: urn });
    expect(plain).not.toMatch(/COMMENT:/);
    const out = await mcp.callToolText('hadron_find_nodes', { query: 'feedback', memoryUrn: urn, contentScope: 'COMMENTS' });
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
