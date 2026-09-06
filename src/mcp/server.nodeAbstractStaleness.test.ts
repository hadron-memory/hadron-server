/**
 * Spec 032 — Node `abstractOriginHash`. MCP write-path staleness
 * coverage (US1). US2 (Source: abstract-stale marker) and US3
 * ([stale-abstract] validator warning) extend this file in their own PRs.
 *
 * What US1 pins:
 *
 *   - The 9-row partial-update matrix from contracts/hadron_update_node.md:
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
 *   - NodeRevision snapshot captures `existing.abstractOriginHash` on
 *     hadron_update_node so revision history round-trips the hash.
 *
 *   - hadron_move_node NodeRevision snapshot also captures the hash (spec 031
 *     lesson: every snapshot site must include new columns).
 *
 *   - `hadron_create_node` is upsert-semantically a fresh write: every call
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
  return srv.callToolText('hadron_create_node', params);
}

async function updateNode(args: {
  loc: string;
  abstract?: string | null;
  content?: string | null;
  name?: string;
  abstractStillAccurate?: boolean;
}) {
  const srv = createTestableMcpServer(adminAuth());
  const params: Record<string, unknown> = {
    urn: `stale-org::stalemem::${args.loc}`,
  };
  if ('abstract' in args) params.abstract = args.abstract;
  if ('content' in args) params.content = args.content;
  if (args.name !== undefined) params.name = args.name;
  if (args.abstractStillAccurate !== undefined) {
    params.abstractStillAccurate = args.abstractStillAccurate;
  }
  return srv.callToolText('hadron_update_node', params);
}

async function readRow(loc: string) {
  return db.node.findFirst({
    where: { loc, memoryId: fx.memory.id, deletedAt: null },
    select: { id: true, abstract: true, content: true, abstractOriginHash: true, contentHash: true },
  });
}

// ─── hadron_create_node: fresh-write semantics ─────────────────────────────────

describe('hadron_create_node — abstractOriginHash on fresh writes', () => {
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
    // contentHash stays null because no external producer set it; hadron_create_node
    // does not populate it. This pins the "Node.contentHash is NOT touched"
    // invariant from data-model.md.
    expect(row?.contentHash).toBeNull();
  });
});

// ─── hadron_update_node: 9-row partial-update matrix ────────────────────────

describe('hadron_update_node — abstractOriginHash 9-row matrix', () => {
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

// ─── NodeRevision snapshots capture the hash ────────────────────────────

// ─── #1126: abstractStillAccurate — the caller's assertion ───────────────────

describe('hadron_update_node — abstractStillAccurate (#1126)', () => {
  it('re-fingerprints the EXISTING abstract against the new content', async () => {
    await addNode({ loc: 'asa1', abstract: 'X', content: 'Y' });
    await updateNode({ loc: 'asa1', content: "Y'", abstractStillAccurate: true });
    const row = await readRow('asa1');
    expect(row?.abstractOriginHash).toBe(computeContentHash("Y'"));
    // It asserts, it does not author: the abstract text is untouched.
    expect(row?.abstract).toBe('X');
  });

  it('clears the marker a reader would otherwise see — the observable claim', async () => {
    // The column is the mechanism; this is the behaviour the flag exists for,
    // and the one a refactor could break while the hash test still passed.
    await addNode({ loc: 'asa2', abstract: 'X', content: 'Y' });
    await updateNode({ loc: 'asa2', content: "Y'", abstractStillAccurate: true });
    expect(await readNode('asa2', 'all')).not.toContain('Source: abstract-stale');
  });

  it('omitted still ARMS staleness — the default is unchanged', async () => {
    // The paired negative. Without it, a bug that always re-fingerprints
    // would pass every other test in this block.
    await addNode({ loc: 'asa3', abstract: 'X', content: 'Y' });
    await updateNode({ loc: 'asa3', content: "Y'" });
    expect(await readNode('asa3', 'all')).toContain('Source: abstract-stale');
  });

  it('false behaves exactly like omitted', async () => {
    await addNode({ loc: 'asa4', abstract: 'X', content: 'Y' });
    await updateNode({ loc: 'asa4', content: "Y'", abstractStillAccurate: false });
    const row = await readRow('asa4');
    expect(row?.abstractOriginHash).toBe(computeContentHash('Y'));
    expect(await readNode('asa4', 'all')).toContain('Source: abstract-stale');
  });

  it('does NOT mint a ghost hash on a node with no abstract (FR-006)', async () => {
    // The guard that matters. An unguarded assertion would fingerprint an
    // abstract that does not exist — a hash later reads compare against and
    // quietly trust.
    await addNode({ loc: 'asa5', content: 'Y' });
    await updateNode({ loc: 'asa5', content: "Y'", abstractStillAccurate: true });
    expect((await readRow('asa5'))?.abstractOriginHash).toBeNull();
  });

  it('treats a whitespace-only abstract as no abstract', async () => {
    await addNode({ loc: 'asa6', abstract: '   ', content: 'Y' });
    await updateNode({ loc: 'asa6', content: "Y'", abstractStillAccurate: true });
    expect((await readRow('asa6'))?.abstractOriginHash).toBeNull();
  });

  it('re-affirms with NO content change — clears an already-armed marker', async () => {
    // The review case: the abstract was right all along and the marker is
    // the only thing to fix. Equivalent to re-saving the identical text.
    await addNode({ loc: 'asa7', abstract: 'X', content: 'Y' });
    await updateNode({ loc: 'asa7', content: "Y'" });
    expect(await readNode('asa7', 'all')).toContain('Source: abstract-stale');
    await updateNode({ loc: 'asa7', abstractStillAccurate: true });
    expect(await readNode('asa7', 'all')).not.toContain('Source: abstract-stale');
  });

  it('is ignored when `abstract` is also supplied (row 5 already covers it)', async () => {
    await addNode({ loc: 'asa8', abstract: 'X', content: 'Y' });
    await updateNode({
      loc: 'asa8',
      abstract: 'X2',
      content: "Y'",
      abstractStillAccurate: true,
    });
    const row = await readRow('asa8');
    expect(row?.abstract).toBe('X2');
    expect(row?.abstractOriginHash).toBe(computeContentHash("Y'"));
  });

  it('clearing content while asserting lands on FR-007 (no content ⇒ no hash)', async () => {
    await addNode({ loc: 'asa9', abstract: 'X', content: 'Y' });
    await updateNode({ loc: 'asa9', content: null, abstractStillAccurate: true });
    expect((await readRow('asa9'))?.abstractOriginHash).toBeNull();
  });

  it('#1128 — abstract-first-then-body NOW arms the marker (gap closed)', async () => {
    // The sequence #1126 was about, and the one that used to raise no signal:
    // an abstract saved against an empty node gets a null hash (FR-007) and a
    // later content-only update preserves that null (row 2), so the old
    // `!= null` read guard treated "never fingerprinted" as "nothing to check".
    //
    // I wrote the previous version of this test to DOCUMENT that gap rather
    // than endorse it, on the assumption that closing it meant false-firing
    // across a legacy corpus. Measuring killed that assumption: production has
    // 2 such rows, and both genuinely do have unverified abstracts. The
    // fingerprint stays null — nothing backfills it — but the READ now says so.
    await addNode({ loc: 'gap1', abstract: 'X' });
    expect((await readRow('gap1'))?.abstractOriginHash).toBeNull();

    await updateNode({ loc: 'gap1', content: 'a body the abstract never saw' });
    expect((await readRow('gap1'))?.abstractOriginHash).toBeNull();
    expect(await readNode('gap1', 'all')).toContain('Source: abstract-stale');
  });

  it('#1128 — restoring a revision with a null hash arms the marker', async () => {
    // PR #1129 review, @codex: restorableNodeFields restores
    // abstractOriginHash verbatim, so a snapshot taken while the hash was null
    // brings the null back — and under the new predicate that now shows a
    // marker where spec 032's legacy-revision edge case promised none.
    //
    // Pinned because it is a real consequence, and it is the CORRECT one: the
    // restored abstract genuinely has never been checked against the restored
    // content, so saying "verified" would be the lie. The spec text is what
    // needs to move (@Vera), not this behaviour — and a test makes the change
    // explicit rather than incidental.
    await addNode({ loc: 'restore1', abstract: 'X', content: 'Y' });
    await db.node.update({
      where: { loc_memoryId: { loc: 'restore1', memoryId: fx.memory.id } },
      data: { abstractOriginHash: null },
    });
    const row = await readRow('restore1');

    // A revision captured while the hash was null.
    await updateNode({ loc: 'restore1', content: 'Y2', abstractStillAccurate: true });
    expect((await readRow('restore1'))?.abstractOriginHash).not.toBeNull();
    expect(await readNode('restore1', 'all')).not.toContain('Source: abstract-stale');

    const rev = await db.nodeRevision.findFirst({
      where: { nodeId: row!.id, abstractOriginHash: null },
      orderBy: { createdAt: 'desc' },
      select: { abstractOriginHash: true },
    });
    expect(rev).not.toBeNull(); // the null really was captured
  });

  it('#1128 — a RESTORE of that revision arms the marker on the live node', async () => {
    // PR #1139 review, @codex: the test above pins the PRECONDITION — that a
    // revision captured the null hash — and never restores it, so it could not
    // fail if restoreNodeRevision started recomputing the hash. Spec 032's
    // edge case cites this behaviour, so the citation needs a test that
    // performs the operation it describes.
    await addNode({ loc: 'restore2', abstract: 'X', content: 'Y' });
    const live = await readRow('restore2');
    await db.node.update({
      where: { id: live!.id },
      data: { abstractOriginHash: null },
    });

    // Snapshot the null-hash state, then move the node to a verified one.
    await updateNode({ loc: 'restore2', content: 'Y2', abstractStillAccurate: true });
    expect(await readNode('restore2', 'all')).not.toContain('Source: abstract-stale');

    const rev = await db.nodeRevision.findFirst({
      where: { nodeId: live!.id, abstractOriginHash: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    expect(rev).not.toBeNull();

    // The operation the spec's edge case is about.
    const ctx: Context = { db, roles: ['ADMIN'], userId: fx.admin.id };
    await resolvers.Mutation.restoreNodeRevision({}, { revisionId: rev!.id }, ctx);

    // Restored verbatim (plan D4) — the null comes back...
    expect((await readRow('restore2'))?.abstractOriginHash).toBeNull();
    // ...and under the post-#1128 predicate that is a marker, not silence.
    // Correct: the restored abstract has never been checked against the
    // restored body.
    expect(await readNode('restore2', 'all')).toContain('Source: abstract-stale');
  });

  it('#1128 — and asserting accuracy clears it, giving the node its first hash', async () => {
    // The escape hatch has to reach the newly-armed population, or #1128 just
    // adds a marker nobody can turn off. Asserting fingerprints the abstract
    // for the first time, which is exactly what was missing.
    await addNode({ loc: 'gap3', abstract: 'X' });
    await updateNode({ loc: 'gap3', content: 'B' });
    expect(await readNode('gap3', 'all')).toContain('Source: abstract-stale');

    await updateNode({ loc: 'gap3', abstractStillAccurate: true });
    expect((await readRow('gap3'))?.abstractOriginHash).toBe(computeContentHash('B'));
    expect(await readNode('gap3', 'all')).not.toContain('Source: abstract-stale');
  });

  it('binds to NEITHER half — an interleaved abstract swap is certified unseen', async () => {
    // PR #1127 review, @codex, second pass. The flag re-fingerprints whatever
    // abstract is STORED when the write lands, not the one the caller read.
    // Here the caller reviewed 'X' against "Y'"; another writer replaced the
    // abstract with 'Z' in between; the assertion then stamps 'Z' as reviewed
    // and the marker stays silent on text nobody checked.
    //
    // @Holger's call (2026-09-03) is to ship the flag and document both
    // halves, so this pins the behaviour rather than guarding against it: the
    // residual hole is a suppressed marker that self-corrects at the next
    // content edit, and the fully-bound form (pass `abstract` AND `content`)
    // already exists and needs no flag. The description says so in those
    // words. This test exists so the trade is visible in the suite and not
    // only in a parameter string somebody may not read.
    await addNode({ loc: 'race1', abstract: 'X', content: 'Y' });
    await updateNode({ loc: 'race1', abstract: 'Z' }); // the interloper
    await updateNode({ loc: 'race1', content: "Y'", abstractStillAccurate: true });

    const row = await readRow('race1');
    expect(row?.abstract).toBe('Z'); // NOT the 'X' the caller reviewed
    expect(row?.abstractOriginHash).toBe(computeContentHash("Y'"));
    expect(await readNode('race1', 'all')).not.toContain('Source: abstract-stale');
  });

  it('the fully-bound form writes both things the caller compared', async () => {
    // The counterpart, and the one the description points at: supplying both
    // leaves no gap for an interloper to occupy — whatever happened in
    // between, the row ends up holding exactly the pair that was reviewed.
    await addNode({ loc: 'race2', abstract: 'X', content: 'Y' });
    await updateNode({ loc: 'race2', abstract: 'Z' }); // same interloper
    await updateNode({ loc: 'race2', abstract: 'X', content: "Y'" });

    const row = await readRow('race2');
    expect(row?.abstract).toBe('X');
    expect(row?.abstractOriginHash).toBe(computeContentHash("Y'"));
    expect(await readNode('race2', 'all')).not.toContain('Source: abstract-stale');
  });

  it('records the suppression in revision history — `changes` names the hash', async () => {
    // PR #1127 review, @codex P2. Used alone, the flag changes restorable
    // state (abstractOriginHash) and nothing else — so before this fix the
    // revision recorded an EMPTY `changes`, and the one operation in this
    // tool that suppresses a correctness check was the one operation
    // invisible in history. Exactly the objectType defect from PR #977,
    // which is why `abstractOriginHash` now joins TRACKED_NODE_FIELDS.
    await addNode({ loc: 'rev1', abstract: 'X', content: 'Y' });
    await updateNode({ loc: 'rev1', content: "Y'" }); // arms the marker
    const node = await readRow('rev1');

    await updateNode({ loc: 'rev1', abstractStillAccurate: true });

    const revs = await db.nodeRevision.findMany({
      where: { nodeId: node!.id },
      orderBy: { createdAt: 'desc' },
      select: { changes: true },
    });
    expect(revs[0]?.changes).toContain('abstractOriginHash');
  });

  it('#1128 — but asserting on such a node still mints no ghost hash', async () => {
    // The guard has to hold on this path too: the node HAS an abstract, so
    // hasStoredAbstract is true, and the hash comes from the new content.
    // That is correct — the caller is asserting they read both — and it is
    // also the one way to give such a node a fingerprint at all.
    await addNode({ loc: 'gap2', abstract: 'X' });
    await updateNode({ loc: 'gap2', content: 'B', abstractStillAccurate: true });
    expect((await readRow('gap2'))?.abstractOriginHash).toBe(computeContentHash('B'));
  });
});

describe('NodeRevision snapshots capture abstractOriginHash', () => {
  it('hadron_update_node snapshot captures existing.abstractOriginHash', async () => {
    await addNode({ loc: 'v1', abstract: 'X', content: 'Y' });
    const before = await readRow('v1');
    // Trigger an update that creates a version
    await updateNode({ loc: 'v1', abstract: "X'" });
    const versions = await db.nodeRevision.findMany({
      where: { nodeId: before!.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(versions.length).toBeGreaterThanOrEqual(1);
    expect(versions[0].abstractOriginHash).toBe(computeContentHash('Y'));
  });

  it('hadron_move_node snapshot captures existing.abstractOriginHash', async () => {
    // Spec 031 lesson + PR-209 Copilot review: every NodeRevision.create
    // site must be exercised. Without this test, a future refactor that
    // drops the column from the hadron_move_node snapshot won't be caught.
    await addNode({ loc: 'v2', abstract: 'X', content: 'Y' });
    const before = await readRow('v2');
    const srv = createTestableMcpServer(adminAuth());
    await srv.callToolText('hadron_move_node', {
      urn: 'stale-org::stalemem::v2',
      targetUrn: 'stale-org::stalemem::v2moved',
    });
    const versions = await db.nodeRevision.findMany({
      where: { nodeId: before!.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(versions.length).toBeGreaterThanOrEqual(1);
    expect(versions[versions.length - 1].abstractOriginHash).toBe(
      computeContentHash('Y'),
    );
  });
});

// ─── US2: hadron_get_node `Source: abstract-stale` marker (FR-010) ─────────

/**
 * The US2 marker behaviour matrix per contracts/hadron_get_node.md:
 *
 *   - fresh + 'all'                         → no marker
 *   - stale + 'all'                         → marker present
 *   - stale + 'abstract'                    → marker present
 *   - stale + 'content' (default)           → no marker (abstract not in response)
 *   - content-less abstract-having + default → `Source: abstract-fallback`
 *                                             only, NOT `abstract-stale` (no
 *                                             content to be stale against)
 *   - legacy (abstractOriginHash IS NULL)   → no marker (short-circuit on the
 *                                             explicit `!= null` guard)
 *
 * Plus the encryption gate: on encrypted memories the MCP read path does
 * NOT call `decryptNodesBatch` (asymmetry tracked by #206), so computing
 * `computeContentHash(node.content)` against ciphertext would false-
 * positive on every node. v1 skips the staleness check entirely on
 * encrypted memories — symmetric with the hadron_validate gate (US3). The
 * encryption-parity follow-up lifts the gate.
 */
