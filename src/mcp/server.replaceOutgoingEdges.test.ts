/**
 * Issue #107 regression — `resolveEdgeRefs` + `replaceOutgoingEdges`
 * (the helpers used by the MCP `h-add-node` / `h-update-node` tools)
 * must accept all four `targetId` reference shapes for top-level
 * (single-segment loc) and nested targets, and surface a typed error
 * for unresolvable refs without mutating the source node — instead of
 * FK-erroring or silently writing to `pending_edges`.
 *
 * Prior inline logic only resolved `targetId.includes(':')` via
 * `findFirst({loc})` (no memory scope) — single-segment locs were
 * passed through as raw IDs (FK error) and memory-prefixed/URN forms
 * silently fell through to `pending_edges`.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { resolveEdgeRefs, replaceOutgoingEdges, type ResolvedEdge } from './server.js';
import { generateId } from '../lib/id.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

let admin: { id: string };
let memory: { id: string; urn: string };
let source: { id: string };
let topLevel: { id: string; loc: string };
let nested: { id: string; loc: string };

function ctx(): Context {
  return { db, roles: ['ADMIN'], userId: admin.id };
}

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: 'roe-org', urn: 'roe-org' },
  });
  admin = await db.user.create({
    data: { githubId: 9401, githubUsername: 'roe-admin', roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });
  memory = await resolvers.Mutation.createMemory(
    {},
    { orgId: org.id, name: 'roe-mem' },
    ctx(),
  );
  source = await db.node.create({
    data: { id: generateId(), memoryId: memory.id, loc: 'review:db-type-agnostic', name: 'db-type-agnostic' },
  });
  topLevel = await db.node.create({
    data: { id: generateId(), memoryId: memory.id, loc: 'models', name: 'models' },
  });
  nested = await db.node.create({
    data: { id: generateId(), memoryId: memory.id, loc: 'services:db-model-helper', name: 'db-model-helper' },
  });
});

/** End-to-end helper: resolve, then write. Mirrors what the MCP tools do. */
async function resolveAndWrite(targetId: string): Promise<string | null> {
  const r = await resolveEdgeRefs(
    [{ targetId, label: 'use this pattern' }],
    memory.id,
  );
  if ('error' in r) return r.error;
  await replaceOutgoingEdges({ sourceNodeId: source.id, resolved: r.resolved, createdBy: admin.id });
  return null;
}

describe('resolveEdgeRefs — top-level (single-segment) target (#107)', () => {
  it('persists edge when target is a single-segment short loc', async () => {
    expect(await resolveAndWrite('models')).toBeNull();
    expect(await db.edge.count({ where: { sourceId: source.id, targetId: topLevel.id } })).toBe(1);
  });

  it('persists edge when target is `<memory-urn>:<single-segment-loc>`', async () => {
    expect(await resolveAndWrite(`${memory.urn}:models`)).toBeNull();
    expect(await db.edge.count({ where: { sourceId: source.id, targetId: topLevel.id } })).toBe(1);
  });

  it('persists edge when target is `urn:node:<memory-urn>:<single-segment-loc>`', async () => {
    expect(await resolveAndWrite(`urn:node:${memory.urn}:models`)).toBeNull();
    expect(await db.edge.count({ where: { sourceId: source.id, targetId: topLevel.id } })).toBe(1);
  });

  it('persists edge when target is the bare node ID', async () => {
    expect(await resolveAndWrite(topLevel.id)).toBeNull();
    expect(await db.edge.count({ where: { sourceId: source.id, targetId: topLevel.id } })).toBe(1);
  });
});

describe('resolveEdgeRefs — nested target', () => {
  it('persists edge for a multi-segment short loc', async () => {
    expect(await resolveAndWrite(nested.loc)).toBeNull();
    expect(await db.edge.count({ where: { sourceId: source.id, targetId: nested.id } })).toBe(1);
  });
});

