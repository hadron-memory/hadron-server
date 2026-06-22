/**
 * #234 — nodeSearch / hadron_find_nodes must degrade gracefully when the
 * embedding endpoint is configured but unreachable at query time.
 *
 * The bug: the vector + hybrid branches of both surfaces (GraphQL
 * `Query.nodeSearch` and MCP `hadron_find_nodes`) called `embed()` outside
 * any try/catch. When the endpoint was up at config time but down at
 * query time (service crashed, DNS failed, egress blocked), the raw
 * `EmbeddingRequestError: fetch failed` propagated out of the resolver
 * — zero results, including for the keyword half of hybrid that would
 * have worked.
 *
 * The fix: wrap the `embed()` call. Mirror the existing
 * `no_vector_index` degrade path:
 *
 *   - vector → empty envelope with `reason: 'embedding_unavailable'`
 *   - hybrid → keyword-only results with `degraded: 'embedding_unavailable'`
 *
 * These tests stub the embedding client so its `embed()` rejects with
 * the same shape the real HTTP client throws (`EmbeddingRequestError`)
 * and assert the degrade fires on both surfaces.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { generateId } from '../../lib/id.js';
import type { EmbeddingClient } from '../../lib/embedding/index.js';
import {
  EmbeddingRequestError,
  setEmbeddingClientForTests,
  resetEmbeddingClientForTests,
} from '../../lib/embedding/index.js';
import { createTestableMcpServer } from '../../mcp/server.js';
import { resolvers, type Context as GqlContext } from '../../api/graphql/schema/resolvers.js';
import type { AuthContext } from '../../middleware/auth.js';

const DIM = 768;

/**
 * Stub client whose embed() throws the same error shape the real HTTP
 * client raises on a connection failure. Mirrors what
 * `HttpEmbeddingClient.embed` does in its catch block at
 * src/lib/embedding/client.ts:99-101.
 */