async function readNode(loc: string, contentScope?: 'content' | 'abstract' | 'all') {
  const srv = createTestableMcpServer(adminAuth());
  const params: Record<string, unknown> = {
    urn: `stale-org::stalemem::${loc}`,
  };
  if (contentScope !== undefined) params.contentScope = contentScope;
  return srv.callToolText('hadron_get_node', params);
}

describe('hadron_get_node — `Source: abstract-stale` marker (US2)', () => {
  it("fresh node + 'all': no `Source: abstract-stale`", async () => {
    await addNode({ loc: 'r1', abstract: 'X', content: 'Y' });
    const out = await readNode('r1', 'all');
    expect(out).not.toContain('Source: abstract-stale');
  });

  it("stale node + 'all': marker present", async () => {
    await addNode({ loc: 'r2', abstract: 'X', content: 'Y' });
    await updateNode({ loc: 'r2', content: "Y'" });
    const out = await readNode('r2', 'all');
    expect(out).toContain('Source: abstract-stale');
    expect(out).toContain('X'); // abstract still rendered
    expect(out).toContain("Y'"); // updated content still rendered
  });

  it("stale node + 'abstract': marker present, content absent", async () => {
    await addNode({ loc: 'r3', abstract: 'X', content: 'Y' });
    await updateNode({ loc: 'r3', content: "Y'" });
    const out = await readNode('r3', 'abstract');
    expect(out).toContain('Source: abstract-stale');
    expect(out).toContain('X');
    // 'abstract' scope must NOT render the body — the whole point of the
    // scope. PR-210 review #4: assert the body absence rather than rely
    // on spec 031's scope-shape tests elsewhere.
    expect(out).not.toContain("Y'");
  });

  it("stale node + 'content' default: no marker (abstract not in response)", async () => {
    await addNode({ loc: 'r4', abstract: 'X', content: 'Y' });
    await updateNode({ loc: 'r4', content: "Y'" });
    const out = await readNode('r4');
    expect(out).not.toContain('Source: abstract-stale');
  });

  it("content-less abstract-having node + default: `abstract-fallback` only, NOT `abstract-stale`", async () => {
    // Seed with abstract only — no content. Spec 031 fallback applies;
    // staleness check requires content non-null, so it short-circuits.
    await addNode({ loc: 'r5', abstract: 'X' });
    const out = await readNode('r5');
    expect(out).toContain('Source: abstract-fallback');
    expect(out).not.toContain('Source: abstract-stale');
  });

  it("unfingerprinted node (abstractOriginHash IS NULL): marker ARMS (#1128)", async () => {
    // EXPECTATION INVERTED by #1128. This used to assert the opposite, and the
    // `!= null` guard it pinned was correct when spec 032 shipped: every row
    // predated the column and would have lit up at once.
    //
    // The premise drained. Measured 2026-09-03, production held 1024 live
    // nodes with both an abstract and content and exactly 2 with no
    // fingerprint (dev: 786 and 2) — every write since spec 032 re-stamps it.
    // So the guard had stopped protecting a legacy corpus and was instead
    // silencing the ONE ordering that most needs the warning: abstract first,
    // body later, which FR-007 leaves unfingerprinted forever.
    //
    // A null hash on a node that HAS both is not "nothing to check" — it is
    // "never checked", and that is what the marker is for.
    await addNode({ loc: 'r6', abstract: 'X', content: 'Y' });
    await db.node.update({
      where: { loc_memoryId: { loc: 'r6', memoryId: fx.memory.id } },
      data: { abstractOriginHash: null },
    });
    const out = await readNode('r6', 'all');
    expect(out).toContain('Source: abstract-stale');
  });

  it('encrypted memory: marker is SUPPRESSED (v1 gate, deferred to #206 encryption-parity)', async () => {
    // Mark the memory encrypted AFTER seeding plaintext content + a stale
    // hash. The gate is `!memory.isEncrypted` — on an encrypted memory,
    // hadron_get_node doesn't decrypt today, so computing hash from
    // (possibly-)ciphertext content would false-positive. The gate skips
    // the predicate entirely; the marker MUST NOT emit on any read of
    // an encrypted memory in v1.
    //
    // No try/finally reset needed — `beforeEach` calls `cleanDb` which
    // drops and recreates the memory row, so the `isEncrypted: true`
    // mutation here doesn't leak across tests.
    await addNode({ loc: 'r7', abstract: 'X', content: 'Y' });
    await updateNode({ loc: 'r7', content: "Y'" });
    await db.memory.update({
      where: { id: fx.memory.id },
      // 033: the memory was created via createMemory (knowledge → vectorIndexEnabled
      // true by the class-derived default). Encrypting it without acknowledging the
      // inversion risk would violate chk_memory_vector_encrypted_ack, so disable the
      // index here — this test is about abstract staleness, not vectors.
      data: { isEncrypted: true, vectorIndexEnabled: false },
    });
    const out = await readNode('r7', 'all');
    expect(out).not.toContain('Source: abstract-stale');
  });
});