describe('resolveEdgeRefs — error handling', () => {
  it('returns an error for an unresolvable short loc and writes nothing', async () => {
    const r = await resolveEdgeRefs([{ targetId: 'does-not-exist', label: 'x' }], memory.id);
    expect('error' in r && r.error).toMatch(/Edge target not found.*does-not-exist/);
    // Caller would not call replaceOutgoingEdges in this branch, so no
    // edges or pending_edges should ever appear.
    expect(await db.edge.count({ where: { sourceId: source.id } })).toBe(0);
    expect(await db.pendingEdge.count({ where: { sourceId: source.id } })).toBe(0);
  });

  it('returns an error for an unresolvable URN and writes nothing', async () => {
    const r = await resolveEdgeRefs(
      [{ targetId: `urn:node:${memory.urn}:gone`, label: 'x' }],
      memory.id,
    );
    expect('error' in r && r.error).toMatch(/Edge target not found/);
    expect(await db.edge.count({ where: { sourceId: source.id } })).toBe(0);
    expect(await db.pendingEdge.count({ where: { sourceId: source.id } })).toBe(0);
  });
});

describe('replaceOutgoingEdges — replacement semantics', () => {
  it('fully replaces existing edges (prior set cleared, new set written)', async () => {
    // Seed an existing edge.
    await replaceOutgoingEdges({
      sourceNodeId: source.id,
      resolved: [{ targetNodeId: topLevel.id, label: 'a' }],
      createdBy: admin.id,
    });
    // Replace with a different one.
    await replaceOutgoingEdges({
      sourceNodeId: source.id,
      resolved: [{ targetNodeId: nested.id, label: 'cites' }],
      createdBy: admin.id,
    });
    const edges = await db.edge.findMany({ where: { sourceId: source.id } });
    expect(edges).toHaveLength(1);
    expect(edges[0].targetId).toBe(nested.id);
    expect(edges[0].label).toBe('cites');
  });

  it('clears all edges when called with an empty array', async () => {
    await replaceOutgoingEdges({
      sourceNodeId: source.id,
      resolved: [{ targetNodeId: topLevel.id, label: 'a' }],
      createdBy: admin.id,
    });
    await replaceOutgoingEdges({ sourceNodeId: source.id, resolved: [], createdBy: admin.id });
    expect(await db.edge.count({ where: { sourceId: source.id } })).toBe(0);
  });

  it('writes the deleteMany + createMany inside a single transaction', async () => {
    // If a duplicate-row collision inside the input array would force
    // the createMany to fail, the whole replacement must roll back —
    // the prior edge stays intact, no half-written state.
    await replaceOutgoingEdges({
      sourceNodeId: source.id,
      resolved: [{ targetNodeId: topLevel.id, label: 'seed' }],
      createdBy: admin.id,
    });
    // Force a unique-constraint failure by passing two rows with the
    // same (sourceId, targetId, label) and skipDuplicates: true. With
    // skipDuplicates the duplicate is silently dropped and the
    // transaction commits — but the prior `seed` edge is gone (a
    // legitimate replacement). To assert atomicity under failure, we
    // wrap the call in a try/catch and inject a failure by including
    // a row whose targetId references a node that gets deleted between
    // resolution and write.
    const ghost = await db.node.create({
      data: { id: generateId(), memoryId: memory.id, loc: 'ghost', name: 'ghost' },
    });
    await db.node.delete({ where: { id: ghost.id } });
    let threw = false;
    try {
      await replaceOutgoingEdges({
        sourceNodeId: source.id,
        resolved: [{ targetNodeId: ghost.id, label: 'will-fk-error' }],
        createdBy: admin.id,
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    // Atomicity: the failed createMany must have rolled back the
    // deleteMany, leaving the original `seed` edge intact.
    const edges = await db.edge.findMany({ where: { sourceId: source.id } });
    expect(edges).toHaveLength(1);
    expect(edges[0].label).toBe('seed');
  });
});

describe('two-phase API — partial-apply prevention', () => {
  it('does not call replaceOutgoingEdges when resolution fails (caller pattern)', async () => {
    const r = await resolveEdgeRefs(
      [
        { targetId: topLevel.id, label: 'good' },
        { targetId: 'does-not-exist', label: 'bad' },
      ],
      memory.id,
    );
    // Resolution failed for one of the refs; caller would short-circuit
    // and never invoke replaceOutgoingEdges, so no edges are written
    // even for the good ref.
    expect('error' in r).toBe(true);
    expect(await db.edge.count({ where: { sourceId: source.id } })).toBe(0);
  });
});
