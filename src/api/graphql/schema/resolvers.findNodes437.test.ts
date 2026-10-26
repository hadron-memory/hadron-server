/**
 * #437 — the findNodes page-size contract: `limit` is truncated and clamped to
 * [1, 200] and `offset` floors at 0 in ONE normalizer at the top of the core,
 * before any mode path runs, so no caller can request an unbounded hydrated
 * page (multi-GB include + batch decryption → OOM) or push a negative
 * LIMIT/OFFSET into SQL (raw "LIMIT must not be negative" surfaced as
 * INTERNAL_SERVER_ERROR). The MCP `hadron_find_nodes` tool and the
 * `findObjects` sugar both delegate to this core and inherit the clamp; the
 * MCP wire pins live in src/mcp/server.findNodes437.test.ts.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { setEmbeddingClientForTests, resetEmbeddingClientForTests, type EmbeddingClient } from '../../../lib/embedding/index.js';
import { embedNode } from '../../../jobs/embedNodes.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const DIM = 768;
const stubClient: EmbeddingClient = {
  provider: 'test',
  model: 'stub-model',
  dim: DIM,
  // Every text embeds onto the same vector, so vector ranking is uniform and
  // the page is exactly the ANN window's first `limit` candidates.
  async embed(texts: string[]) {
    return texts.map(() => {
      const v = new Array(DIM).fill(0);
      v[1] = 1;
      return v;
    });
  },
};

let admin: { id: string };
let memory: { id: string; urn: string };
const as = (): Context => ({ db, userId: admin.id, roles: ['ADMIN'] });
const findNodes = (args: Record<string, unknown>) => (resolvers.Query as any).findNodes(null, args, as());
const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;
const N = 205; // one past the 200 cap, in every mode's pin

beforeEach(async () => {
  await cleanDb(db);
  process.env.EMBEDDING_API_URL = 'http://stub.local/api/embed';
  setEmbeddingClientForTests(stubClient);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Clamp Org', urn: 'clamp437.example' } });
  admin = await db.user.create({ data: { id: generateId(), handle: 'clamp-admin', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  memory = await M.createMemory(null, { orgId: org.id, name: 'clamp' }, as());
  await db.node.createMany({
    data: Array.from({ length: N }, (_, i) => ({
      id: generateId(), memoryId: memory.id, loc: `doc:${String(i).padStart(4, '0')}`,
      name: `Corridor doc ${i}`, abstract: 'corridor policy', content: 'corridor policy text',
    })),
  });
});

afterAll(() => {
  resetEmbeddingClientForTests();
  delete process.env.EMBEDDING_API_URL;
});

describe('#437 browse (query omitted — the Prisma skip/take path)', () => {
  it('limit 500000 returns exactly 200 of 205 nodes, not every match', async () => {
    const res = await findNodes({ filter: { memoryIds: [memory.id] }, limit: 500000 });
    expect(res.hits).toHaveLength(200);
  });

  it('limit -1 behaves as limit 1 (the first row), never a negative take from the end', async () => {
    const clamped = await findNodes({ filter: { memoryIds: [memory.id] }, limit: -1, sort: 'loc' });
    const one = await findNodes({ filter: { memoryIds: [memory.id] }, limit: 1, sort: 'loc' });
    expect(clamped.hits.map((h: any) => h.node.id)).toEqual(one.hits.map((h: any) => h.node.id));
    expect(clamped.hits).toHaveLength(1);
  });

  it('limit 0 behaves as limit 1, not an empty or negative page', async () => {
    const res = await findNodes({ filter: { memoryIds: [memory.id] }, limit: 0, sort: 'loc' });
    expect(res.hits.map((h: any) => h.node.loc)).toEqual(['doc:0000']);
  });

  it('offset -5 floors at 0 (the first page), never a raw negative OFFSET error', async () => {
    const res = await findNodes({ filter: { memoryIds: [memory.id] }, limit: 5, offset: -5, sort: 'loc' });
    expect(res.hits.map((h: any) => h.node.loc)).toEqual(['doc:0000', 'doc:0001', 'doc:0002', 'doc:0003', 'doc:0004']);
  });

  it('offset 1.5 truncates to 1 (defensive: GraphQL Int already rejects fractions)', async () => {
    const res = await findNodes({ filter: { memoryIds: [memory.id] }, limit: 2, offset: 1.5, sort: 'loc' });
    expect(res.hits.map((h: any) => h.node.loc)).toEqual(['doc:0001', 'doc:0002']);
  });

  it('an omitted limit keeps the default 20', async () => {
    const res = await findNodes({ filter: { memoryIds: [memory.id] }, sort: 'loc' });
    expect(res.hits).toHaveLength(20);
  });
});

describe('#437 keyword + regex (the SQL LIMIT/OFFSET bind path)', () => {
  it('limit 500000 returns exactly 200 of 205 matches, not every hydrated match', async () => {
    const res = await findNodes({ query: 'corridor', filter: { memoryIds: [memory.id] }, limit: 500000 });
    expect(res.hits).toHaveLength(200);
  });

  it('limit -1 clamps to 1 instead of the raw "LIMIT must not be negative" 500', async () => {
    const res = await findNodes({ query: 'corridor', filter: { memoryIds: [memory.id] }, limit: -1 });
    expect(res.hits).toHaveLength(1);
  });

  it('offset -5 floors at 0 instead of the raw "OFFSET must not be negative" 500', async () => {
    const res = await findNodes({ query: 'corridor', filter: { memoryIds: [memory.id] }, limit: 5, offset: -5 });
    expect(res.hits).toHaveLength(5);
  });

  it('regex mode clamps too (same SQL bind path): limit -1 resolves to one hit', async () => {
    const res = await findNodes({ query: 'corridor.*', mode: 'regex', filter: { memoryIds: [memory.id] }, limit: -1 });
    expect(res.hits).toHaveLength(1);
  });
});

describe('#437 vector (the widenVectorWindow page = off + finalLimit path)', () => {
  beforeEach(async () => {
    await db.memory.update({ where: { id: memory.id }, data: { vectorIndexEnabled: true } });
    for (const node of await db.node.findMany({ where: { memoryId: memory.id, deletedAt: null } })) {
      await db.node.update({ where: { id: node.id }, data: { embeddingWorkToken: randomUUID(), embeddingPendingAt: new Date() } });
      expect(['embedded', 'skipped']).toContain(await embedNode(db, node.id, { abstract: node.abstract }));
    }
    await vi.waitFor(async () => {
      const unembedded = await db.node.count({ where: { memoryId: memory.id, deletedAt: null, loc: { startsWith: 'doc:' }, embeddings: { none: {} } } });
      expect(unembedded).toBe(0);
    });
  });

  it('limit 500000 fetches a 200-node window, not a 500000-candidate ANN scan + hydration', async () => {
    const res = await findNodes({ query: 'corridor', mode: 'vector', filter: { memoryIds: [memory.id] }, limit: 500000 });
    expect(res.hits).toHaveLength(200);
  });

  it('limit -1 clamps to 1 in vector mode', async () => {
    const res = await findNodes({ query: 'corridor', mode: 'vector', filter: { memoryIds: [memory.id] }, limit: -1 });
    expect(res.hits).toHaveLength(1);
  });
});

describe('#437 access filtering before paging (guard, green by design)', () => {
  it('a caller paged into an interleaved unreadable memory never sees its nodes', async () => {
    const org2 = await db.organization.create({ data: { id: generateId(), name: 'Other Org', urn: 'other437.example' } });
    const stranger = await db.user.create({ data: { id: generateId(), handle: 'stranger437', roles: [] } });
    await db.orgMember.create({ data: { organizationId: org2.id, userId: stranger.id, role: 'ADMIN' } });
    const other = await db.memory.create({ data: { id: generateId(), organizationId: org2.id, class: 'knowledge', name: 'Other', urn: 'other437.example:corpus' } });
    // Interleave by loc: odd locs belong to the unreadable memory.
    await db.node.createMany({
      data: Array.from({ length: 5 }, (_, i) => ({
        id: generateId(), memoryId: other.id, loc: `mix:${String(i * 2 + 1).padStart(4, '0')}`,
        name: `Other ${i}`, abstract: 'corridor policy', content: 'corridor policy text',
      })),
    });
    await db.node.createMany({
      data: Array.from({ length: 3 }, (_, i) => ({
        id: generateId(), memoryId: memory.id, loc: `mix:${String(i * 2).padStart(4, '0')}`,
        name: `Mine ${i}`, abstract: 'corridor policy', content: 'corridor policy text',
      })),
    });
    const member = await db.user.create({ data: { id: generateId(), handle: 'member437', roles: [] } });
    await db.orgMember.create({ data: { organizationId: (await db.memory.findUniqueOrThrow({ where: { id: memory.id } })).organizationId!, userId: member.id, role: 'READER' } });
    const scoped: Context = { db, userId: member.id, roles: [] };
    const res = await (resolvers.Query as any).findNodes(null, { filter: {}, sort: 'loc', limit: 3, offset: 0 }, scoped);
    expect(res.hits.map((h: any) => h.node.loc)).toEqual(['mix:0000', 'mix:0002', 'mix:0004']);
    expect(res.hits.every((h: any) => h.node.memoryId === memory.id)).toBe(true);
  });
});
