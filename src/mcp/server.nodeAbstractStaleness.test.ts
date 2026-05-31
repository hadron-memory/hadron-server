/**
 * Spec 032 — Node `abstractOriginHash`. MCP write-path staleness
 * coverage (US1). US2 (Source: abstract-stale marker) and US3
 * ([stale-abstract] validator warning) extend this file in their own PRs.
 *
 * What US1 pins:
 *
 *   - The 9-row partial-update matrix from contracts/h-update-node.md:
 *     across (abstract: absent|null|string) × (content: absent|null|string),
 *     `abstractOriginHash` settles to the right value per FR-003 through
 *     FR-007.
 *
 *   - The FR-003 "abstract supplied, content absent" reset case: hash
 *     is computed against `existing.content` (the caller affirms the
 *     new abstract matches CURRENT content).
 *
 *   - The FR-007 ghost-hash case: `content` cleared without an abstract
 *     update preserves the existing hash (won't fire staleness later
 *     because the read-time check requires content non-null).
 *
 *   - NodeVersion snapshot captures `existing.abstractOriginHash` on
 *     h-update-node so version history round-trips the hash.
 *
 *   - h-move-node NodeVersion snapshot also captures the hash (spec 031
 *     lesson: every snapshot site must include new columns).
 *
 *   - `h-add-node` is upsert-semantically a fresh write: every call
 *     computes the hash from supplied content.
 *
 *   - `Node.contentHash` is NOT touched on any write path
 *     (the column has its own external-producer domain — see
 *     data-model.md "What is NOT").
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';
import { generateId } from '../lib/id.js';
import { computeContentHash } from '../lib/contentHash.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

interface Fixture {
  admin: { id: string };
  memory: { id: string; urn: string };
}

let fx: Fixture;

function adminAuth(): AuthContext {
  return { userId: fx.admin.id, roles: ['ADMIN'], clientId: `user:${fx.admin.id}` };
}

beforeEach(async () => {
  await cleanDb(db);

  const org = await db.organization.create({
    data: { id: generateId(), name: 'stale-org', urn: 'stale-org' },
  });
  const admin = await db.user.create({
    data: { githubId: 9901, githubUsername: 'stale-admin', roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });

  const ctx: Context = { db, roles: ['ADMIN'], userId: admin.id };
  const memory = await resolvers.Mutation.createMemory(
    {},
    { orgId: org.id, name: 'stalemem' },
    ctx,
  );

  fx = { admin: { id: admin.id }, memory };
});

// ─── helpers ─────────────────────────────────────────────────────────────

async function addNode(args: {
  loc: string;
  name?: string;
  abstract?: string;
  content?: string;
}) {
  const srv = createTestableMcpServer(adminAuth());
  const params: Record<string, unknown> = {
    urn: `stale-org::stalemem::${args.loc}`,
    name: args.name ?? `node-${args.loc}`,
  };
  if (args.abstract !== undefined) params.abstract = args.abstract;
  if (args.content !== undefined) params.content = args.content;
  return srv.callToolText('h-add-node', params);
}

async function updateNode(args: {
  loc: string;
  abstract?: string | null;
  content?: string | null;
  name?: string;
}) {
  const srv = createTestableMcpServer(adminAuth());
  const params: Record<string, unknown> = {
    urn: `stale-org::stalemem::${args.loc}`,
  };
  if ('abstract' in args) params.abstract = args.abstract;
  if ('content' in args) params.content = args.content;
  if (args.name !== undefined) params.name = args.name;
  return srv.callToolText('h-update-node', params);
}

async function readRow(loc: string) {
  return db.node.findFirst({
    where: { loc, memoryId: fx.memory.id, deletedAt: null },
    select: { id: true, abstract: true, content: true, abstractOriginHash: true, contentHash: true },
  });
}

// ─── h-add-node: fresh-write semantics ─────────────────────────────────

describe('h-add-node — abstractOriginHash on fresh writes', () => {
  it('FR-003 — abstract + content together: hash = computeContentHash(content)', async () => {
    await addNode({ loc: 'add1', abstract: 'X', content: 'Y' });
    const row = await readRow('add1');
    expect(row?.abstractOriginHash).toBe(computeContentHash('Y'));
  });

  it('FR-006 — no abstract: hash is null', async () => {
    await addNode({ loc: 'add2', content: 'Y' });
    const row = await readRow('add2');
    expect(row?.abstractOriginHash).toBeNull();
  });

  it('FR-007 — abstract but no content: hash is null', async () => {
    await addNode({ loc: 'add3', abstract: 'X' });
    const row = await readRow('add3');
    expect(row?.abstractOriginHash).toBeNull();
  });

  it('does NOT touch contentHash (external-producer domain preserved)', async () => {
    await addNode({ loc: 'add4', abstract: 'X', content: 'Y' });
    const row = await readRow('add4');
    // contentHash stays null because no external producer set it; h-add-node
    // does not populate it. This pins the "Node.contentHash is NOT touched"
    // invariant from data-model.md.
    expect(row?.contentHash).toBeNull();
  });
});

// ─── h-update-node: 9-row partial-update matrix ────────────────────────

describe('h-update-node — abstractOriginHash 9-row matrix', () => {
  it('row 1 (both absent) — hash preserved', async () => {
    await addNode({ loc: 'u1', abstract: 'X', content: 'Y' });
    await updateNode({ loc: 'u1', name: 'renamed' });
    const row = await readRow('u1');
    expect(row?.abstractOriginHash).toBe(computeContentHash('Y'));
  });

  it("row 2 (content updated, abstract absent) — hash preserved (FR-004; staleness arms)", async () => {
    await addNode({ loc: 'u2', abstract: 'X', content: 'Y' });
    await updateNode({ loc: 'u2', content: "Y'" });
    const row = await readRow('u2');
    // Hash stayed at hash(Y); content is now Y'. computeContentHash(Y') !== stored hash → stale.
    expect(row?.abstractOriginHash).toBe(computeContentHash('Y'));
    expect(row?.content).toBe("Y'");
    expect(row?.abstractOriginHash).not.toBe(computeContentHash(row!.content!));
  });

  it("row 3 (content cleared, abstract absent) — hash preserved (FR-007 ghost-hash; harmless)", async () => {
    await addNode({ loc: 'u3', abstract: 'X', content: 'Y' });
    await updateNode({ loc: 'u3', content: null });
    const row = await readRow('u3');
    expect(row?.abstractOriginHash).toBe(computeContentHash('Y'));
    expect(row?.content).toBeNull();
    // Staleness check requires content non-null — ghost hash won't fire stale.
  });

  it("row 4 (abstract updated, content absent) — hash recomputed from existing.content (FR-003)", async () => {
    // Seed: abstract X, content Y. Update content to Y' WITHOUT abstract.
    // Then refresh abstract only — hash should reset to hash(current content Y').
    await addNode({ loc: 'u4', abstract: 'X', content: 'Y' });
    await updateNode({ loc: 'u4', content: "Y'" });
    await updateNode({ loc: 'u4', abstract: "X'" });
    const row = await readRow('u4');
    expect(row?.abstractOriginHash).toBe(computeContentHash("Y'"));
  });

  it('row 5 (both updated together) — hash matches new content (FR-005)', async () => {
    await addNode({ loc: 'u5', abstract: 'X', content: 'Y' });
    await updateNode({ loc: 'u5', abstract: "X'", content: "Y'" });
    const row = await readRow('u5');
    expect(row?.abstractOriginHash).toBe(computeContentHash("Y'"));
  });

  it('row 6 (abstract updated, content cleared) — hash null (FR-007)', async () => {
    await addNode({ loc: 'u6', abstract: 'X', content: 'Y' });
    await updateNode({ loc: 'u6', abstract: "X'", content: null });
    const row = await readRow('u6');
    expect(row?.abstractOriginHash).toBeNull();
    expect(row?.content).toBeNull();
  });

  it('row 7 (abstract cleared, content absent) — hash cleared (FR-006)', async () => {
    await addNode({ loc: 'u7', abstract: 'X', content: 'Y' });
    await updateNode({ loc: 'u7', abstract: null });
    const row = await readRow('u7');
    expect(row?.abstractOriginHash).toBeNull();
    expect(row?.abstract).toBeNull();
  });

  it('row 8 (abstract cleared, content updated) — hash cleared (FR-006)', async () => {
    await addNode({ loc: 'u8', abstract: 'X', content: 'Y' });
    await updateNode({ loc: 'u8', abstract: null, content: "Y'" });
    const row = await readRow('u8');
    expect(row?.abstractOriginHash).toBeNull();
    expect(row?.content).toBe("Y'");
  });

  it('row 9 (both null) — hash null', async () => {
    await addNode({ loc: 'u9', abstract: 'X', content: 'Y' });
    await updateNode({ loc: 'u9', abstract: null, content: null });
    const row = await readRow('u9');
    expect(row?.abstractOriginHash).toBeNull();
  });
});

// ─── NodeVersion snapshots capture the hash ────────────────────────────

describe('NodeVersion snapshots capture abstractOriginHash', () => {
  it('h-update-node snapshot captures existing.abstractOriginHash', async () => {
    await addNode({ loc: 'v1', abstract: 'X', content: 'Y' });
    const before = await readRow('v1');
    // Trigger an update that creates a version
    await updateNode({ loc: 'v1', abstract: "X'" });
    const versions = await db.nodeVersion.findMany({
      where: { nodeId: before!.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(versions.length).toBeGreaterThanOrEqual(1);
    expect(versions[0].abstractOriginHash).toBe(computeContentHash('Y'));
  });

  it('h-move-node snapshot captures existing.abstractOriginHash', async () => {
    // Spec 031 lesson + PR-209 Copilot review: every NodeVersion.create
    // site must be exercised. Without this test, a future refactor that
    // drops the column from the h-move-node snapshot won't be caught.
    await addNode({ loc: 'v2', abstract: 'X', content: 'Y' });
    const before = await readRow('v2');
    const srv = createTestableMcpServer(adminAuth());
    await srv.callToolText('h-move-node', {
      urn: 'stale-org::stalemem::v2',
      targetUrn: 'stale-org::stalemem::v2moved',
    });
    const versions = await db.nodeVersion.findMany({
      where: { nodeId: before!.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(versions.length).toBeGreaterThanOrEqual(1);
    expect(versions[versions.length - 1].abstractOriginHash).toBe(
      computeContentHash('Y'),
    );
  });
});
