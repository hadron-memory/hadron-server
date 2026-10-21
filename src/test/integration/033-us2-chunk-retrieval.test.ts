/**
 * 033-rag-vector-retrieval US2 — content-chunk retrieval (SC-005).
 *
 * What US2 pins:
 *   - Memory opted into `embeddingSource: contentChunks` writes one
 *     `kind='chunk'` row per chunk, each carrying chunkIndex / charStart
 *     / charEnd / chunkText locator metadata.
 *   - `granularity: chunk` returns passages (the chunk hits themselves);
 *     `granularity: node` (default) collapses chunk hits to ranked node
 *     URNs via MIN(distance) per node.
 *   - Same hit set produces consistent results under both granularities
 *     — chunk hits and the collapsed node hits agree on which nodes are
 *     relevant.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { generateId } from '../../lib/id.js';
import type { EmbeddingClient } from '../../lib/embedding/index.js';
import {
  setEmbeddingClientForTests,
  resetEmbeddingClientForTests,
} from '../../lib/embedding/index.js';
import { embedNode } from '../../jobs/embedNodes.js';
import { createTestableMcpServer } from '../../mcp/server.js';
import { resolvers, type Context as GqlContext } from '../../api/graphql/schema/resolvers.js';
import type { AuthContext } from '../../middleware/auth.js';

const DIM = 768;

/** Deterministic stub: maps known chunk texts to fixed vectors. */
function stubClient(map: Record<string, number[]>): EmbeddingClient {
  return {
    provider: 'test',
    model: 'stub-model',
    dim: DIM,
    async embed(texts: string[]) {
      return texts.map((t) => {
        // Match by substring so multi-chunk content with section headers
        // doesn't have to be byte-exact in the test map.
        for (const [key, vec] of Object.entries(map)) {
          if (t.includes(key)) return vec;
        }
        // Fallback: orthogonal-ish vector keyed by string length so each
        // unmapped chunk lands far from the mapped ones.
        const v = new Array(DIM).fill(0);
        v[(t.length * 7) % DIM] = 1;
        return v;
      });
    },
  };
}

function oneHot(slot: number): number[] {
  const v = new Array(DIM).fill(0);
  v[slot % DIM] = 1;
  return v;
}

let orgUrn: string;
let memUrn: string;
let memId: string;
let adminId: string;

function adminAuth(): AuthContext {
  return { userId: adminId, roles: ['ADMIN'], clientId: `user:${adminId}` };
}
function adminCtx(): GqlContext {
  return { db, roles: ['ADMIN'], userId: adminId };
}

/**
 * Each test's fixture: an empty database, then one chunk-indexed memory.
 * #2201 — the VACUUM drops the dead HNSW entries earlier files leave behind
 * (`cleanDb` deletes rows, which never shrinks the graph); without it an HNSW
 * plan can return no passages while live chunks exist.
 */
async function setUpSuite(): Promise<void> {
  await cleanDb(db);
  await db.$executeRawUnsafe('VACUUM node_embeddings');
  process.env.EMBEDDING_API_URL = 'http://stub.local/api/embed';

  orgUrn = `us2-org-${generateId().slice(0, 8)}`;
  const org = await db.organization.create({
    data: { id: generateId(), name: orgUrn, urn: orgUrn },
  });
  const admin = await db.user.create({
    data: { githubId: 9912, githubUsername: 'us2-admin', roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });
  adminId = admin.id;

  memUrn = `${orgUrn}:us2mem`;
  const mem = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: memUrn,
      name: 'us2mem',
      class: 'knowledge',
      vectorIndexEnabled: true,
      embeddingSource: 'contentChunks',
    },
  });
  memId = mem.id;
}

beforeEach(setUpSuite);

afterAll(() => {
  resetEmbeddingClientForTests();
  delete process.env.EMBEDDING_API_URL;
});

async function seedNodeWithChunks(loc: string, content: string): Promise<string> {
  const nodeId = generateId();
  await db.node.create({
    data: {
      id: nodeId,
      memoryId: memId,
      loc,
      name: loc,
      content,
      embeddingPendingAt: new Date(),
    },
  });
  const outcome = await embedNode(db, nodeId);
  expect(outcome).toBe('embedded');
  return nodeId;
}

