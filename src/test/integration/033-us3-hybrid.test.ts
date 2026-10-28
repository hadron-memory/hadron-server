import { randomUUID } from 'node:crypto';
/**
 * 033-rag-vector-retrieval US3 — mode:hybrid (RRF fusion) on hadron_find_nodes.
 *
 * What US3 pins (SC-007):
 *   - No `mode` → byte-identical to today's keyword search (no [degraded],
 *     no [score], no extra envelope fields). This is the "first do no harm"
 *     gate for existing callers.
 *   - `mode:hybrid` runs keyword + vector in parallel, re-ranks keyword by
 *     relevance (distinct query terms matched / total term frequency / loc
 *     tiebreak — NOT alphabetical-by-loc as the DB returns it), then
 *     reciprocal-rank-fuses with k=60.
 *   - A node that ranks in BOTH halves beats one that only shows up in
 *     one. RRF places the both-signal node above single-signal nodes.
 *
 * Hermetic: deterministic stub embedder maps the test queries to known
 * vectors so vectorSearchNodes returns a known ordering. The keyword path
 * uses the real `matchesQuery` substring logic.
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
import type { AuthContext } from '../../middleware/auth.js';

const DIM = 768;

/** Distinct one-hot vector per "category" — small index space → exact ranking. */
function oneHot(slot: number): number[] {
  const v = new Array(DIM).fill(0);
  v[slot % DIM] = 1;
  return v;
}

/** Deterministic stub: maps text→fixed vector by explicit map. */
function stubClient(map: Record<string, number[]>): EmbeddingClient {
  return {
    provider: 'test',
    model: 'stub-model',
    dim: DIM,
    async embed(texts: string[]) {
      return texts.map((t) => map[t] ?? oneHot(0));
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

async function seedNode(opts: {
  loc: string;
  name?: string;
  abstract?: string;
  description?: string;
  tags?: string[];
  embedAs?: number[];
}): Promise<string> {
  const nodeId = generateId();
  await db.node.create({
    data: {
      id: nodeId,
      memoryId: memId,
      loc: opts.loc,
      name: opts.name ?? opts.loc,
      abstract: opts.abstract ?? null,
      description: opts.description ?? null,
      tags: opts.tags ?? [],
      embeddingPendingAt: opts.embedAs ? new Date() : null, embeddingWorkToken: opts.embedAs ? randomUUID() : null,
    },
  });
  if (opts.embedAs) {
    // Drive the real embedNode path with an injected plaintext so the
    // abstract gets embedded as the supplied vector via the stub map.
    const outcome = await embedNode(db, nodeId, { abstract: opts.abstract ?? null });
    expect(outcome).toBe('embedded');
  }
  return nodeId;
}

beforeEach(async () => {
  await cleanDb(db);
  process.env.EMBEDDING_API_URL = 'http://stub.local/api/embed';

  orgUrn = `us3-org-${generateId().slice(0, 8)}`;
  const org = await db.organization.create({
    data: { id: generateId(), name: orgUrn, urn: orgUrn },
  });
  const admin = await db.user.create({
    data: { githubId: 9903, githubUsername: 'us3-admin', roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });
  adminId = admin.id;

  memUrn = `${orgUrn}:us3mem`;
  const mem = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: memUrn,
      name: 'us3mem',
      class: 'knowledge',
      vectorIndexEnabled: true,
    },
  });
  memId = mem.id;
});

afterAll(() => {
  resetEmbeddingClientForTests();
  delete process.env.EMBEDDING_API_URL;
});

async function findNodes(args: {
  query: string;
  mode?: 'keyword' | 'vector' | 'hybrid';
}): Promise<string> {
  const srv = createTestableMcpServer(adminAuth());
  const params: Record<string, unknown> = {
    query: args.query,
    memoryUrn: memUrn,
  };
  if (args.mode) params.mode = args.mode;
  return srv.callToolText('hadron_find_nodes', params);
}

describe('US3 — `mode:hybrid` runs RRF over keyword + vector halves', () => {
  it('no `mode` is byte-identical to mode:keyword (FR-018, SC-007 keyword-default gate)', async () => {
    await seedNode({ loc: 'kw-a', name: 'kw-a', description: 'matches alpha' });
    await seedNode({ loc: 'kw-b', name: 'kw-b', description: 'matches alpha too' });

    const noMode = await findNodes({ query: 'alpha' });
    const explicit = await findNodes({ query: 'alpha', mode: 'keyword' });
    expect(noMode).toBe(explicit);
  });

  it('both-signal node ranks ABOVE single-signal nodes (RRF SC-007)', async () => {
    // Vector setup: query embeds to slot 1; vec-a embeds to slot 1 (exact
    // semantic match), kw-only-c has no vector at all. The keyword query
    // matches the names of both "both-a" (keyword + vector) and "kw-only-c"
    // (keyword only). The vector half returns just "both-a".
    //
    // Expected RRF:
    //   both-a: rank 1 in keyword, rank 1 in vector → 1/61 + 1/61
    //   kw-only-c: rank 2 in keyword, absent from vector → 1/62
    //   So both-a comes first.
    setEmbeddingClientForTests(
      stubClient({
        'shared signal': oneHot(1),
      }),
    );
    await seedNode({
      loc: 'both-a',
      name: 'shared signal both-a',
      abstract: 'shared signal',
      embedAs: oneHot(1),
    });
    await seedNode({
      loc: 'kw-only-c',
      name: 'shared signal kw-only-c',
      // No abstract → no vector. matchesQuery still hits it on the name.
    });

    const out = await findNodes({ query: 'shared signal', mode: 'hybrid' });
    // Format is a markdown list — both-a should appear BEFORE kw-only-c.
    const bothAIdx = out.indexOf('both-a');
    const kwOnlyIdx = out.indexOf('kw-only-c');
    expect(bothAIdx).toBeGreaterThan(-1);
    expect(kwOnlyIdx).toBeGreaterThan(-1);
    expect(bothAIdx).toBeLessThan(kwOnlyIdx);
  });

  it('hybrid surfaces vector-only hits the keyword half would miss', async () => {
    // Vector-only node: abstract that DOESN'T match the keyword query but
    // embeds near the query vector. Keyword half returns nothing for the
    // "completely unrelated keyword" query. Hybrid must still surface the
    // vector-only hit via the vector half.
    setEmbeddingClientForTests(
      stubClient({
        completelyUnrelatedKeyword: oneHot(7),
      }),
    );
    await seedNode({
      loc: 'vec-only-d',
      name: 'vec-only-d',
      abstract: 'semantically aligned',
      embedAs: oneHot(7),
    });

    const out = await findNodes({ query: 'completelyUnrelatedKeyword', mode: 'hybrid' });
    expect(out).toContain('vec-only-d');
  });

  it('mode:hybrid on an unindexed memory degrades to keyword + emits the [degraded] flag', async () => {
    // Disable the index on this memory so mode:hybrid has no vector half
    // to run.
    await db.memory.update({ where: { id: memId }, data: { vectorIndexEnabled: false } });
    await seedNode({ loc: 'kw-only-e', name: 'kw-only-e', description: 'matches beta' });

    const out = await findNodes({ query: 'beta', mode: 'hybrid' });
    expect(out).toContain('[degraded:no_vector_index]');
    expect(out).toContain('kw-only-e');
  });
});
