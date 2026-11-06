import { randomUUID } from 'node:crypto';
/**
 * 033-rag-vector-retrieval US4 — staleness served-and-marked on vector hits.
 *
 * Predicate is spec 032's: `abstractOriginHash !== computeContentHash(node.content)`.
 *
 * What US4 pins (SC-009):
 *   - Stale abstract-vector hits are SERVED (not skipped) AND the rendered hit
 *     carries `Source: abstract-stale`.
 *   - Self-heal: after re-embed drains, abstractOriginHash + the embedded vector
 *     are back in sync with content → marker disappears on the next read.
 *   - Encrypted-memory case: because spec 033 embeds at write time on in-closure
 *     plaintext, `abstractOriginHash` is stamped on plaintext too. On encrypted
 *     memories that wrote through the MCP path (plaintext at rest per #206), the
 *     read-time predicate works. Marker fires correctly — spec 032's
 *     `!memory.isEncrypted` read-time gate is NOT applied to vector-hit rendering
 *     because the comparison inputs are derivable here.
 *   - **Chunk hits never carry the marker** (FR-023): chunks are re-derived from
 *     current content on every edit, so by construction they cannot drift. This
 *     pin is vacuous in US1 (no chunks exist yet); US2's chunk path (T040–T042)
 *     will extend `vectorSearchNodes` to surface the hit's `kind` and the
 *     renderer will then skip the marker for `kind='chunk'`.
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
import { computeContentHash } from '../../lib/contentHash.js';
import { createTestableMcpServer } from '../../mcp/server.js';
import type { AuthContext } from '../../middleware/auth.js';

const DIM = 768;

/** Deterministic stub: same vector every time so the query embedding lands near the seeded one. */
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

interface SeedOpts {
  loc: string;
  abstract: string;
  content: string;
  /** Default `content` — set explicitly to simulate a content edit that left the hash behind. */
  abstractOriginHashFor?: string;
}

/**
 * Create a node row with its abstract vector already embedded and the
 * abstractOriginHash stamped against `abstractOriginHashFor` (defaults to
 * `content` — the in-sync case). Use a different value to simulate the
 * "content edited without re-embed" stale window.
 */
async function seedEmbedded(opts: SeedOpts): Promise<string> {
  const hashAgainst = opts.abstractOriginHashFor ?? opts.content;
  const nodeId = generateId();
  await db.node.create({
    data: {
      id: nodeId,
      memoryId: memId,
      loc: opts.loc,
      name: opts.loc,
      abstract: opts.abstract,
      content: opts.content,
      abstractOriginHash: computeContentHash(hashAgainst),
      embeddingPendingAt: new Date(), embeddingWorkToken: randomUUID(),
    },
  });
  // Drive the real embedNode path so the vector lands in node_embeddings.
  const outcome = await embedNode(db, nodeId);
  expect(outcome).toBe('embedded');
  return nodeId;
}