function unreachableClient(): EmbeddingClient {
  return {
    provider: 'test',
    model: 'stub-model',
    dim: DIM,
    async embed() {
      throw new EmbeddingRequestError('fetch failed');
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

beforeEach(async () => {
  await cleanDb(db);
  // Endpoint is "configured" so the resolvers don't take the
  // !isEmbeddingConfigured() degrade path — but the stub client's
  // embed() throws, simulating "configured but unreachable at
  // query time" (the #234 repro). vi.stubEnv is the project
  // convention (PR-191 review) so the override doesn't leak to
  // later test files sharing the worker.
  vi.stubEnv('EMBEDDING_API_URL', 'http://stub.local/api/embed');
  setEmbeddingClientForTests(unreachableClient());

  orgUrn = `i234-org-${generateId().slice(0, 8)}`;
  const org = await db.organization.create({
    data: { id: generateId(), name: orgUrn, urn: orgUrn },
  });
  const admin = await db.user.create({
    data: { githubId: 9914, githubUsername: 'i234-admin', roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });
  adminId = admin.id;

  memUrn = `${orgUrn}:i234mem`;
  const mem = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: memUrn,
      name: 'i234mem',
      class: 'knowledge',
      // Vector index ENABLED — the #234 bug only fires when the
      // memory IS indexed (so the search reaches the embed() call
      // for the query vector). Without an index it takes the
      // no_vector_index degrade path earlier in the resolver.
      vectorIndexEnabled: true,
    },
  });
  memId = mem.id;
});

afterAll(() => {
  resetEmbeddingClientForTests();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// GraphQL — Query.nodeSearch
// ---------------------------------------------------------------------------

describe('#234 — GraphQL nodeSearch degrades when embed() throws', () => {
  it('mode:hybrid → falls back to keyword hits with degraded:embedding_unavailable', async () => {
    await seedNode({ loc: 'a-kw-only', description: 'matches alpha' });
    await seedNode({ loc: 'b-kw-only', description: 'matches alpha' });
    await seedNode({ loc: 'noise', description: 'unrelated' });

    const result = await resolvers.Query.nodeSearch(
      {},
      { query: 'alpha', memoryUrn: memUrn, mode: 'hybrid' },
      adminCtx(),
    );

    // Pre-fix: this throws `EmbeddingRequestError: fetch failed`.
    // Post-fix: keyword hits are surfaced with the degraded flag set.
    expect(result.degraded).toBe('embedding_unavailable');
    expect(result.reason).toBeNull();
    const locs = (result.nodes as Array<{ loc: string }>).map((n) => n.loc);
    expect(locs).toContain('a-kw-only');
    expect(locs).toContain('b-kw-only');
    expect(locs).not.toContain('noise');
  });

  it('mode:vector → empty envelope with reason:embedding_unavailable', async () => {
    await seedNode({ loc: 'kw-hit', description: 'matches beta' });

    const result = await resolvers.Query.nodeSearch(
      {},
      { query: 'beta', memoryUrn: memUrn, mode: 'vector' },
      adminCtx(),
    );

    expect(result.reason).toBe('embedding_unavailable');
    expect(result.degraded).toBeNull();
    expect(result.nodes).toEqual([]);
    // Vector mode is explicit; the caller asked for vector. No
    // silent fall-back to keyword (would surprise a caller that
    // wired their UI around vector-only).
  });

  it('mode:keyword is unaffected (never reaches the embed() call)', async () => {
    await seedNode({ loc: 'kw-direct', description: 'matches gamma' });

    const result = await resolvers.Query.nodeSearch(
      {},
      { query: 'gamma', memoryUrn: memUrn, mode: 'keyword' },
      adminCtx(),
    );

    expect(result.reason).toBeNull();
    expect(result.degraded).toBeNull();
    const locs = (result.nodes as Array<{ loc: string }>).map((n) => n.loc);
    expect(locs).toContain('kw-direct');
  });
});

// ---------------------------------------------------------------------------
// MCP — hadron_find_nodes
// ---------------------------------------------------------------------------

describe('#234 — MCP hadron_find_nodes degrades when embed() throws', () => {
  it('mode:vector → returns the [embedding_unavailable] envelope, does not throw', async () => {
    await seedNode({ loc: 'noise', description: 'unrelated' });

    const srv = createTestableMcpServer(adminAuth());
    // Pre-fix: this throws `EmbeddingRequestError: fetch failed`.
    // Post-fix: the [embedding_unavailable] envelope is returned.
    const out = await srv.callToolText('hadron_find_nodes', {
      query: 'natural language query',
      memoryUrn: memUrn,
      mode: 'vector',
    });

    expect(out).toContain('[embedding_unavailable]');
    expect(out).toContain('embed() failed');
    expect(out).toContain('Found 0 node(s)');
  });

  it('mode:hybrid → falls back to keyword-only with [degraded:embedding_unavailable]', async () => {
    await seedNode({ loc: 'a-kw-only', description: 'matches delta' });
    await seedNode({ loc: 'b-kw-only', description: 'matches delta' });
    await seedNode({ loc: 'noise', description: 'unrelated' });

    const srv = createTestableMcpServer(adminAuth());
    const out = await srv.callToolText('hadron_find_nodes', {
      query: 'delta',
      memoryUrn: memUrn,
      mode: 'hybrid',
    });

    // The degraded note is prepended to the keyword-only output.
    expect(out).toContain('[degraded:embedding_unavailable]');
    expect(out).toContain('vector half unavailable');
    expect(out).toContain('embed() failed');
    // Keyword hits are surfaced.
    expect(out).toContain('a-kw-only');
    expect(out).toContain('b-kw-only');
    expect(out).not.toContain('noise');
  });

  it('mode:keyword is unaffected (never reaches the embed() call)', async () => {
    await seedNode({ loc: 'kw-direct', description: 'matches epsilon' });

    const srv = createTestableMcpServer(adminAuth());
    const out = await srv.callToolText('hadron_find_nodes', {
      query: 'epsilon',
      memoryUrn: memUrn,
      mode: 'keyword',
    });

    expect(out).not.toContain('[embedding_unavailable]');
    expect(out).not.toContain('[degraded:');
    expect(out).toContain('kw-direct');
  });
});
