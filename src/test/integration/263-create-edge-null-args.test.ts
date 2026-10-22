/**
 * Issue #263 — createEdge failed against a real Prisma client when the
 * caller sent explicit nulls for unset nullable args (the Go CLI does
 * this; JS callers send undefined, which is why the mocked-db tests
 * never caught it).
 *
 * Root cause: `priority` is a non-nullable `Int @default(0)`. Forwarding
 * `priority: null` to `edge.create` fails Prisma validation — and the
 * invalid field disqualifies the scalar-FK (unchecked) input variant, so
 * the error surfaces as a baffling "Argument `source` is missing".
 *
 * This test exercises the exact CLI argument shape end-to-end against
 * the real client + Postgres.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { generateId } from '../../lib/id.js';
import { composeEdgeUrn } from '../../lib/urn.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';

let nodeA: { id: string };
let nodeB: { id: string };
let memUrn: string;

function adminCtx(): Context {
  // userId is required for the PR-348 createEdge write gate's JWT path; the
  // global ADMIN role then bypasses per-org membership for non-personal
  // memories (requireMemoryWriteAccess) and read (canReadMemory).
  return { db, roles: ['ADMIN'], userId: 'admin-263' };
}

beforeEach(async () => {
  await cleanDb(db);
  await db.user.create({ data: { id: 'admin-263', roles: ['ADMIN'] } });
  const org = await db.organization.create({
    data: { id: generateId(), name: 'EdgeNull', urn: 'edge-null-263' },
  });
  const memory = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: 'edge-null-263:kb',
      name: 'kb',
      class: 'knowledge',
    },
  });
  memUrn = memory.urn;
  nodeA = await db.node.create({
    data: { id: generateId(), memoryId: memory.id, loc: 'a', name: 'A' },
  });
  nodeB = await db.node.create({
    data: { id: generateId(), memoryId: memory.id, loc: 'b', name: 'B' },
  });
});

describe('createEdge endpoint refs accept PK or URN (#322)', () => {
  it('resolves a fully-qualified URN for either endpoint (no longer PK-only)', async () => {
    const edge = await resolvers.Mutation.createEdge(
      {},
      {
        sourceRef: `urn:node:${memUrn}:a`,
        targetRef: `urn:node:${memUrn}:b`,
        name: 'routes-to',
      },
      adminCtx(),
    );
    expect(edge.sourceId).toBe(nodeA.id);
    expect(edge.targetId).toBe(nodeB.id);
  });

  it('accepts a mix of PK source + URN target', async () => {
    const edge = await resolvers.Mutation.createEdge(
      {},
      { sourceRef: nodeA.id, targetRef: `urn:node:${memUrn}:b`, name: 'mixed' },
      adminCtx(),
    );
    expect(edge.sourceId).toBe(nodeA.id);
    expect(edge.targetId).toBe(nodeB.id);
  });

  it('throws NODE_NOT_FOUND with the source wording for an unresolvable source', async () => {
    await expect(
      resolvers.Mutation.createEdge(
        {},
        { sourceRef: `urn:node:${memUrn}:nope`, targetRef: nodeB.id, name: 'x' },
        adminCtx(),
      ),
    ).rejects.toThrow(/Source node not found/);
  });

  it('rejects a caller without write access to the source memory (PR-348 gate)', async () => {
    // A user who is NOT a member of the memory's org has no write access.
    // Pre-PR-348 createEdge only checked the global role and would have
    // created the edge anyway. Since #1300 (PR #1307) such a caller, who cannot
    // even READ the source's memory, is told NODE_NOT_FOUND — the same answer a
    // missing ref gets — so the refusal is not a cross-tenant existence oracle.
    const outsider: Context = { db, roles: ['CONTRIBUTOR'], userId: 'outsider-263' };
    await expect(
      resolvers.Mutation.createEdge(
        {},
        { sourceRef: nodeA.id, targetRef: nodeB.id, name: 'nope' },
        outsider,
      ),
    ).rejects.toMatchObject({ extensions: { code: 'NODE_NOT_FOUND' } });
    expect(await db.edge.count({ where: { sourceId: nodeA.id } })).toBe(0);
  });
});

describe('createEdge with explicit-null args (CLI shape, #263)', () => {
  it('creates the edge when condition/priority/data are explicit nulls', async () => {
    const edge = await resolvers.Mutation.createEdge(
      {},
      {
        sourceRef: nodeA.id,
        targetRef: nodeB.id,
        name: 'routes-to',
        condition: null,
        priority: null,
        data: null,
      },
      adminCtx(),
    );
    expect(edge.sourceId).toBe(nodeA.id);
    expect(edge.targetId).toBe(nodeB.id);
    // priority falls back to the schema default.
    const stored = await db.edge.findUniqueOrThrow({ where: { id: edge.id } });
    expect(stored.priority).toBe(0);
  });

  it('updateEdge nulls: priority kept (unset), condition/data cleared (spec contract)', async () => {
    const condition = { '>': [{ var: 'chat.message_count' }, 20] };
    const data = { kind: 'transition' };
    const edge = await resolvers.Mutation.createEdge(
      {},
      {
        sourceRef: nodeA.id,
        targetRef: nodeB.id,
        name: 'routes-to',
        priority: 7,
        condition,
        data,
      },
      adminCtx(),
    );
    await resolvers.Mutation.updateEdge(
      {},
      { edgeRef: edge.id, name: 'renamed', condition: null, priority: null, data: null },
      adminCtx(),
    );
    const stored = await db.edge.findUniqueOrThrow({ where: { id: edge.id } });
    expect(stored.name).toBe('renamed');
    // priority: null = unset — the non-nullable Int keeps its stored value.
    expect(stored.priority).toBe(7);
    // condition/data: null = clear, per the edge-conditions contract
    // ("null condition = always fires"). Clients that mean "unset" must
    // omit the variable (hadron-cli genqlient fix tracked separately).
    expect(stored.condition).toBeNull();
    expect(stored.data).toBeNull();
  });
});

// #542 Tier 2 — updateEdge/deleteEdge resolve `edgeRef` via resolveEdgeRef, so
// a fully-qualified edge URN works, not just a PK (previously `where: { id }`).
describe('updateEdge/deleteEdge accept an edge PK or URN (#542 Tier 2)', () => {
  it('updateEdge resolves a fully-qualified edge URN', async () => {
    const edge = await resolvers.Mutation.createEdge(
      {},
      { sourceRef: nodeA.id, targetRef: nodeB.id, name: 'cites' },
      adminCtx(),
    );
    const edgeUrn = composeEdgeUrn(memUrn, edge.loc);
    const updated = await resolvers.Mutation.updateEdge(
      {},
      { edgeRef: edgeUrn, description: 'set via urn' },
      adminCtx(),
    );
    expect(updated.id).toBe(edge.id);
    expect(updated.description).toBe('set via urn');
  });

  it('deleteEdge resolves a fully-qualified edge URN', async () => {
    const edge = await resolvers.Mutation.createEdge(
      {},
      { sourceRef: nodeA.id, targetRef: nodeB.id, name: 'documents' },
      adminCtx(),
    );
    const edgeUrn = composeEdgeUrn(memUrn, edge.loc);
    const ok = await resolvers.Mutation.deleteEdge({}, { edgeRef: edgeUrn }, adminCtx());
    expect(ok).toBe(true);
    expect(await db.edge.findUnique({ where: { id: edge.id } })).toBeNull();
  });

  it('a missing edge ref surfaces EDGE_NOT_FOUND (not an unwrapped Prisma error)', async () => {
    await expect(
      resolvers.Mutation.deleteEdge({}, { edgeRef: 'f'.repeat(32) }, adminCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'EDGE_NOT_FOUND' } });
  });

  it('gates on memory write access — a CONTRIBUTOR non-member cannot edit/delete by URN (Codex #554)', async () => {
    const edge = await resolvers.Mutation.createEdge(
      {},
      { sourceRef: nodeA.id, targetRef: nodeB.id, name: 'gated' },
      adminCtx(),
    );
    const edgeUrn = composeEdgeUrn(memUrn, edge.loc);
    // Passes the global CONTRIBUTOR role gate but is NOT a member of the edge's
    // org/memory (CONTRIBUTOR is not an ADMIN/OWNER bypass role), so the new
    // requireMemoryWriteAccess check must reject.
    const outsider: Context = { db, roles: ['CONTRIBUTOR'], userId: 'contrib-outsider-263' };
    await expect(
      resolvers.Mutation.updateEdge({}, { edgeRef: edgeUrn, description: 'hijack' }, outsider),
    ).rejects.toThrow();
    await expect(
      resolvers.Mutation.deleteEdge({}, { edgeRef: edgeUrn }, outsider),
    ).rejects.toThrow();
    // The edge is untouched.
    const still = await db.edge.findUnique({ where: { id: edge.id } });
    expect(still).not.toBeNull();
    expect(still?.description ?? null).toBeNull();
  });
});