describe('US2 — chunk-level retrieval (SC-005)', () => {
  it('contentChunks memory writes kind=chunk rows with full locator metadata', async () => {
    // Stub returns slot-1 for every chunk so the embed call succeeds; we
    // care about the row shape here, not the search ranking.
    setEmbeddingClientForTests(stubClient({}));

    const md = '# Intro\nFirst section body.\n\n## Section B\nSecond section body.\n\n## Section C\nThird section body.';
    await seedNodeWithChunks('multi-section', md);

    const rows = await db.$queryRaw<
      { kind: string; chunk_index: number; char_start: number; char_end: number; chunk_text: string }[]
    >`
      SELECT kind, chunk_index, char_start, char_end, chunk_text
      FROM node_embeddings
      WHERE memory_id = ${memId}
      ORDER BY chunk_index ASC
    `;
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.kind === 'chunk')).toBe(true);
    expect(rows.map((r) => r.chunk_index)).toEqual([0, 1, 2]);
    // Locator metadata round-trips: each row's stored text equals the
    // span the offsets point at in the original content.
    for (const r of rows) {
      expect(md.slice(r.char_start, r.char_end)).toBe(r.chunk_text);
    }
  });

  it('granularity:chunk returns passages, granularity:node collapses to one entry per node', async () => {
    // Stub: the "alpha" string anchors a known vector; all other chunks
    // get the orthogonal fallback so the search has exactly one strong
    // chunk hit (and one node hit by collapse).
    setEmbeddingClientForTests(
      stubClient({
        alpha: oneHot(1),
      }),
    );

    const md = '# Intro\nThe alpha keyword goes here.\n\n## Section B\nOther body.\n\n## Section C\nMore content.';
    await seedNodeWithChunks('with-alpha', md);

    const srv = createTestableMcpServer(adminAuth());
    // chunk-level — should surface the passage with chunkIndex 0 (the
    // section containing "alpha").
    const chunkOut = await srv.callToolText('hadron_find_nodes', {
      query: 'alpha',
      mode: 'vector',
      memoryUrn: memUrn,
      granularity: 'chunk',
      limit: 5,
    });
    expect(chunkOut).toContain('passage(s)');
    expect(chunkOut).toContain('[chunk 0 @ chars');
    expect(chunkOut).toContain('alpha keyword');
    // node-level — should surface the parent node URN once (despite the
    // node having 3 chunks).
    const nodeOut = await srv.callToolText('hadron_find_nodes', {
      query: 'alpha',
      mode: 'vector',
      memoryUrn: memUrn,
      limit: 5,
    });
    expect(nodeOut).toContain('with-alpha');
    expect(nodeOut).toContain('node(s)');
    // Exactly one occurrence of the URN bullet — collapse worked.
    const bulletMatches = nodeOut.match(/^- \*\*[^*]+with-alpha/gm) ?? [];
    expect(bulletMatches.length).toBe(1);
  });

  it('content edit on a chunk-indexed node re-derives the chunks (FR-017)', async () => {
    setEmbeddingClientForTests(stubClient({}));

    // Initial content: 2 sections → 2 chunks.
    const initial = '# A\nfirst version body.\n\n## B\nsecond section.';
    const nodeId = await seedNodeWithChunks('editable', initial);
    const initialRows = await db.$queryRaw<{ chunk_index: number; chunk_text: string }[]>`
      SELECT chunk_index, chunk_text FROM node_embeddings WHERE node_id = ${nodeId} ORDER BY chunk_index
    `;
    expect(initialRows.length).toBe(2);
    expect(initialRows[0].chunk_text).toContain('first version body');

    // Edit: same node, completely different content. The sweep re-derives
    // chunks against the new content and replaces the prior rows.
    await db.node.update({
      where: { id: nodeId },
      data: {
        content: '# X\nedited first.\n\n## Y\nedited second.\n\n## Z\nedited third.',
        embeddingPendingAt: new Date(),
      },
    });
    const outcome = await embedNode(db, nodeId);
    expect(outcome).toBe('embedded');

    const editedRows = await db.$queryRaw<{ chunk_index: number; chunk_text: string }[]>`
      SELECT chunk_index, chunk_text FROM node_embeddings WHERE node_id = ${nodeId} ORDER BY chunk_index
    `;
    // Old chunks are gone; new chunks reflect the edited content.
    expect(editedRows.length).toBe(3);
    expect(editedRows[0].chunk_text).toContain('edited first');
    expect(editedRows[0].chunk_text).not.toContain('first version body');
  });

  it('embeddingSource:both writes one abstract row AND N chunk rows', async () => {
    setEmbeddingClientForTests(stubClient({}));

    await db.memory.update({ where: { id: memId }, data: { embeddingSource: 'both' } });

    const nodeId = generateId();
    await db.node.create({
      data: {
        id: nodeId,
        memoryId: memId,
        loc: 'dual-indexed',
        name: 'dual-indexed',
        abstract: 'A short summary.',
        content: '# Section 1\nbody one\n\n## Section 2\nbody two',
        embeddingPendingAt: new Date(),
      },
    });
    await embedNode(db, nodeId);

    const rows = await db.$queryRaw<{ kind: string }[]>`
      SELECT kind FROM node_embeddings WHERE node_id = ${nodeId} ORDER BY kind, chunk_index NULLS FIRST
    `;
    // Exactly one abstract row + 2 chunk rows.
    const abstractRows = rows.filter((r) => r.kind === 'abstract');
    const chunkRows = rows.filter((r) => r.kind === 'chunk');
    expect(abstractRows.length).toBe(1);
    expect(chunkRows.length).toBe(2);
  });
});

