/**
 * #435 — findNodes bounds its boolean query (ruling Holger 2026-11-22): 512 raw characters, 64 leaves, depth 8.
 *
 * - raw length over 512: BAD_USER_INPUT in every mode, before the embed call, never truncated;
 * - unindexable negation (`-foo`, `a OR -b`): BAD_USER_INPUT, judged by the database's own querytree() with no scan;
 * - structure overflow: the flagged literal fallback, never a bare 500;
 * - stop-words-only: an empty result with no flag and no refusal;
 * - hybrid: a refused keyword half fails the whole call;
 * - the same refusals through hadron_find_nodes and the agent task symptom search.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { setEmbeddingClientForTests, resetEmbeddingClientForTests } from '../../../lib/embedding/index.js';
import { postgresRetrievalProvider as provider } from '../../../lib/retrieval/postgres.js';
import { UnindexableQueryError } from '../../../lib/retrieval/tsquery.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const admin = (): Context => ({ db, roles: ['ADMIN'], userId: 'admin-435' } as Context);
const findNodes = (args: Record<string, unknown>) => (resolvers.Query as any).findNodes(null, { limit: 50, ...args }, admin());
const locs = (r: any): string[] => r.hits.map((h: any) => h.node.loc).sort();
const code = async (p: Promise<unknown>): Promise<string | undefined> => p.then(() => undefined, (e: any) => e?.extensions?.code ?? `UNTYPED:${e?.name}`);

let graph: { id: string; urn: string };
const mk = (loc: string, content: string) => db.node.create({ data: { id: generateId(), memoryId: graph.id, loc, name: loc, content } as any });
const long = (n: number) => 'x'.repeat(n);
const embed = vi.fn(async (texts: string[]) => texts.map(() => new Array(768).fill(0)));

beforeEach(async () => {
  embed.mockClear();
  setEmbeddingClientForTests({ model: 'test', dim: 768, embed } as never);
  await cleanDb(db);
  graph = (await createDbOrgAndGraph(db, { orgName: 'caps-org', graphName: 'caps/graph' })).graph as any;
  await mk('n:foo', 'the foo document about gardening');
  await mk('n:bar', 'the bar document about carpentry');
  await mk('n:foobar', 'foo and bar together in one note');
});
afterEach(() => resetEmbeddingClientForTests());

describe('#435 the raw length bound, at the findNodes entry', () => {
  it.each(['keyword', 'regex', 'vector', 'hybrid'])('%s: 513 characters is BAD_USER_INPUT, 512 is not', async (mode) => {
    expect(await code(findNodes({ query: long(513), mode, filter: { memoryIds: [graph.id] } }))).toBe('BAD_USER_INPUT');
    expect(await code(findNodes({ query: long(512), mode, filter: { memoryIds: [graph.id] } }))).toBeUndefined();
  });

  it('is raised before the embed call, and nothing is truncated (a 600-character query whose first 512 would match is refused)', async () => {
    expect(await code(findNodes({ query: `foo ${long(600)}`, mode: 'hybrid', filter: { memoryIds: [graph.id] } }))).toBe('BAD_USER_INPUT');
    expect(await code(findNodes({ query: `foo ${long(600)}`, mode: 'vector', filter: { memoryIds: [graph.id] } }))).toBe('BAD_USER_INPUT');
    expect(embed).not.toHaveBeenCalled();
  });

  it('the bound counts the trimmed text', async () => {
    expect(await code(findNodes({ query: `   ${long(512)}   `, mode: 'keyword', filter: { memoryIds: [graph.id] } }))).toBeUndefined();
  });
});

describe('#435 unindexable negation is refused, judged by the database', () => {
  it.each(['-foo', 'foo OR -bar', 'NOT NOT foo', '-foo -bar', 'the -foo'])('keyword: %s is BAD_USER_INPUT', async (query) => {
    expect(await code(findNodes({ query, mode: 'keyword', filter: { memoryIds: [graph.id] } }))).toBe('BAD_USER_INPUT');
  });

  it.each(['foo -bar', '(foo OR bar) -foobar', 'foo OR (bar -foobar)'])('keyword: %s is accepted and answers', async (query) => {
    expect(await code(findNodes({ query, mode: 'keyword', filter: { memoryIds: [graph.id] } }))).toBeUndefined();
  });

  it('keeps the meaning of an accepted exclusion', async () => {
    expect(locs(await findNodes({ query: 'foo -bar', mode: 'keyword', filter: { memoryIds: [graph.id] } }))).toEqual(['n:foo']);
  });

  it('hybrid: a refused keyword half fails the whole call, never vector-only', async () => {
    expect(await code(findNodes({ query: '-foo', mode: 'hybrid', filter: { memoryIds: [graph.id] } }))).toBe('BAD_USER_INPUT');
  });

  it('a refused query issues exactly the pre-flight and never the nodes scan', async () => {
    const spy = vi.spyOn(db, '$queryRawUnsafe');
    await expect(provider.lexicalSearch({ db, memoryIds: [graph.id], query: '-foo', limit: 10 })).rejects.toBeInstanceOf(UnindexableQueryError);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]![0])).toMatch(/^SELECT querytree\(/);
    expect(String(spy.mock.calls[0]![0])).not.toMatch(/FROM nodes/);
    spy.mockRestore();
  });

  it('an accepted query issues the pre-flight and then the scan', async () => {
    const spy = vi.spyOn(db, '$queryRawUnsafe');
    await provider.lexicalSearch({ db, memoryIds: [graph.id], query: 'foo -bar', limit: 10 });
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('the relax-to-OR retry of a bare conjunction still works (its OR query is indexable)', async () => {
    const r = await findNodes({ query: 'gardening zzzunknownzzz', mode: 'keyword', filter: { memoryIds: [graph.id] } });
    expect(r.degraded).toBe('and_relaxed_to_or');
    expect(locs(r)).toEqual(['n:foo']);
  });
});

describe('#435 structure overflow degrades to the literal fallback, never a 500', () => {
  it.each([
    ['65 leaves', Array.from({ length: 65 }, (_, i) => `w${i}`).join(' ')],
    ['depth 9', '((((((((( foo )))))))))'],
  ])('keyword: %s', async (_n, query) => {
    const r = await findNodes({ query, mode: 'keyword', filter: { memoryIds: [graph.id] } });
    expect(r.degraded).toBe('literal_fallback');
  });

  it('hybrid keeps the literal_fallback flag too', async () => {
    const r = await findNodes({ query: '((((((((( foo )))))))))', mode: 'hybrid', filter: { memoryIds: [graph.id] } });
    expect(r.degraded).toContain('literal_fallback');
  });
});

describe('#435 stop-words-only is an empty answer, not a refusal or a flag', () => {
  it('keyword', async () => {
    const r = await findNodes({ query: 'the of and', mode: 'keyword', filter: { memoryIds: [graph.id] } });
    expect(r.hits).toEqual([]);
    expect(r.degraded ?? null).toBeNull();
  });

  it('answers from the pre-flight alone: no nodes scan is issued for a query that can match nothing', async () => {
    const spy = vi.spyOn(db, '$queryRawUnsafe');
    expect(await provider.lexicalSearch({ db, memoryIds: [graph.id], query: 'the of and', limit: 10 })).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe('#435 hadron_find_nodes gives the same refusals', () => {
  it('the length bound and the negation refusal read as text through MCP', async () => {
    const user = await db.user.create({ data: { githubId: 43501, githubUsername: 'mcp-435', roles: ['OWNER'] } });
    const mcp = createTestableMcpServer({ userId: user.id, roles: ['OWNER'], clientId: `user:${user.id}` } as never);
    const memoryUrn = `hrn:mem:${graph.urn}`;
    expect(await mcp.callToolText('hadron_find_nodes', { query: long(513), memoryUrn } as never)).toMatch(/too long/i);
    expect(await mcp.callToolText('hadron_find_nodes', { query: '-foo', memoryUrn, mode: 'keyword' } as never)).toMatch(/only excludes/i);
    expect(embed).not.toHaveBeenCalled();
  });
});
