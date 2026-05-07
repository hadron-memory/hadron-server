/**
 * Issue #107 regression — `replaceOutgoingEdges` (the helper used by
 * the MCP `h-add-node` / `h-update-node` tools) must accept all four
 * `targetId` reference shapes for top-level (single-segment loc) and
 * nested targets, and return a typed error string for unresolvable
 * refs instead of FK-erroring or silently writing to `pending_edges`.
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
import { replaceOutgoingEdges } from './server.js';
import { generateId } from '../lib/id.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

let org: { id: string; urn: string };
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
  org = await db.organization.create({
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

async function run(targetId: string) {
  return replaceOutgoingEdges({
    sourceNodeId: source.id,
    sourceMemoryId: memory.id,
    edges: [{ targetId, label: 'use this pattern' }],
    createdBy: admin.id,
  });
}

describe('replaceOutgoingEdges — top-level (single-segment) target (#107)', () => {
  it('persists edge when target is a single-segment short loc', async () => {
    const err = await run('models');
    expect(err).toBeNull();
    expect(await db.edge.count({ where: { sourceId: source.id, targetId: topLevel.id } })).toBe(1);
  });

  it('persists edge when target is `<memory-urn>:<single-segment-loc>`', async () => {
    const err = await run(`${memory.urn}:models`);
    expect(err).toBeNull();
    expect(await db.edge.count({ where: { sourceId: source.id, targetId: topLevel.id } })).toBe(1);
  });

  it('persists edge when target is `urn:node:<memory-urn>:<single-segment-loc>`', async () => {
    const err = await run(`urn:node:${memory.urn}:models`);
    expect(err).toBeNull();
    expect(await db.edge.count({ where: { sourceId: source.id, targetId: topLevel.id } })).toBe(1);
  });

  it('persists edge when target is the bare node ID', async () => {
    const err = await run(topLevel.id);
    expect(err).toBeNull();
    expect(await db.edge.count({ where: { sourceId: source.id, targetId: topLevel.id } })).toBe(1);
  });
});

describe('replaceOutgoingEdges — nested target', () => {
  it('persists edge for a multi-segment short loc', async () => {
    const err = await run(nested.loc);
    expect(err).toBeNull();
    expect(await db.edge.count({ where: { sourceId: source.id, targetId: nested.id } })).toBe(1);
  });
});

describe('replaceOutgoingEdges — error handling', () => {
  it('returns an error message for an unresolvable short loc and writes nothing', async () => {
    const err = await run('does-not-exist');
    expect(err).toMatch(/Edge target not found.*does-not-exist/);
    expect(await db.edge.count({ where: { sourceId: source.id } })).toBe(0);
    expect(await db.pendingEdge.count({ where: { sourceId: source.id } })).toBe(0);
  });

  it('returns an error message for an unresolvable URN and writes nothing', async () => {
    const err = await run(`urn:node:${memory.urn}:gone`);
    expect(err).toMatch(/Edge target not found/);
    expect(await db.edge.count({ where: { sourceId: source.id } })).toBe(0);
    expect(await db.pendingEdge.count({ where: { sourceId: source.id } })).toBe(0);
  });
});

describe('replaceOutgoingEdges — replacement semantics', () => {
  it('replaces existing edges atomically (no leftovers from prior writes)', async () => {
    const first = await run(topLevel.id);
    expect(first).toBeNull();
    const second = await replaceOutgoingEdges({
      sourceNodeId: source.id,
      sourceMemoryId: memory.id,
      edges: [{ targetId: nested.id, label: 'cites' }],
      createdBy: admin.id,
    });
    expect(second).toBeNull();
    const edges = await db.edge.findMany({ where: { sourceId: source.id } });
    expect(edges).toHaveLength(1);
    expect(edges[0].targetId).toBe(nested.id);
    expect(edges[0].label).toBe('cites');
  });

  it('clears all edges when called with an empty array', async () => {
    await run(topLevel.id);
    const err = await replaceOutgoingEdges({
      sourceNodeId: source.id,
      sourceMemoryId: memory.id,
      edges: [],
      createdBy: admin.id,
    });
    expect(err).toBeNull();
    expect(await db.edge.count({ where: { sourceId: source.id } })).toBe(0);
  });
});