describe('US2 — granularity:chunk rejection (PR-225 review)', () => {
  it('MCP hadron_find_nodes: granularity:chunk with mode:hybrid → text reject', async () => {
    setEmbeddingClientForTests(stubClient({}));
    const srv = createTestableMcpServer(adminAuth());
    const out = await srv.callToolText('hadron_find_nodes', {
      query: 'anything',
      mode: 'hybrid',
      memoryUrn: memUrn,
      granularity: 'chunk',
    });
    expect(out).toContain('granularity:chunk requires mode:vector');
    expect(out).toContain('mode:hybrid');
  });

  it('MCP hadron_find_nodes: granularity:chunk with mode:keyword (or default) → text reject', async () => {
    setEmbeddingClientForTests(stubClient({}));
    const srv = createTestableMcpServer(adminAuth());
    // No mode → defaults to keyword. Spec is the same: chunk needs
    // mode:vector explicitly.
    const out = await srv.callToolText('hadron_find_nodes', {
      query: 'anything',
      memoryUrn: memUrn,
      granularity: 'chunk',
    });
    expect(out).toContain('granularity:chunk requires mode:vector');
    expect(out).toContain('mode:keyword');
  });

  it('GraphQL findNodes: granularity:chunk with mode:hybrid → GraphQLError(BAD_USER_INPUT)', async () => {
    setEmbeddingClientForTests(stubClient({}));
    await expect(
      resolvers.Query.findNodes(
        {},
        {
          query: 'anything',
          filter: { memoryIds: [memUrn] },
          mode: 'hybrid',
          granularity: 'chunk',
        },
        adminCtx(),
      ),
    ).rejects.toMatchObject({
      extensions: { code: 'BAD_USER_INPUT' },
      message: expect.stringContaining('granularity:chunk is only supported in mode:vector'),
    });
  });

  it('GraphQL findNodes: granularity:chunk + mode:vector still works (positive control)', async () => {
    setEmbeddingClientForTests(stubClient({}));
    // Seed at least one chunked node so the path returns something.
    await seedNodeWithChunks('positive-control', '# A\nbody.\n\n## B\nmore.');
    const result = await resolvers.Query.findNodes(
      {},
      {
        query: 'anything',
        filter: { memoryIds: [memUrn] },
        mode: 'vector',
        granularity: 'chunk',
      },
      adminCtx(),
    );
    expect(result.hits).toEqual([]);
    expect(Array.isArray(result.passages)).toBe(true);
    expect((result.passages as unknown[]).length).toBeGreaterThan(0);
  });

  it('minScore floors chunk passages too (#497 / PR-569 review)', async () => {
    setEmbeddingClientForTests(stubClient({}));
    await seedNodeWithChunks('floor-chunks', '# A\nbody.\n\n## B\nmore.');
    const call = (minScore?: number) =>
      resolvers.Query.findNodes(
        {},
        { query: 'anything', filter: { memoryIds: [memUrn] }, mode: 'vector', granularity: 'chunk', minScore },
        adminCtx(),
      );
    // Baseline: passages present.
    expect(((await call()).passages as unknown[]).length).toBeGreaterThan(0);
    // A floor above any cosine similarity (which is <= 1) drops them all.
    expect((await call(2)).passages).toEqual([]);
  });
});