// ─── US3: hadron_validate `[stale-abstract]` warning (FR-011) ────────────────

/**
 * hadron_validate scans the memory and emits one warning line per stale node.
 * Predicate mirrors hadron_get_node's (US2): four clauses + the `!= null`
 * legacy short-circuit + the `!memory.isEncrypted` gate.
 *
 * Encryption gate: hadron_validate doesn't decrypt — staleness on encrypted
 * memories would compare a plaintext hash against the hash of ciphertext
 * content and fire false-positives on every node. v1 skips the check on
 * encrypted memories; the encryption-parity follow-up (#206) lifts the
 * gate.
 */
async function validate() {
  const srv = createTestableMcpServer(adminAuth());
  return srv.callToolText('hadron_validate', { memoryUrn: 'stale-org::stalemem' });
}

describe('hadron_validate — `[stale-abstract]` warning (US3)', () => {
  it('flags a single stale node', async () => {
    await addNode({ loc: 'v-stale', abstract: 'X', content: 'Y' });
    await updateNode({ loc: 'v-stale', content: "Y'" });
    const out = await validate();
    expect(out).toContain('[stale-abstract]');
    expect(out).toContain('v-stale');
  });

  it('zero `[stale-abstract]` warnings on a clean memory', async () => {
    await addNode({ loc: 'v-fresh', abstract: 'X', content: 'Y' });
    const out = await validate();
    expect(out).not.toContain('[stale-abstract]');
  });

  it('mixed memory reports each issue type with its own tag', async () => {
    // sparse: no description / content / abstract
    await addNode({ loc: 'm-sparse' });
    // stale: content updated without refreshing the abstract
    await addNode({ loc: 'm-stale', abstract: 'X', content: 'Y' });
    await updateNode({ loc: 'm-stale', content: "Y'" });
    // fresh control node: should not appear in issues
    await addNode({ loc: 'm-fresh', abstract: 'A', content: 'B' });

    const out = await validate();
    expect(out).toContain('[sparse]');
    expect(out).toContain('m-sparse');
    expect(out).toContain('[stale-abstract]');
    expect(out).toContain('m-stale');
    // The fresh node is not flagged for staleness; m-fresh should appear
    // nowhere as a stale-abstract subject.
    expect(out).not.toMatch(/\[stale-abstract\][^\n]*m-fresh/);
    // Spec 032 broken-ref coverage lives in the preexisting hadron_validate
    // tests; this scenario focuses on the multi-issue-type interaction
    // between sparse and stale-abstract (the two scopes 031 + 032 own).
  });

  it('unfingerprinted node (abstractOriginHash IS NULL): DOES warn (#1128)', async () => {
    // EXPECTATION INVERTED by #1128, and the validator is the surface where
    // the old behaviour was hardest to defend: an operator running an audit is
    // asking "which abstracts should I not trust?", and "we have never checked
    // this one" is a direct answer to that question, not noise to filter out.
    await addNode({ loc: 'v-legacy', abstract: 'X', content: 'Y' });
    await db.node.update({
      where: { loc_memoryId: { loc: 'v-legacy', memoryId: fx.memory.id } },
      data: { abstractOriginHash: null },
    });
    const out = await validate();
    expect(out).toContain('[stale-abstract]');
  });

  it('encrypted memory: zero `[stale-abstract]` warnings (v1 gate, deferred to #206)', async () => {
    // Seed a stale node on a plaintext memory, then flip the memory to
    // encrypted. hadron_validate doesn't decrypt; computing the hash against
    // (possibly-)ciphertext content would false-positive on every node.
    // The gate suppresses the check entirely until the encryption-parity
    // follow-up lifts it. No try/finally needed — cleanDb in beforeEach
    // recreates the memory row for the next test.
    await addNode({ loc: 'v-enc', abstract: 'X', content: 'Y' });
    await updateNode({ loc: 'v-enc', content: "Y'" });
    await db.memory.update({
      where: { id: fx.memory.id },
      // 033: the memory was created via createMemory (knowledge → vectorIndexEnabled
      // true by the class-derived default). Encrypting it without acknowledging the
      // inversion risk would violate chk_memory_vector_encrypted_ack, so disable the
      // index here — this test is about abstract staleness, not vectors.
      data: { isEncrypted: true, vectorIndexEnabled: false },
    });
    const out = await validate();
    expect(out).not.toContain('[stale-abstract]');
  });
});
