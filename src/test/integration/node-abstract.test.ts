/**
 * Spec 031 — Node.abstract GraphQL integration coverage. Drives the
 * `upsertNode` mutation + `node(loc)` query directly through the resolver
 * layer (mirrors src/api/graphql/schema/resolvers.encryption.test.ts).
 *
 * What this file pins:
 *
 *   - `upsertNode(input: { abstract })` create-mode persists; subsequent
 *     update-mode replaces / null-clears / omit-preserves per spec
 *     FR-004 partial-update semantics.
 *
 *   - Length cap (FR-008) and whitespace-only normalization (FR-009
 *     extended) propagate through the GraphQL surface, throwing
 *     `NodeAbstractTooLongError` with `extensions.code` set per
 *     constitution S2.
 *
 *   - `createOnly: true` on `NodeInput` interacts as expected — the new
 *     abstract field is written on resurrected nodes, rejected on
 *     non-resurrect collisions, persisted on fresh creates.
 *
 *   - The Node.abstract field is exposed on the returned object so a
 *     follow-up `node(loc)` query (or a portal read) sees it.
 *
 *   - NOT tested here: search recall via `findNodes` over abstract
 *     content — US3 deferred to RAG follow-up per PR-196.
 *
 * Constitution refinement I — graph-touching mutation, integration test
 * against the real `hadron_test` DB (pinned by vitest.config.ts).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { generateId } from '../../lib/id.js';

// The upsertNode resolver fires writeNodeToGit asynchronously; pin to a
// no-op so the test doesn't try to push to a real remote.
vi.mock('../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

interface Fixture {
  ctx: Context;
  memory: { id: string; urn: string };
}

let fx: Fixture;

const SHORT_ABSTRACT = 'A short summary paragraph.';
const REVISED_ABSTRACT = 'A revised summary.';

beforeEach(async () => {
  await cleanDb(db);

  const org = await db.organization.create({
    data: { id: generateId(), name: 'gq-abs-org', urn: 'gq-abs-org' },
  });
  const admin = await db.user.create({
    data: { githubId: 9801, githubUsername: 'gq-abs-admin', roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });

  const ctx: Context = {
    db,
    roles: ['ADMIN'],
    userId: admin.id,
    clientId: `user:${admin.id}`,
  };
  const memory = await resolvers.Mutation.createMemory(
    {},
    { orgId: org.id, name: 'gqmem' },
    ctx,
  );

  fx = { ctx, memory };
});

// ───── helpers ────────────────────────────────────────────────────────────

async function upsertNode(input: Record<string, unknown>) {
  return resolvers.Mutation.upsertNode(
    {},
    { input: { memoryId: fx.memory.id, ...input } as never },
    fx.ctx,
  );
}

async function persistedAbstract(loc: string): Promise<string | null> {
  const node = await db.node.findFirst({
    where: { loc, memoryId: fx.memory.id, deletedAt: null },
    select: { abstract: true },
  });
  return node?.abstract ?? null;
}

// ───── create-mode + abstract round-trip ──────────────────────────────────

describe('upsertNode — create mode with abstract', () => {
  it('persists the abstract on create and returns it on the result object', async () => {
    const node = await upsertNode({
      loc: 'gq1',
      name: 'gq1',
      abstract: SHORT_ABSTRACT,
    });
    expect(node.abstract).toBe(SHORT_ABSTRACT);
    expect(await persistedAbstract('gq1')).toBe(SHORT_ABSTRACT);
  });

  it('a create without abstract leaves the column NULL', async () => {
    const node = await upsertNode({ loc: 'gq2', name: 'gq2' });
    expect(node.abstract).toBeNull();
    expect(await persistedAbstract('gq2')).toBeNull();
  });
});

// ───── update-mode partial-update semantics ───────────────────────────────

describe('upsertNode — update mode partial-update semantics', () => {
  it('replaces an existing abstract when a new string is supplied', async () => {
    await upsertNode({ loc: 'pu1', name: 'pu1', abstract: SHORT_ABSTRACT });
    await upsertNode({ loc: 'pu1', name: 'pu1', abstract: REVISED_ABSTRACT });
    expect(await persistedAbstract('pu1')).toBe(REVISED_ABSTRACT);
  });

  it('explicit `abstract: null` clears the column', async () => {
    await upsertNode({ loc: 'pu2', name: 'pu2', abstract: SHORT_ABSTRACT });
    await upsertNode({ loc: 'pu2', name: 'pu2', abstract: null });
    expect(await persistedAbstract('pu2')).toBeNull();
  });

  it('omitting the `abstract` key preserves the existing value', async () => {
    await upsertNode({ loc: 'pu3', name: 'pu3', abstract: SHORT_ABSTRACT });
    // No `abstract` key — only updating the name
    await upsertNode({ loc: 'pu3', name: 'pu3-renamed' });
    expect(await persistedAbstract('pu3')).toBe(SHORT_ABSTRACT);
  });
});

// ───── FR-008 length cap via GraphQL surface ──────────────────────────────

describe('upsertNode — FR-008 length-cap rejection', () => {
  it('rejects abstract > 2000 chars on create with NodeAbstractTooLongError', async () => {
    const overlong = 'x'.repeat(2001);
    let caught: unknown;
    try {
      await upsertNode({ loc: 'lc1', name: 'lc1', abstract: overlong });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(GraphQLError);
    const err = caught as GraphQLError;
    expect(err.extensions?.code).toBe('NodeAbstractTooLongError');
    expect(err.extensions?.length).toBe(2001);
    expect(err.extensions?.max).toBe(2000);
  });

  it('rejects abstract > 2000 chars on update with the same typed error', async () => {
    await upsertNode({ loc: 'lc2', name: 'lc2' });
    const overlong = 'y'.repeat(3000);
    let caught: unknown;
    try {
      await upsertNode({ loc: 'lc2', name: 'lc2', abstract: overlong });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(GraphQLError);
    expect((caught as GraphQLError).extensions?.code).toBe(
      'NodeAbstractTooLongError',
    );
  });

  it('accepts abstract exactly at the 2000-char cap', async () => {
    const atCap = 'z'.repeat(2000);
    await upsertNode({ loc: 'lc3', name: 'lc3', abstract: atCap });
    expect((await persistedAbstract('lc3'))?.length).toBe(2000);
  });
});

// ───── FR-009 (extended) — whitespace-only normalization ──────────────────

describe('upsertNode — FR-009 trim-then-check normalization', () => {
  it("empty-string abstract normalizes to NULL", async () => {
    await upsertNode({ loc: 'ws1', name: 'ws1', abstract: '' });
    expect(await persistedAbstract('ws1')).toBeNull();
  });

  it("whitespace-only abstract normalizes to NULL", async () => {
    await upsertNode({ loc: 'ws2', name: 'ws2', abstract: '   \n\t  ' });
    expect(await persistedAbstract('ws2')).toBeNull();
  });

  it("intentional leading-whitespace on a real paragraph persists as-is", async () => {
    const padded = '  This is a paragraph with leading spaces.';
    await upsertNode({ loc: 'ws3', name: 'ws3', abstract: padded });
    expect(await persistedAbstract('ws3')).toBe(padded);
  });

  it("update with whitespace-only string clears the abstract", async () => {
    await upsertNode({ loc: 'ws4', name: 'ws4', abstract: SHORT_ABSTRACT });
    await upsertNode({ loc: 'ws4', name: 'ws4', abstract: '   ' });
    expect(await persistedAbstract('ws4')).toBeNull();
  });
});

// ───── createOnly interaction ─────────────────────────────────────────────

describe('upsertNode — createOnly + abstract', () => {
  it('createOnly: true with abstract creates the node and persists the abstract', async () => {
    const node = await upsertNode({
      loc: 'co1',
      name: 'co1',
      abstract: SHORT_ABSTRACT,
      createOnly: true,
    });
    expect(node.abstract).toBe(SHORT_ABSTRACT);
    expect(await persistedAbstract('co1')).toBe(SHORT_ABSTRACT);
  });

  it('createOnly: true on a colliding (live) loc rejects with NodeLocConflictError — abstract not persisted', async () => {
    await upsertNode({
      loc: 'co2',
      name: 'co2',
      abstract: 'Original.',
    });
    let caught: unknown;
    try {
      await upsertNode({
        loc: 'co2',
        name: 'co2',
        abstract: 'Should not land.',
        createOnly: true,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(GraphQLError);
    expect((caught as GraphQLError).extensions?.code).toBe(
      'NodeLocConflictError',
    );
    // Original abstract preserved — the rejected upsert did not mutate.
    expect(await persistedAbstract('co2')).toBe('Original.');
  });
});

// ───── restoreNodeVersion + abstract round-trip ───────────────────────────

describe('restoreNodeVersion — abstract round-trips through history', () => {
  it('restoring a version with a non-null abstract reverts the node abstract to that value', async () => {
    // Initial state: abstract A
    const created = await upsertNode({ loc: 'rv1', name: 'rv1', abstract: 'A' });

    // Capture v1 (records "A") by performing an update that triggers a snapshot.
    await upsertNode({ loc: 'rv1', name: 'rv1', abstract: 'B' });

    // The NodeVersion just created snapshotted the pre-update state ("A").
    const versions = await db.nodeVersion.findMany({
      where: { nodeId: created.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(versions.length).toBeGreaterThanOrEqual(1);
    const vA = versions[0];
    expect(vA.abstract).toBe('A');

    // Restore that version. Node abstract should revert to "A".
    const restored = await resolvers.Mutation.restoreNodeVersion(
      {},
      { versionId: vA.id },
      fx.ctx,
    );
    expect(restored.abstract).toBe('A');
    expect(await persistedAbstract('rv1')).toBe('A');
  });

  it("restoring a version with NULL abstract clears the node's current abstract", async () => {
    // v1 state: no abstract
    const created = await upsertNode({ loc: 'rv2', name: 'rv2' });

    // Update to give the node an abstract — snapshot captures the pre-update NULL.
    await upsertNode({ loc: 'rv2', name: 'rv2', abstract: 'Later.' });

    const versions = await db.nodeVersion.findMany({
      where: { nodeId: created.id },
      orderBy: { createdAt: 'asc' },
    });
    const vNullAbs = versions[0];
    expect(vNullAbs.abstract).toBeNull();

    const restored = await resolvers.Mutation.restoreNodeVersion(
      {},
      { versionId: vNullAbs.id },
      fx.ctx,
    );
    expect(restored.abstract).toBeNull();
    expect(await persistedAbstract('rv2')).toBeNull();
  });

  it('pre-restore snapshot captures the current abstract', async () => {
    // Initial state: abstract X
    const created = await upsertNode({ loc: 'rv3', name: 'rv3', abstract: 'X' });

    // Bump to "Y" so we have a prior version (with abstract X) to restore.
    await upsertNode({ loc: 'rv3', name: 'rv3', abstract: 'Y' });

    const versions = await db.nodeVersion.findMany({
      where: { nodeId: created.id },
      orderBy: { createdAt: 'asc' },
    });
    const vX = versions[0];

    // Restore vX — node abstract becomes "X", but the pre-restore snapshot
    // must record the CURRENT abstract ("Y") so we can round-trip back.
    await resolvers.Mutation.restoreNodeVersion(
      {},
      { versionId: vX.id },
      fx.ctx,
    );

    const versionsAfterRestore = await db.nodeVersion.findMany({
      where: { nodeId: created.id },
      orderBy: { createdAt: 'asc' },
    });
    // The newest version row was created by the restore — its abstract
    // must equal the pre-restore live state ("Y").
    const newest = versionsAfterRestore[versionsAfterRestore.length - 1];
    expect(newest.abstract).toBe('Y');
  });
});

// node(loc) query coverage intentionally omitted — `Mutation.upsertNode`'s
// own return value (asserted above) plus the DB-level `persistedAbstract`
// check already prove the column round-trips through GraphQL. The
// node(loc) URN-resolution surface is covered elsewhere.

// ─── Spec 032 — abstractOriginHash via GraphQL ──────────────────────────

import { computeContentHash } from '../../lib/contentHash.js';

async function persistedHash(loc: string): Promise<string | null> {
  const node = await db.node.findFirst({
    where: { loc, memoryId: fx.memory.id, deletedAt: null },
    select: { abstractOriginHash: true },
  });
  return node?.abstractOriginHash ?? null;
}

describe('spec 032 — upsertNode maintains abstractOriginHash', () => {
  it('fresh abstract + content: hash = computeContentHash(content)', async () => {
    await upsertNode({ loc: 's1', name: 's1', abstract: 'A', content: 'B' });
    expect(await persistedHash('s1')).toBe(computeContentHash('B'));
  });

  it('content-only update: hash preserved (staleness arms)', async () => {
    await upsertNode({ loc: 's2', name: 's2', abstract: 'A', content: 'B' });
    await upsertNode({ loc: 's2', name: 's2', content: "B'" });
    expect(await persistedHash('s2')).toBe(computeContentHash('B'));
  });

  it('abstract-only update: hash recomputed from existing content', async () => {
    await upsertNode({ loc: 's3', name: 's3', abstract: 'A', content: 'B' });
    // update content WITHOUT abstract field
    await upsertNode({ loc: 's3', name: 's3', content: "B'" });
    // refresh abstract; expected to reset hash to current content's hash
    await upsertNode({ loc: 's3', name: 's3', abstract: "A'" });
    expect(await persistedHash('s3')).toBe(computeContentHash("B'"));
  });

  it('abstract cleared: hash cleared', async () => {
    await upsertNode({ loc: 's4', name: 's4', abstract: 'A', content: 'B' });
    await upsertNode({ loc: 's4', name: 's4', abstract: null });
    expect(await persistedHash('s4')).toBeNull();
  });

  it('returned Node object exposes abstractOriginHash', async () => {
    const node = await upsertNode({ loc: 's5', name: 's5', abstract: 'A', content: 'B' });
    expect((node as { abstractOriginHash: string | null }).abstractOriginHash).toBe(
      computeContentHash('B'),
    );
  });
});

describe('spec 032 — restoreNodeVersion round-trips abstractOriginHash', () => {
  it("restores the version's stored hash verbatim", async () => {
    const created = await upsertNode({ loc: 'rv-h', name: 'rv-h', abstract: 'A', content: 'B' });
    // Trigger snapshot via an update
    await upsertNode({ loc: 'rv-h', name: 'rv-h', abstract: 'A2' });

    const versions = await db.nodeVersion.findMany({
      where: { nodeId: created.id },
      orderBy: { createdAt: 'asc' },
    });
    const v0 = versions[0];
    expect(v0.abstractOriginHash).toBe(computeContentHash('B'));

    const restored = await resolvers.Mutation.restoreNodeVersion(
      {},
      { versionId: v0.id },
      fx.ctx,
    );
    // After restore, the live row should have the version's stored hash.
    expect((restored as { abstractOriginHash: string | null }).abstractOriginHash).toBe(
      computeContentHash('B'),
    );
  });

  it("pre-restore snapshot captures the live row's current hash", async () => {
    const created = await upsertNode({ loc: 'rv-h2', name: 'rv-h2', abstract: 'A', content: 'B' });
    await upsertNode({ loc: 'rv-h2', name: 'rv-h2', abstract: 'A2', content: "B'" });

    const versions = await db.nodeVersion.findMany({
      where: { nodeId: created.id },
      orderBy: { createdAt: 'asc' },
    });
    const v0 = versions[0]; // captures hash(B)

    // Restore the original. This creates a NEW NodeVersion snapshot
    // capturing the pre-restore live state (which has hash(B')).
    await resolvers.Mutation.restoreNodeVersion({}, { versionId: v0.id }, fx.ctx);

    const allVersions = await db.nodeVersion.findMany({
      where: { nodeId: created.id },
      orderBy: { createdAt: 'asc' },
    });
    const newest = allVersions[allVersions.length - 1];
    expect(newest.abstractOriginHash).toBe(computeContentHash("B'"));
  });
});

describe('spec 032 — SC-005 GraphQL exposure is read-only', () => {
  it('NodeInput does NOT expose abstractOriginHash (system-managed)', async () => {
    // Try to query the GraphQL schema's type map for NodeInput.
    // We can't introspect via the gqlSchema directly in test fixture without
    // a running server; use a runtime-level assertion: pass an input shape
    // that includes abstractOriginHash and assert that the resolver's
    // typing doesn't accept it (TypeScript would catch it; runtime
    // doesn't enforce GraphQL input types). For end-to-end coverage of
    // the schema-level absence, see the contract documentation.
    //
    // Implementation-level invariant: any attempt to pass
    // abstractOriginHash via the input object MUST be ignored by the
    // resolver. Test: write to the column via input, verify it didn't
    // override the system-managed value.
    await upsertNode({
      loc: 'sc5',
      name: 'sc5',
      abstract: 'A',
      content: 'B',
      // NodeInput intentionally doesn't expose abstractOriginHash. The
      // upsertNode helper here takes Record<string, unknown> so TS
      // doesn't catch the extra property — the assertion below is the
      // load-bearing check: the resolver MUST strip it so the system-
      // managed value wins.
      abstractOriginHash: 'tampered',
    });
    // The system-managed value should be computeContentHash('B'),
    // NOT the tampered value the caller tried to inject.
    expect(await persistedHash('sc5')).toBe(computeContentHash('B'));
  });
});
