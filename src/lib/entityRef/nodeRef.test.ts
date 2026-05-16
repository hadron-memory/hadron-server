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
