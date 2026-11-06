import { randomUUID } from 'node:crypto';
/**
 * 033-rag-vector-retrieval US2 — chunking strategy + per-memory dials (SC-006).
 *
 * What US2 pins:
 *   - Auto strategy selection (FR-015): structure-aware for markdown with
 *     2+ headings, fixed-size fallback otherwise.
 *   - Per-memory dials (FR-003): `chunkTokens`, `chunkOverlap`,
 *     `forceFixedSize` change the chunk boundaries on subsequent embeds.
 *   - InvalidChunkConfigError fires at the resolver boundary for invalid
 *     dial combinations; the CHECK constraint is the structural backstop.
 *   - Changing dials triggers a re-index (FR-004) — old chunks are
 *     dropped, the sweep re-embeds against the new boundaries.
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
import { resolvers, type Context as GqlContext } from '../../api/graphql/schema/resolvers.js';
import { InvalidChunkConfigError } from '../../lib/entityRef/errors.js';

const DIM = 768;

function stubClient(): EmbeddingClient {
  return {
    provider: 'test',
    model: 'stub-model',
    dim: DIM,
    async embed(texts: string[]) {
      // All chunks get a unique-ish vector; ranking irrelevant for the
      // boundary-tests in this file.
      return texts.map((t, i) => {
        const v = new Array(DIM).fill(0);
        v[(t.length + i) % DIM] = 1;
        return v;
      });
    },
  };
}

let orgId: string;
let adminId: string;

function adminCtx(): GqlContext {
  return { db, roles: ['ADMIN'], userId: adminId };
}

beforeEach(async () => {
  await cleanDb(db);
  process.env.EMBEDDING_API_URL = 'http://stub.local/api/embed';
  setEmbeddingClientForTests(stubClient());

  const orgUrn = `us2c-org-${generateId().slice(0, 8)}`;
  const org = await db.organization.create({
    data: { id: generateId(), name: orgUrn, urn: orgUrn },
  });
  orgId = org.id;
  const admin = await db.user.create({
    data: { githubId: 9911, githubUsername: 'us2c-admin', roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { organizationId: orgId, userId: admin.id, role: 'ADMIN' },
  });
  adminId = admin.id;
});

afterAll(() => {
  resetEmbeddingClientForTests();
  delete process.env.EMBEDDING_API_URL;
});

async function makeChunkMemory(extra: {
  chunkTokens?: number;
  chunkOverlap?: number;
  forceFixedSize?: boolean;
} = {}): Promise<string> {
  const mem = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: orgId,
      urn: `us2c-org:m-${generateId()}`,
      name: 'm',
      class: 'knowledge',
      vectorIndexEnabled: true,
      embeddingSource: 'contentChunks',
      chunkTokens: extra.chunkTokens,
      chunkOverlap: extra.chunkOverlap,
      forceFixedSize: extra.forceFixedSize ?? false,
    },
  });
  return mem.id;
}

async function seedAndEmbed(memId: string, loc: string, content: string): Promise<string> {
  const nodeId = generateId();
  await db.node.create({
    data: { id: nodeId, memoryId: memId, loc, name: loc, content, embeddingPendingAt: new Date(), embeddingWorkToken: randomUUID() },
  });
  await embedNode(db, nodeId);
  return nodeId;
}

async function chunkCount(nodeId: string): Promise<number> {
  const rows = await db.$queryRaw<{ c: bigint }[]>`
    SELECT COUNT(*) AS c FROM node_embeddings WHERE node_id = ${nodeId} AND kind = 'chunk'
  `;
  return Number(rows[0].c);
}

describe('US2 — auto strategy selection (FR-015)', () => {
  it('multi-heading markdown → structure-aware (one chunk per section)', async () => {
    const memId = await makeChunkMemory();
    const md = '# A\nbody a\n\n## B\nbody b\n\n## C\nbody c';
    const nodeId = await seedAndEmbed(memId, 'auto-structure', md);
    expect(await chunkCount(nodeId)).toBe(3);
  });

  it('plain prose with no headings → fixed-size fallback', async () => {
    // Long enough content to trigger more than one fixed-size window
    // under the default 512-token (2048-char) settings.
    const memId = await makeChunkMemory();
    const prose = 'A'.repeat(5000);
    const nodeId = await seedAndEmbed(memId, 'auto-prose', prose);
    expect(await chunkCount(nodeId)).toBeGreaterThan(1);
  });
});

describe('US2 — per-memory dials change chunk boundaries (FR-003)', () => {
  it('smaller chunkTokens produces MORE chunks for the same content', async () => {
    const big = await makeChunkMemory({ chunkTokens: 500, chunkOverlap: 50, forceFixedSize: true });
    const small = await makeChunkMemory({ chunkTokens: 50, chunkOverlap: 0, forceFixedSize: true });
    const prose = 'A'.repeat(5000);
    const bigNode = await seedAndEmbed(big, 'n-big', prose);
    const smallNode = await seedAndEmbed(small, 'n-small', prose);
    expect(await chunkCount(smallNode)).toBeGreaterThan(await chunkCount(bigNode));
  });

  it('forceFixedSize overrides structure-aware default', async () => {
    // 3-heading markdown: structure-aware would emit exactly 3 chunks.
    // Forced fixed-size with a small window emits more.
    const structureAware = await makeChunkMemory();
    const forced = await makeChunkMemory({
      chunkTokens: 30,
      chunkOverlap: 0,
      forceFixedSize: true,
    });
    const md = '# A\n' + 'a'.repeat(400) + '\n\n## B\n' + 'b'.repeat(400) + '\n\n## C\n' + 'c'.repeat(400);
    const struct = await seedAndEmbed(structureAware, 'n-struct', md);
    const force = await seedAndEmbed(forced, 'n-force', md);
    expect(await chunkCount(struct)).toBe(3);
    expect(await chunkCount(force)).toBeGreaterThan(3);
  });
});

describe('US2 — InvalidChunkConfigError + CHECK backstop', () => {
  it('updateMemory rejects chunkTokens <= 0 via the resolver gate', async () => {
    const memId = await makeChunkMemory();
    await expect(
      resolvers.Mutation.updateMemory(
        {},
        { id: memId, chunkTokens: -5 },
        adminCtx(),
      ),
    ).rejects.toBeInstanceOf(InvalidChunkConfigError);
  });

  it('updateMemory rejects chunkOverlap >= chunkTokens', async () => {
    const memId = await makeChunkMemory({ chunkTokens: 100 });
    await expect(
      resolvers.Mutation.updateMemory(
        {},
        { id: memId, chunkOverlap: 150 },
        adminCtx(),
      ),
    ).rejects.toBeInstanceOf(InvalidChunkConfigError);
  });

  it('updateMemory rejects negative chunkOverlap', async () => {
    const memId = await makeChunkMemory();
    await expect(
      resolvers.Mutation.updateMemory(
        {},
        { id: memId, chunkOverlap: -1 },
        adminCtx(),
      ),
    ).rejects.toBeInstanceOf(InvalidChunkConfigError);
  });

  it('updateMemory accepts a valid partial dial update + persists it', async () => {
    const memId = await makeChunkMemory({ chunkTokens: 512, chunkOverlap: 64 });
    const updated = await resolvers.Mutation.updateMemory(
      {},
      { id: memId, chunkTokens: 256 },
      adminCtx(),
    );
    expect(updated.chunkTokens).toBe(256);
    // Overlap was not in the update; carries its prior value.
    expect(updated.chunkOverlap).toBe(64);
  });
});

describe('US2 — validation against effective post-update state (PR-225 review)', () => {
  it('rejects chunkOverlap >= platform-default tokens when chunkTokens is null', async () => {
    // Memory created with no explicit dials: both DB columns are null,
    // meaning the runtime uses the platform defaults (512/64). Without
    // resolving the validation against those defaults, this update
    // would slip past with effectiveTokens=null and crash at the
    // CHECK with a 500.
    const memId = await makeChunkMemory();
    await expect(
      resolvers.Mutation.updateMemory(
        {},
        { id: memId, chunkOverlap: 600 },
        adminCtx(),
      ),
    ).rejects.toBeInstanceOf(InvalidChunkConfigError);
  });

  it('rejects chunkOverlap = chunkTokens (equality must fail; spec is strict <)', async () => {
    const memId = await makeChunkMemory();
    await expect(
      resolvers.Mutation.updateMemory(
        {},
        { id: memId, chunkTokens: 100, chunkOverlap: 100 },
        adminCtx(),
      ),
    ).rejects.toBeInstanceOf(InvalidChunkConfigError);
  });
});

describe('US2 — re-index trigger gated on effective source (PR-225 review)', () => {
  it('chunk-dial change on an abstract-only memory does NOT trigger a re-index', async () => {
    // Memory created with embeddingSource: contentChunks above; flip
    // it to abstract for this test.
    const memId = await makeChunkMemory();
    await db.memory.update({
      where: { id: memId },
      data: { embeddingSource: 'abstract' },
    });
    // Seed a node + clear any pending marker so we can detect a re-index.
    const nodeId = generateId();
    await db.node.create({
      data: {
        id: nodeId,
        memoryId: memId,
        loc: 'abs-only',
        name: 'abs-only',
        abstract: 'a short note',
        content: 'body',
        embeddingPendingAt: null,
        embeddingAttempts: 0,
      },
    });

    // Change ONLY chunk dials. Source stays abstract — dials are inert.
    await resolvers.Mutation.updateMemory(
      {},
      { id: memId, chunkTokens: 256, chunkOverlap: 32 },
      adminCtx(),
    );

    // No re-index was triggered: pending marker stays cleared, no
    // wasted embedding work.
    const node = await db.node.findUnique({
      where: { id: nodeId },
      select: { embeddingPendingAt: true },
    });
    expect(node?.embeddingPendingAt).toBeNull();
  });

  it('chunk-dial change on a contentChunks memory DOES trigger a re-index (positive control)', async () => {
    const memId = await makeChunkMemory({ chunkTokens: 500, chunkOverlap: 50 });
    const nodeId = generateId();
    await db.node.create({
      data: {
        id: nodeId,
        memoryId: memId,
        loc: 'chunked',
        name: 'chunked',
        content: 'body',
        embeddingPendingAt: null,
        embeddingAttempts: 0,
      },
    });

    await resolvers.Mutation.updateMemory(
      {},
      { id: memId, chunkTokens: 256, chunkOverlap: 32 },
      adminCtx(),
    );

    const node = await db.node.findUnique({
      where: { id: nodeId },
      select: { embeddingPendingAt: true },
    });
    // Re-stamped pending — the sweep will re-embed under the new dials.
    expect(node?.embeddingPendingAt).not.toBeNull();
  });
});

describe('US2 — chunk-dial change triggers re-index (FR-004)', () => {
  it('changing chunkTokens drops the old chunk vectors + re-stamps pending', async () => {
    const memId = await makeChunkMemory({ chunkTokens: 500, chunkOverlap: 50, forceFixedSize: true });
    const prose = 'A'.repeat(5000);
    const nodeId = await seedAndEmbed(memId, 'reindex', prose);
    const before = await chunkCount(nodeId);
    expect(before).toBeGreaterThan(0);

    // Change the dial via the resolver. The re-index branch drops old
    // chunk vectors AND re-stamps embeddingPendingAt on every live node.
    // Need to pass overlap too: shrinking tokens to 50 without adjusting
    // overlap (50) would violate `overlap < tokens`.
    await resolvers.Mutation.updateMemory(
      {},
      { id: memId, chunkTokens: 50, chunkOverlap: 5 },
      adminCtx(),
    );

    const node = await db.node.findUnique({
      where: { id: nodeId },
      select: { embeddingPendingAt: true },
    });
    expect(node?.embeddingPendingAt).not.toBeNull();

    // The actual old vectors are gone — backfill cleared them. The
    // sweep would re-embed under the new dials; here we drive it
    // directly with embedNode and confirm new boundaries took effect.
    await embedNode(db, nodeId);
    const after = await chunkCount(nodeId);
    expect(after).toBeGreaterThan(before);
  });
});