beforeEach(async () => {
  await cleanDb(db);
  process.env.EMBEDDING_API_URL = 'http://stub.local/api/embed';
  setEmbeddingClientForTests(stubClient());

  orgUrn = `us4-org-${generateId().slice(0, 8)}`;
  const org = await db.organization.create({
    data: { id: generateId(), name: orgUrn, urn: orgUrn },
  });
  const admin = await db.user.create({
    data: { githubId: 9904, githubUsername: 'us4-admin', roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });
  adminId = admin.id;

  memUrn = `${orgUrn}:us4mem`;
  const mem = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: memUrn,
      name: 'us4mem',
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

async function findNodesVector(query: string): Promise<string> {
  const srv = createTestableMcpServer(adminAuth());
  return srv.callToolText('hadron_find_nodes', {
    query,
    mode: 'vector',
    memoryUrn: memUrn,
  });
}

describe('US4 — stale abstract-vector hits served + marked', () => {
  it('stale node: hit returned AND `Source: abstract-stale` line present', async () => {
    // Hash stamped against the ORIGINAL content; then content edited to a new
    // value — the recorded hash now disagrees with computeContentHash(content).
    await seedEmbedded({
      loc: 'stale-1',
      abstract: 'A small architecture note.',
      content: 'original body',
      abstractOriginHashFor: 'original body',
    });
    await db.node.update({
      where: { loc_memoryId: { loc: 'stale-1', memoryId: memId } },
      data: { content: 'edited body — no re-embed yet' },
    });

    const out = await findNodesVector('architecture');
    expect(out).toContain('stale-1');
    expect(out).toContain('Source: abstract-stale');
  });

  it('fresh node: hit returned WITHOUT the stale marker', async () => {
    await seedEmbedded({
      loc: 'fresh-1',
      abstract: 'A small note.',
      content: 'body',
    });

    const out = await findNodesVector('note');
    expect(out).toContain('fresh-1');
    expect(out).not.toContain('Source: abstract-stale');
  });

  it('unfingerprinted node (abstractOriginHash IS NULL): hit returned AND marked (#1128)', async () => {
    // EXPECTATION INVERTED by #1128 — the marker half only. The hit is still
    // RETURNED, which is US4's actual subject: an unverified abstract is
    // downranked in trust, never withheld.
    //
    // The old suppression was spec 032's legacy short-circuit, correct when
    // every row predated the column. Production now has 2 unfingerprinted
    // rows out of 1024 with abstract+content, and a search hit ranked BY its
    // abstract is the place a reader most needs to know that abstract was
    // never checked against the body.
    await seedEmbedded({
      loc: 'legacy-1',
      abstract: 'Older note.',
      content: 'older body',
    });
    await db.node.update({
      where: { loc_memoryId: { loc: 'legacy-1', memoryId: memId } },
      data: { abstractOriginHash: null },
    });

    const out = await findNodesVector('older');
    expect(out).toContain('legacy-1');
    expect(out).toContain('Source: abstract-stale');
  });

  it('self-heal: after re-embed restamps abstractOriginHash, the marker disappears', async () => {
    // Start stale: hash against the OLD content, new content edited in.
    const nodeId = await seedEmbedded({
      loc: 'heal-1',
      abstract: 'Architecture note.',
      content: 'body v1',
      abstractOriginHashFor: 'body v1',
    });
    await db.node.update({
      where: { id: nodeId },
      data: { content: 'body v2 (edited)' },
    });

    const stale = await findNodesVector('architecture');
    expect(stale).toContain('Source: abstract-stale');

    // Simulate the author re-affirming the abstract — same flow as hadron_update_node
    // with `abstract` supplied: spec 032 FR-003 re-stamps abstractOriginHash from
    // current content. Direct DB write so the test stays focused on the read-side
    // marker logic.
    await db.node.update({
      where: { id: nodeId },
      data: {
        abstractOriginHash: computeContentHash('body v2 (edited)'),
        embeddingPendingAt: new Date(), embeddingWorkToken: randomUUID(),
      },
    });
    await embedNode(db, nodeId);

    const healed = await findNodesVector('architecture');
    expect(healed).toContain('heal-1');
    expect(healed).not.toContain('Source: abstract-stale');
  });

  it('encrypted memory: marker still fires (FR-025; MCP path writes plaintext at rest)', async () => {
    await seedEmbedded({
      loc: 'enc-stale',
      abstract: 'A secret note.',
      content: 'plain at rest v1',
      abstractOriginHashFor: 'plain at rest v1',
    });
    await db.node.update({
      where: { loc_memoryId: { loc: 'enc-stale', memoryId: memId } },
      data: { content: 'plain at rest v2 (edited)' },
    });
    // Flip the memory to encrypted AFTER seeding. The chk_memory_vector_encrypted_ack
    // constraint requires the ack timestamp when isEncrypted AND vectorIndexEnabled
    // both hold; stamp it directly to satisfy the structural backstop without
    // routing through the (US5) resolver-level ack.
    await db.memory.update({
      where: { id: memId },
      data: {
        isEncrypted: true,
        vectorIndexEncryptedAckAt: new Date(),
      },
    });

    const out = await findNodesVector('secret');
    expect(out).toContain('enc-stale');
    // Spec 033 FR-025: write-time plaintext stamping means the predicate IS
    // computable at read time even on encrypted memories — unlike spec 032's
    // hadron_get_node which had to gate this with !memory.isEncrypted.
    expect(out).toContain('Source: abstract-stale');
  });
});
