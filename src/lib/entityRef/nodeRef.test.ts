/**
 * Issue #105 regression: `resolveNodeRef` must accept ID, prefixed URN,
 * bare memory-prefixed loc, and short loc — and throw a typed error
 * (not silently fall through) on anything unresolvable.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { PrismaClient } from '../../generated/prisma/index.js';
import { resolveNodeRef } from './nodeRef.js';
import { NodeNotFoundError } from './errors.js';

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
});
