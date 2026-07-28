/**
 * Issue #105 regression: `resolveNodeRef` must accept ID, prefixed URN,
 * bare memory-prefixed loc, and short loc — and throw a typed error
 * (not silently fall through) on anything unresolvable.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { PrismaClient } from '../../generated/prisma/index.js';
import { resolveNodeRef } from './nodeRef.js';
import { NodeNotFoundError, UrnNotQualifiedError } from './errors.js';

const db = new PrismaClient();

let orgId: string;
let memoryId: string;
let memoryUrn: string;

beforeAll(async () => {
  await db.$connect();
});

afterAll(async () => {
  await db.$disconnect();
});

beforeEach(async () => {
  // loc-scope-ok: fixture cleanup is deliberately cross-memory — it sweeps
  // whatever memories a previous run created, keyed on a prefix unique to
  // this file. Scoping it to one memory would leave the rest behind.
  await db.node.deleteMany({ where: { loc: { startsWith: 'noderef-test-' } } });
  await db.memory.deleteMany({ where: { name: { startsWith: 'noderef-test-' } } });
  await db.organization.deleteMany({ where: { name: { startsWith: 'noderef-test-' } } });

  const org = await db.organization.create({
    data: { name: 'noderef-test-org', urn: `noderef-test-org-${Date.now()}` },
  });
  orgId = org.id;
  memoryUrn = `${org.urn}:noderef-test-mem`;
  const memory = await db.memory.create({
    data: {
      organizationId: orgId,
      urn: memoryUrn,
      name: 'noderef-test-mem',
      class: 'knowledge',
    },
  });
  memoryId = memory.id;
});

describe('resolveNodeRef', () => {
  it('resolves a bare ID', async () => {
    const node = await db.node.create({
      data: { memoryId, loc: 'noderef-test-services:db', name: 'db' },
    });
    const result = await resolveNodeRef(db, node.id, memoryId);
    expect(result).toEqual({ id: node.id });
  });

  it('resolves a `urn:node:<memory-urn>:<loc>` prefixed URN', async () => {
    const node = await db.node.create({
      data: { memoryId, loc: 'noderef-test-services:db', name: 'db' },
    });
    const result = await resolveNodeRef(
      db,
      `urn:node:${memoryUrn}:${node.loc}`,
      memoryId,
    );
    expect(result).toEqual({ id: node.id });
  });

  it('resolves a bare `<memory-urn>:<loc>` form', async () => {
    const node = await db.node.create({
      data: { memoryId, loc: 'noderef-test-services:db', name: 'db' },
    });
    const result = await resolveNodeRef(
      db,
      `${memoryUrn}:${node.loc}`,
      memoryId,
    );
    expect(result).toEqual({ id: node.id });
  });

  it('resolves a short loc within the context memory', async () => {
    const node = await db.node.create({
      data: { memoryId, loc: 'noderef-test-services:db', name: 'db' },
    });
    const result = await resolveNodeRef(db, node.loc, memoryId);
    expect(result).toEqual({ id: node.id });
  });

  it('throws NodeNotFoundError on an unknown ID', async () => {
    await expect(
      resolveNodeRef(db, 'cnotanodeidcnotanodeidcnot', memoryId),
    ).rejects.toBeInstanceOf(NodeNotFoundError);
  });

  it('throws NodeNotFoundError on an unknown short loc', async () => {
    await expect(
      resolveNodeRef(db, 'noderef-test-services:missing', memoryId),
    ).rejects.toBeInstanceOf(NodeNotFoundError);
  });

  it('throws NodeNotFoundError on an unknown full URN', async () => {
    await expect(
      resolveNodeRef(
        db,
        `urn:node:${memoryUrn}:noderef-test-services:missing`,
        memoryId,
      ),
    ).rejects.toBeInstanceOf(NodeNotFoundError);
  });

  it('throws NodeNotFoundError on a wrong-type URN prefix', async () => {
    const node = await db.node.create({
      data: { memoryId, loc: 'noderef-test-services:db', name: 'db' },
    });
    await expect(
      resolveNodeRef(db, `urn:memory:${memoryUrn}:${node.loc}`, memoryId),
    ).rejects.toBeInstanceOf(NodeNotFoundError);
  });

  it('treats a soft-deleted node as not-existing', async () => {
    const node = await db.node.create({
      data: {
        memoryId,
        loc: 'noderef-test-services:db',
        name: 'db',
        deletedAt: new Date(),
      },
    });
    await expect(resolveNodeRef(db, node.id, memoryId)).rejects.toBeInstanceOf(
      NodeNotFoundError,
    );
    await expect(resolveNodeRef(db, node.loc, memoryId)).rejects.toBeInstanceOf(
      NodeNotFoundError,
    );
  });

  it('resolves a soft-deleted node when includeDeleted is true', async () => {
    const node = await db.node.create({
      data: { memoryId, loc: 'noderef-test-services:db-inc', name: 'db-inc', deletedAt: new Date() },
    });
    // bare ID and short-loc-within-context both resolve with the opt-in.
    await expect(
      resolveNodeRef(db, node.id, undefined, { includeDeleted: true }),
    ).resolves.toEqual({ id: node.id });
    await expect(
      resolveNodeRef(db, node.loc, memoryId, { includeDeleted: true }),
    ).resolves.toEqual({ id: node.id });
  });

  it('does not fall back to short-loc when explicit urn:node: names a missing memory', async () => {
    // A node exists in the context memory whose loc happens to match
    // the body of the explicit URN. Without strict handling, the
    // resolver would silently resolve the explicit URN against the
    // context memory and return the wrong node.
    const decoy = await db.node.create({
      data: { memoryId, loc: 'no-such-mem:noderef-test-services:db', name: 'decoy' },
    });
    await expect(
      resolveNodeRef(db, `urn:node:no-such-mem:noderef-test-services:db`, memoryId),
    ).rejects.toBeInstanceOf(NodeNotFoundError);
    // Sanity: the decoy is reachable via short-loc within context memory.
    const direct = await resolveNodeRef(db, decoy.loc, memoryId);
    expect(direct.id).toBe(decoy.id);
  });

  it('does not fall back to short-loc when the named memory is soft-deleted', async () => {
    const deletedOrg = await db.organization.create({
      data: { name: 'noderef-test-deleted-org', urn: `noderef-test-deleted-${Date.now()}` },
    });
    const deletedMem = await db.memory.create({
      data: {
        organizationId: deletedOrg.id,
        urn: `${deletedOrg.urn}:gone`,
        name: 'noderef-test-deleted-mem',
        class: 'knowledge',
        deletedAt: new Date(),
      },
    });
    // Decoy: a node in the context memory whose loc matches the body.
    await db.node.create({
      data: { memoryId, loc: 'noderef-test-services:db', name: 'decoy' },
    });
    await expect(
      resolveNodeRef(
        db,
        `${deletedMem.urn}:noderef-test-services:db`,
        memoryId,
      ),
    ).rejects.toBeInstanceOf(NodeNotFoundError);
  });

  it('resolves through a soft-deleted memory prefix when includeDeleted is true', async () => {
    const delOrg = await db.organization.create({
      data: { name: 'noderef-test-inc-org', urn: `noderef-test-inc-${Date.now()}` },
    });
    const delMem = await db.memory.create({
      data: {
        organizationId: delOrg.id,
        urn: `${delOrg.urn}:gone`,
        name: 'noderef-test-inc-mem',
        class: 'knowledge',
        deletedAt: new Date(),
      },
    });
    // A LIVE node inside the soft-deleted memory — only the memory is deleted.
    const node = await db.node.create({
      data: { memoryId: delMem.id, loc: 'noderef-test-services:db', name: 'in-deleted-mem' },
    });
    const fullUrn = `${delMem.urn}:noderef-test-services:db`;
    // Default: the soft-deleted memory prefix blocks resolution.
    await expect(resolveNodeRef(db, fullUrn, memoryId)).rejects.toBeInstanceOf(NodeNotFoundError);
    // includeDeleted ignores soft-delete along the whole path, so the node
    // resolves through its soft-deleted memory.
    await expect(
      resolveNodeRef(db, fullUrn, memoryId, { includeDeleted: true }),
    ).resolves.toEqual({ id: node.id });
  });

  it('rejects an explicit urn:node:<id> form (node URNs are <memory-urn>:<loc>, not IDs)', async () => {
    const node = await db.node.create({
      data: { memoryId, loc: 'noderef-test-services:db', name: 'db' },
    });
    await expect(
      resolveNodeRef(db, `urn:node:${node.id}`, memoryId),
    ).rejects.toBeInstanceOf(NodeNotFoundError);
  });

  // ===================================================================
  // spec 022 — API-boundary URN qualification (FR-001, FR-002, FR-007a)
  //
  // When contextMemoryId is OMITTED, the input MUST be a fully-qualified
  // node URN (org:memory:loc minimum). When contextMemoryId is provided
  // (internal callers only), the short-loc-within-context branch is
  // reachable as before.
  // ===================================================================

  it('without contextMemoryId, rejects bare 2-segment input (the motivating safety case)', async () => {
    // `review:sort-imports` is the canonical example of the bug spec 022
    // exists to prevent — an agent constructs a relative-form node URN
    // from active-memory + loc and submits it. Without contextMemoryId
    // the qualification check rejects.
    await expect(resolveNodeRef(db, 'review:sort-imports')).rejects.toBeInstanceOf(
      UrnNotQualifiedError,
    );
  });

  it('without contextMemoryId, rejects bare 1-segment input', async () => {
    await expect(resolveNodeRef(db, 'review')).rejects.toBeInstanceOf(UrnNotQualifiedError);
  });

  it('without contextMemoryId, accepts a fully-qualified bare URN that resolves', async () => {
    const node = await db.node.create({
      data: { memoryId, loc: 'noderef-test-services:db', name: 'db' },
    });
    // Bare URN: `<orgUrn>:<memoryName>:<loc>` — 4+ segments.
    const ref = `${memoryUrn}:${node.loc}`;
    const result = await resolveNodeRef(db, ref);
    expect(result).toEqual({ id: node.id });
  });

  it('without contextMemoryId, accepts urn:node: prefixed form', async () => {
    const node = await db.node.create({
      data: { memoryId, loc: 'noderef-test-services:db', name: 'db' },
    });
    const ref = `urn:node:${memoryUrn}:${node.loc}`;
    const result = await resolveNodeRef(db, ref);
    expect(result).toEqual({ id: node.id });
  });

  it('without contextMemoryId, throws NodeNotFoundError for a qualified URN naming a missing memory', async () => {
    // Qualification check passes (3+ segments) but memory lookup fails;
    // surface as NodeNotFoundError rather than falling through to short-
    // loc resolution (which would need a contextMemoryId we don't have).
    await expect(
      resolveNodeRef(db, 'no-such-org:no-such-mem:no-such-loc'),
    ).rejects.toBeInstanceOf(NodeNotFoundError);
  });

  it('with contextMemoryId (internal-caller path), short-loc still resolves', async () => {
    // Sanity check: the bare-loc-within-context branch is preserved for
    // internal callers that hold a memory in hand (FR-007a).
    const node = await db.node.create({
      data: { memoryId, loc: 'noderef-test-services:db', name: 'db' },
    });
    const result = await resolveNodeRef(db, node.loc, memoryId);
    expect(result).toEqual({ id: node.id });
  });

  // ===================================================================
  // Issue #183 — canonical `::` URN inputs as edge targets.
  //
  // hadron_get_node accepts canonical-form node URNs (it routes through
  // `splitNodeUrn`, which understands `::`). The edge-target lookup
  // used a colon-naive `parts = ref.split(':')` and produced malformed
  // memory URNs (empty segments) for `::`-separated inputs — so the
  // same URN the read path happily resolved was rejected on write with
  // "Edge target not found". This block locks that asymmetry shut.
  // ===================================================================

  it('resolves a canonical `<org>::<memory>::<loc>` bare URN (issue #183)', async () => {
    const node = await db.node.create({
      data: { memoryId, loc: 'noderef-test-services:db', name: 'db' },
    });
    // memoryUrn is legacy-form (`<org>:<memorySlug>`) in storage; the
    // input uses canonical `::` between org/memory and between memory
    // and loc. Within the loc, `:` atoms preserve their meaning.
    const canonicalRef = `${memoryUrn.replace(':', '::')}::${node.loc}`;
    expect(canonicalRef.split('::').length).toBeGreaterThanOrEqual(3);

    const result = await resolveNodeRef(db, canonicalRef, memoryId);
    expect(result).toEqual({ id: node.id });
  });

  it('resolves a canonical `urn:node:<org>::<memory>::<loc>` prefixed URN (issue #183)', async () => {
    const node = await db.node.create({
      data: { memoryId, loc: 'noderef-test-services:db', name: 'db' },
    });
    const canonicalRef = `urn:node:${memoryUrn.replace(':', '::')}::${node.loc}`;

    const result = await resolveNodeRef(db, canonicalRef, memoryId);
    expect(result).toEqual({ id: node.id });
  });

  it('resolves a canonical URN without contextMemoryId (API-boundary path)', async () => {
    const node = await db.node.create({
      data: { memoryId, loc: 'noderef-test-services:db', name: 'db' },
    });
    const canonicalRef = `urn:node:${memoryUrn.replace(':', '::')}::${node.loc}`;

    // No contextMemoryId — exercises the spec-022 API-boundary path
    // with a canonical-form input.
    const result = await resolveNodeRef(db, canonicalRef);
    expect(result).toEqual({ id: node.id });
  });

  it('resolves a canonical URN against a canonical-stored Memory.urn', async () => {
    // Migration-window robustness: Memory.urn may be stored in either
    // legacy (`:`) or canonical (`::`) form per spec 021 D2. The
    // resolver must hit either via the OR on both literal forms.
    // Names + URN slug start with `noderef-test-` so the beforeEach
    // prefix-deleteMany on the NEXT test sweeps these rows cleanly —
    // no manual cleanup needed here.
    const canonicalOrg = await db.organization.create({
      data: {
        name: 'noderef-test-canonical-org',
        urn: `noderef-test-canon-${Date.now()}`,
      },
    });
    const canonicalMem = await db.memory.create({
      data: {
        organizationId: canonicalOrg.id,
        urn: `${canonicalOrg.urn}::canon-mem`,
        name: 'noderef-test-canon-mem',
        class: 'knowledge',
      },
    });
    const node = await db.node.create({
      data: { memoryId: canonicalMem.id, loc: 'chats:vocabulary', name: 'vocab' },
    });

    const ref = `urn:node:${canonicalOrg.urn}::canon-mem::chats:vocabulary`;
    const result = await resolveNodeRef(db, ref);
    expect(result).toEqual({ id: node.id });
  });

  it('resolves a node in a multi-level memory URN (per-user app-user shape) — PR-475 review, Codex P2', async () => {
    // A per-user memory URN spans MORE than two hierarchy levels:
    // <org>:<agent>:app-user:<id>. Canonical `::` input must treat the FINAL
    // leaf as the loc and everything before it as the memory URN — the old
    // fixed two-segment prefix mis-split these into memory `<org>:<agent>`.
    const org = await db.organization.create({
      data: { name: 'noderef-test-ml-org', urn: `noderef-test-ml-${Date.now()}` },
    });
    const mlMem = await db.memory.create({
      data: {
        organizationId: org.id,
        urn: `${org.urn}:agent-x:app-user:42`, // legacy-stored form
        name: 'noderef-test-ml-mem',
        class: 'knowledge',
      },
    });
    const node = await db.node.create({
      data: { memoryId: mlMem.id, loc: 'noderef-test-ml:leaf', name: 'ml' },
    });
    const ref = `hrn:node:${org.urn}::agent-x::app-user:42::${node.loc}`;
    expect(await resolveNodeRef(db, ref)).toEqual({ id: node.id });
  });

  it('mixed-grammar `<org>:<memory>::<loc>` input falls through cleanly (issue #183 review)', async () => {
    // Pin the behavior: when the split heuristic sees `::`, it commits
    // to canonical splitting — `'org:memory::loc'.split('::')` gives
    // `['org:memory', 'loc']` (only 2 parts), so we don't treat it as
    // a memory-prefixed input and fall through to short-loc resolution
    // against `contextMemoryId`. The intent is "don't bake mixed forms
    // into anything that could later canonicalize them"; the
    // observable contract is "mixed-grammar inputs miss cleanly with
    // NodeNotFoundError" rather than silently routing somewhere
    // surprising.
    await expect(
      resolveNodeRef(db, `${memoryUrn}::noderef-test-services:missing`, memoryId),
    ).rejects.toBeInstanceOf(NodeNotFoundError);
  });

  it('with contextMemoryId, ID-shape input still bypasses qualification (spec 007 dispatch)', async () => {
    const node = await db.node.create({
      data: { memoryId, loc: 'noderef-test-services:db', name: 'db' },
    });
    // ID input with contextMemoryId — bypasses qualification, finds the node.
    expect(await resolveNodeRef(db, node.id, memoryId)).toEqual({ id: node.id });
    // ID input WITHOUT contextMemoryId — also bypasses (isId check is first).
    expect(await resolveNodeRef(db, node.id)).toEqual({ id: node.id });
  });
});
