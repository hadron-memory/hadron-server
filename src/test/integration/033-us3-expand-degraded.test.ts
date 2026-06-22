/**
 * 033-rag-vector-retrieval US3 — `expand` BFS + the [degraded:no_vector_index]
 * envelope flag on the GraphQL surface.
 *
 * What US3 pins (SC-008 envelope shape + SC-007 expand semantics):
 *   - `expand: 1` appends undirected, all-edge-type neighbors of the ranked
 *     hits, deduplicated against the seed set, scoped to the same memory(ies)
 *     the keyword/vector half searched. Appended AFTER ranked hits, unscored.
 *   - On the MCP text surface, expanded neighbors appear in BFS-traversal
 *     order below the scored hits (no `(score …)` annotation).
 *   - On the GraphQL surface, the `degraded` envelope field carries
 *     `'no_vector_index'` when mode:hybrid had to fall back to keyword
 *     because no in-scope memory was indexed.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { generateId } from '../../lib/id.js';
import { deriveEdgeLoc } from '../../lib/edgeLoc.js';
import type { EmbeddingClient } from '../../lib/embedding/index.js';
import {
  setEmbeddingClientForTests,
  resetEmbeddingClientForTests,
} from '../../lib/embedding/index.js';
import { createTestableMcpServer } from '../../mcp/server.js';
import { resolvers, type Context as GqlContext } from '../../api/graphql/schema/resolvers.js';
import type { AuthContext } from '../../middleware/auth.js';

const DIM = 768;

function stubClient(): EmbeddingClient {
  const fixed = new Array(DIM).fill(0);
  fixed[0] = 1;
  return {
    provider: 'test',
    model: 'stub-model',
    dim: DIM,
    async embed(texts: string[]) {
      return texts.map(() => [...fixed]);
    },
  };
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

async function seedNode(opts: { loc: string; name?: string; description?: string }): Promise<string> {
  const nodeId = generateId();
  await db.node.create({
    data: {
      id: nodeId,
      memoryId: memId,
      loc: opts.loc,
      name: opts.name ?? opts.loc,
      description: opts.description ?? null,
    },
  });
  return nodeId;
}

async function seedEdge(srcId: string, tgtId: string, name = 'rel'): Promise<void> {
  // Spec 037: edges carry a memory-unique `loc` (derived from endpoint locs +
  // name) and `memoryId` (denormalized from the source node). All seeded nodes
  // live in `memId`, so derive both from the endpoints.
  const [src, tgt] = await Promise.all([
    db.node.findUniqueOrThrow({ where: { id: srcId }, select: { loc: true, memoryId: true } }),
    db.node.findUniqueOrThrow({ where: { id: tgtId }, select: { loc: true } }),
  ]);
  await db.edge.create({
    data: {
      id: generateId(),
      memoryId: src.memoryId,
      sourceId: srcId,
      targetId: tgtId,
      loc: deriveEdgeLoc(src.loc, name, tgt.loc),
      name,
    },
  });
}

beforeEach(async () => {
  await cleanDb(db);
  process.env.EMBEDDING_API_URL = 'http://stub.local/api/embed';
  setEmbeddingClientForTests(stubClient());

  orgUrn = `us3x-org-${generateId().slice(0, 8)}`;
  const org = await db.organization.create({
    data: { id: generateId(), name: orgUrn, urn: orgUrn },
  });
  const admin = await db.user.create({
    data: { githubId: 9913, githubUsername: 'us3x-admin', roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });
  adminId = admin.id;

  memUrn = `${orgUrn}:us3xmem`;
  const mem = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: memUrn,
      name: 'us3xmem',
      class: 'knowledge',
      vectorIndexEnabled: false, // disabled for the degraded scenarios; tests enable per-case
    },
  });
  memId = mem.id;
});

afterAll(() => {
  resetEmbeddingClientForTests();
  delete process.env.EMBEDDING_API_URL;
});

describe('US3 — `expand:N` appends undirected neighbors after ranked hits', () => {
  it('expand:1 appends both outgoing AND incoming neighbors (undirected) AFTER ranked hits', async () => {
    // Graph: target ←label1— hub —label2→ leaf,   hub ←label3— back
    // Keyword "hub" matches the hub itself. expand:1 must surface all three
    // neighbors regardless of edge direction.
    const hubId = await seedNode({ loc: 'hub', name: 'hub' });
    const leafId = await seedNode({ loc: 'leaf', name: 'leaf' });
    const backId = await seedNode({ loc: 'back', name: 'back' });
    await seedEdge(hubId, leafId, 'rel-out');
    await seedEdge(backId, hubId, 'rel-in');

    const srv = createTestableMcpServer(adminAuth());
    const out = await srv.callToolText('hadron_find_nodes', {
      query: 'hub',
      memoryUrn: memUrn,
      expand: 1,
    });

    // The hub is the ranked hit; leaf + back are appended undirected
    // neighbors. Order: hub first (ranked), then neighbors (BFS order).
    const hubIdx = out.indexOf('hub');
    const leafIdx = out.indexOf('leaf');
    const backIdx = out.indexOf('back');
    expect(hubIdx).toBeLessThan(leafIdx);
    expect(hubIdx).toBeLessThan(backIdx);
  });

  it('expand:1 does not duplicate seeds (if a neighbor is already in ranked hits, it stays once)', async () => {
    // Both "node-a" and "node-b" match the query AND are neighbors of each
    // other. Without dedup, node-b would appear once as ranked AND again as
    // a neighbor of node-a.
    const aId = await seedNode({ loc: 'node-a', name: 'node-a alpha' });
    const bId = await seedNode({ loc: 'node-b', name: 'node-b alpha' });
    await seedEdge(aId, bId, 'rel');

    const srv = createTestableMcpServer(adminAuth());
    const out = await srv.callToolText('hadron_find_nodes', {
      query: 'alpha',
      memoryUrn: memUrn,
      expand: 1,
    });

    // The render summary "Found N node(s)" reflects total rendered entries.
    // Without dedup we'd see Found 3+ (one of them duplicated). Each loc
    // appears once as `- **<urn>** — <name>`.
    expect(out).toMatch(/Found 2 node\(s\)/);
    const aBullets = out.match(/^- \*\*[^*]*node-a/gm) ?? [];
    const bBullets = out.match(/^- \*\*[^*]*node-b/gm) ?? [];
    expect(aBullets.length).toBe(1);
    expect(bBullets.length).toBe(1);
  });

  it('expand:0 (default) appends nothing', async () => {
    const hubId = await seedNode({ loc: 'hub', name: 'hub' });
    const leafId = await seedNode({ loc: 'leaf', name: 'leaf' });
    await seedEdge(hubId, leafId, 'rel');

    const srv = createTestableMcpServer(adminAuth());
    const out = await srv.callToolText('hadron_find_nodes', {
      query: 'hub',
      memoryUrn: memUrn,
    });
    expect(out).toContain('hub');
    expect(out).not.toContain('leaf');
  });
});

describe('US3 — GraphQL nodeSearch carries the degraded flag in the envelope', () => {
  it('mode:hybrid on a memory without a vector index → keyword results + degraded:no_vector_index', async () => {
    // Memory was created with vectorIndexEnabled: false above. Seed two
    // keyword hits.
    await seedNode({ loc: 'a-kw-only', description: 'matches gamma' });
    await seedNode({ loc: 'b-kw-only', description: 'matches gamma' });

    const result = await resolvers.Query.nodeSearch(
      {},
      { query: 'gamma', memoryUrn: memUrn, mode: 'hybrid' },
      adminCtx(),
    );

    expect(result.degraded).toBe('no_vector_index');
    expect(result.reason).toBeNull();
    expect(result.nodes.length).toBeGreaterThanOrEqual(2);
    const locs = (result.nodes as Array<{ loc: string }>).map((n) => n.loc);
    expect(locs).toContain('a-kw-only');
    expect(locs).toContain('b-kw-only');
  });

  it('mode:vector on a memory without a vector index → empty + reason:no_vector_index', async () => {
    await seedNode({ loc: 'noise', description: 'matches gamma' });

    const result = await resolvers.Query.nodeSearch(
      {},
      { query: 'gamma', memoryUrn: memUrn, mode: 'vector' },
      adminCtx(),
    );

    expect(result.reason).toBe('no_vector_index');
    expect(result.degraded).toBeNull();
    expect(result.nodes).toEqual([]);
  });

  it('mode:keyword via GraphQL nodeSearch returns hits with no degraded flag', async () => {
    await seedNode({ loc: 'kw-x', description: 'matches delta' });
    const result = await resolvers.Query.nodeSearch(
      {},
      { query: 'delta', memoryUrn: memUrn, mode: 'keyword' },
      adminCtx(),
    );
    expect(result.reason).toBeNull();
    expect(result.degraded).toBeNull();
    expect(result.nodes.length).toBe(1);
    expect((result.nodes[0] as { loc: string }).loc).toBe('kw-x');
  });
});