/**
 * #2201 — `cleanDb` removes vectors by cascaded DELETE, so every earlier file in
 * the worker's database leaves dead entries in the HNSW graph. On an HNSW plan
 * pgvector fills `ef_search` from the graph before dead rows are dropped, so
 * dead entries nearer the query than this file's orthogonal chunks empty the
 * baseline searches above. Forcing the plan makes the CI flake deterministic.
 */
describe('#2201 — dead index entries from earlier files never empty the baseline', () => {
  const PREFER_HNSW = 'SET LOCAL enable_sort = off';
  /** `adminCtx()` whose ANN transaction prefers the HNSW index, as the planner may on CI. */
  const hnswCtx = (): GqlContext => ({
    ...adminCtx(),
    db: new Proxy(db, {
      get(target, prop) {
        const v = Reflect.get(target, prop);
        if (prop !== '$transaction') return typeof v === 'function' ? v.bind(target) : v;
        return (arg: unknown, opts?: unknown) =>
          typeof arg !== 'function'
            ? (target.$transaction as any)(arg, opts)
            : (target.$transaction as any)(async (tx: any) => {
                await tx.$executeRawUnsafe(PREFER_HNSW);
                return (arg as (tx: unknown) => unknown)(tx);
              }, opts);
      },
    }),
  });

  /** Leaves `n` dead chunk vectors equal to `vec`, as an earlier file's cleanup does. */
  async function leaveDeadVectors(n: number, vec: number[]): Promise<void> {
    const nodeId = generateId();
    await db.node.create({ data: { id: nodeId, memoryId: memId, loc: 'earlier-file', name: 'earlier-file', content: 'x' } });
    await db.$executeRawUnsafe(
      `INSERT INTO node_embeddings (id, node_id, memory_id, kind, provider, model, dim, chunk_index, char_start, char_end, chunk_text, embedding)
       SELECT md5(random()::text || g::text), $1, $2, 'chunk', 'test', 'stub-model', ${DIM}, g, 0, 1, 'x', $3::vector
       FROM generate_series(1, ${n}) g`,
      nodeId, memId, `[${vec.join(',')}]`,
    );
    await db.node.delete({ where: { id: nodeId } });
    const [{ n: live }] = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM node_embeddings WHERE node_id = ${nodeId}`;
    expect(live).toBe(0);
  }

  it('the HNSW-preferring handle reaches the index, so the pin below tests what it names', async () => {
    const plan = await hnswCtx().db.$transaction((tx) => tx.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
      `EXPLAIN SELECT ne.node_id FROM node_embeddings ne JOIN nodes n ON n.id = ne.node_id
       WHERE ne.memory_id = '${memId}' AND ne.kind = 'chunk' ORDER BY ne.embedding <=> '[${oneHot(56).join(',')}]'::vector LIMIT 100`));
    expect(plan.map((r) => r['QUERY PLAN']).join('\n')).toContain('node_embeddings_embedding_hnsw');
  });

  it('on the HNSW plan, the suite setup leaves passages findable after 400 dead exact-match vectors', async () => {
    // 'anything' embeds to oneHot(56) under the stub's length fallback; dead
    // vectors at distance 0 outrank the live chunks, which sit at distance 1.
    await leaveDeadVectors(400, oneHot(56));
    await setUpSuite();
    setEmbeddingClientForTests(stubClient({}));
    await seedNodeWithChunks('after-dead', '# A\nbody.\n\n## B\nmore.');
    const result = await resolvers.Query.findNodes(
      {},
      { query: 'anything', filter: { memoryIds: [memUrn] }, mode: 'vector', granularity: 'chunk' },
      hnswCtx(),
    );
    expect((result.passages as unknown[]).length).toBeGreaterThan(0);
  });
});
