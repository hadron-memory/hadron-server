/**
 * #473 — `resolveEdgeRef` completes the spec-007 resolveXRef family for
 * edges (first-class per spec 037). Must accept a bare ID and a
 * fully-qualified `hrn:edge:<memory-urn>::<loc>` URN (legacy `urn:` and
 * single-`:` forms included), and throw typed errors on anything
 * unresolvable — never silently fall through.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { PrismaClient } from '../../generated/prisma/index.js';
import { resolveEdgeRef } from './edgeRef.js';
import { EdgeNotFoundError, UrnNotQualifiedError } from './errors.js';

const db = new PrismaClient();

let memoryId: string;
let memoryUrn: string;
let sourceId: string;
let targetId: string;

beforeAll(async () => {
  await db.$connect();
});

afterAll(async () => {
  await db.$disconnect();
});

beforeEach(async () => {
  await db.edge.deleteMany({ where: { loc: { startsWith: 'edgeref-test-' } } });
  await db.node.deleteMany({ where: { loc: { startsWith: 'edgeref-test-' } } });
  await db.memory.deleteMany({ where: { name: { startsWith: 'edgeref-test-' } } });
  await db.organization.deleteMany({ where: { name: { startsWith: 'edgeref-test-' } } });

  const org = await db.organization.create({
    data: { name: 'edgeref-test-org', urn: `edgeref-test-org-${Date.now()}` },
  });
  memoryUrn = `${org.urn}:edgeref-test-mem`;
  const memory = await db.memory.create({
    data: {
      organizationId: org.id,
      urn: memoryUrn,
      name: 'edgeref-test-mem',
      class: 'knowledge',
    },
  });
  memoryId = memory.id;
  const source = await db.node.create({
    data: { memoryId, loc: 'edgeref-test-a', name: 'a' },
  });
  const target = await db.node.create({
    data: { memoryId, loc: 'edgeref-test-b', name: 'b' },
  });
  sourceId = source.id;
  targetId = target.id;
});

const createEdge = (loc: string, deletedAt?: Date) =>
  db.edge.create({
    data: { memoryId, sourceId, targetId, loc, name: 'next', deletedAt },
  });

describe('resolveEdgeRef', () => {
  it('resolves a bare ID', async () => {
    const edge = await createEdge('edgeref-test-a:next');
    expect(await resolveEdgeRef(db, edge.id)).toEqual({ id: edge.id });
  });

  it('resolves a canonical `hrn:edge:<org>::<memory>::<loc>` URN', async () => {
    const edge = await createEdge('edgeref-test-a:next');
    const ref = `hrn:edge:${memoryUrn.replace(':', '::')}::${edge.loc}`;
    expect(await resolveEdgeRef(db, ref)).toEqual({ id: edge.id });
  });

  it('resolves a legacy `urn:edge:<memory-urn>:<loc>` URN', async () => {
    const edge = await createEdge('edgeref-test-a:next');
    expect(await resolveEdgeRef(db, `urn:edge:${memoryUrn}:${edge.loc}`)).toEqual({
      id: edge.id,
    });
  });

  it('resolves a bare `<memory-urn>::<loc>` form', async () => {
    const edge = await createEdge('edgeref-test-a:next');
    expect(await resolveEdgeRef(db, `${memoryUrn.replace(':', '::')}::${edge.loc}`)).toEqual({
      id: edge.id,
    });
  });

  it('keeps multi-atom locs intact across the `::` boundary', async () => {
    const edge = await createEdge('edgeref-test-a:step:next');
    const ref = `hrn:edge:${memoryUrn.replace(':', '::')}::${edge.loc}`;
    expect(await resolveEdgeRef(db, ref)).toEqual({ id: edge.id });
  });

  it('throws EdgeNotFoundError on an unknown ID', async () => {
    await expect(
      resolveEdgeRef(db, 'cnotanedgeidcnotanedgeidc'),
    ).rejects.toBeInstanceOf(EdgeNotFoundError);
  });

  it('throws EdgeNotFoundError on an unknown loc in a live memory', async () => {
    await expect(
      resolveEdgeRef(db, `hrn:edge:${memoryUrn.replace(':', '::')}::missing`),
    ).rejects.toBeInstanceOf(EdgeNotFoundError);
  });

  it('throws EdgeNotFoundError on a wrong-type URN prefix', async () => {
    const edge = await createEdge('edgeref-test-a:next');
    await expect(
      resolveEdgeRef(db, `hrn:node:${memoryUrn.replace(':', '::')}::${edge.loc}`),
    ).rejects.toBeInstanceOf(EdgeNotFoundError);
  });

  it('rejects an explicit hrn:edge:<id> form (edge URNs are <memory-urn>::<loc>)', async () => {
    const edge = await createEdge('edgeref-test-a:next');
    await expect(resolveEdgeRef(db, `hrn:edge:${edge.id}`)).rejects.toBeInstanceOf(
      EdgeNotFoundError,
    );
  });

  it('rejects an under-qualified non-ID input (spec 022)', async () => {
    await expect(resolveEdgeRef(db, 'edgeref-test-a:next')).rejects.toBeInstanceOf(
      UrnNotQualifiedError,
    );
  });

  it('treats a soft-deleted edge as not-existing unless includeDeleted', async () => {
    const edge = await createEdge('edgeref-test-a:next', new Date());
    await expect(resolveEdgeRef(db, edge.id)).rejects.toBeInstanceOf(EdgeNotFoundError);
    await expect(
      resolveEdgeRef(db, `hrn:edge:${memoryUrn.replace(':', '::')}::${edge.loc}`),
    ).rejects.toBeInstanceOf(EdgeNotFoundError);
    await expect(
      resolveEdgeRef(db, edge.id, { includeDeleted: true }),
    ).resolves.toEqual({ id: edge.id });
  });

  it('treats an edge behind a soft-deleted memory as not-existing unless includeDeleted', async () => {
    const edge = await createEdge('edgeref-test-a:next');
    await db.memory.update({ where: { id: memoryId }, data: { deletedAt: new Date() } });
    const ref = `hrn:edge:${memoryUrn.replace(':', '::')}::${edge.loc}`;
    await expect(resolveEdgeRef(db, ref)).rejects.toBeInstanceOf(EdgeNotFoundError);
    await expect(resolveEdgeRef(db, ref, { includeDeleted: true })).resolves.toEqual({
      id: edge.id,
    });
  });
});
