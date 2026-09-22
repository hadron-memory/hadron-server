/**
 * Issue #107 regression — `resolveEdgeRefs` + `replaceOutgoingEdges`
 * (the helpers used by the MCP `hadron_create_node` / `hadron_update_node` tools)
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
import type { AuthContext } from '../middleware/auth.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

let admin: { id: string };
let memory: { id: string; urn: string };
let source: { id: string; loc: string; memoryId: string };
let topLevel: { id: string; loc: string };
let nested: { id: string; loc: string };

function ctx(): Context {
  return { db, roles: ['ADMIN'], userId: admin.id };
}

/** ADMIN bypasses the per-memory access map, so the fixture memory is readable. */
function adminAuth(): AuthContext {
  return { userId: admin.id, roles: ['ADMIN'], clientId: `user:${admin.id}` };
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
    [{ targetId, name: 'use this pattern' }],
    memory.id,
    adminAuth(),
  );
  if ('error' in r) return r.error;
  await replaceOutgoingEdges({
    sourceNodeId: source.id,
    sourceLoc: source.loc,
    sourceMemoryId: source.memoryId,
    resolved: r.resolved,
    createdBy: admin.id,
  });
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

describe('resolveEdgeRefs — canonical `::` URN inputs (#183)', () => {
  // hadron_get_node accepts canonical-form node URNs (it routes through
  // `splitNodeUrn`, which understands `::`). The edge-target resolver
  // used a colon-naive `.split(':')` and produced empty segments for
  // those same inputs — they silently failed with "Edge target not
  // found". Lock the symmetry shut: any URN the read path accepts MUST
  // resolve as an edge target.

  it('resolves a canonical `<org>::<memory>::<loc>` bare URN', async () => {
    // memory.urn is stored bare in legacy form (`<org>:<memory>`);
    // construct the canonical-form input the way hadron_get_node would
    // round-trip it.
    const canonicalRef = `${memory.urn.replace(':', '::')}::${nested.loc}`;
    expect(await resolveAndWrite(canonicalRef)).toBeNull();
    expect(await db.edge.count({ where: { sourceId: source.id, targetId: nested.id } })).toBe(1);
  });

  it('resolves a canonical `urn:node:<org>::<memory>::<loc>` prefixed URN', async () => {
    const canonicalRef = `urn:node:${memory.urn.replace(':', '::')}::${nested.loc}`;
    expect(await resolveAndWrite(canonicalRef)).toBeNull();
    expect(await db.edge.count({ where: { sourceId: source.id, targetId: nested.id } })).toBe(1);
  });

  it('resolves a canonical URN with a single-segment loc (the issue-#183 repro)', async () => {
    // The original bug report's exact shape: a top-level loc
    // referenced via the canonical separator the read path produces.
    const canonicalRef = `${memory.urn.replace(':', '::')}::${topLevel.loc}`;
    expect(await resolveAndWrite(canonicalRef)).toBeNull();
    expect(await db.edge.count({ where: { sourceId: source.id, targetId: topLevel.id } })).toBe(1);
  });
});

describe('resolveEdgeRefs — error handling', () => {
  it('returns an error for an unresolvable short loc and writes nothing', async () => {
    const r = await resolveEdgeRefs([{ targetId: 'does-not-exist', name: 'x' }], memory.id, adminAuth());
    expect('error' in r && r.error).toMatch(/Edge target not found.*does-not-exist/);
    // Caller would not call replaceOutgoingEdges in this branch, so no
    // edges or pending_edges should ever appear.
    expect(await db.edge.count({ where: { sourceId: source.id } })).toBe(0);
    expect(await db.pendingEdge.count({ where: { sourceId: source.id } })).toBe(0);
  });

  it('returns an error for an unresolvable URN and writes nothing', async () => {
    const r = await resolveEdgeRefs(
      [{ targetId: `urn:node:${memory.urn}:gone`, name: 'x' }],
      memory.id,
      adminAuth(),
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
      sourceLoc: source.loc,
      sourceMemoryId: source.memoryId,
      resolved: [{ targetNodeId: topLevel.id, targetLoc: topLevel.loc, name: 'a', loc: null, description: null, isRunnable: null }],
      createdBy: admin.id,
    });
    // Replace with a different one.
    await replaceOutgoingEdges({
      sourceNodeId: source.id,
      sourceLoc: source.loc,
      sourceMemoryId: source.memoryId,
      resolved: [{ targetNodeId: nested.id, targetLoc: nested.loc, name: 'cites', loc: null, description: null, isRunnable: null }],
      createdBy: admin.id,
    });
    const edges = await db.edge.findMany({ where: { sourceId: source.id } });
    expect(edges).toHaveLength(1);
    expect(edges[0].targetId).toBe(nested.id);
    expect(edges[0].name).toBe('cites');
  });

  it('clears all edges when called with an empty array', async () => {
    await replaceOutgoingEdges({
      sourceNodeId: source.id,
      sourceLoc: source.loc,
      sourceMemoryId: source.memoryId,
      resolved: [{ targetNodeId: topLevel.id, targetLoc: topLevel.loc, name: 'a', loc: null, description: null, isRunnable: null }],
      createdBy: admin.id,
    });
    await replaceOutgoingEdges({
      sourceNodeId: source.id,
      sourceLoc: source.loc,
      sourceMemoryId: source.memoryId,
      resolved: [],
      createdBy: admin.id,
    });
    expect(await db.edge.count({ where: { sourceId: source.id } })).toBe(0);
  });

  it('writes the deleteMany + createMany inside a single transaction', async () => {
    // If a duplicate-row collision inside the input array would force
    // the createMany to fail, the whole replacement must roll back —
    // the prior edge stays intact, no half-written state.
    await replaceOutgoingEdges({
      sourceNodeId: source.id,
      sourceLoc: source.loc,
      sourceMemoryId: source.memoryId,
      resolved: [{ targetNodeId: topLevel.id, targetLoc: topLevel.loc, name: 'seed', loc: null, description: null, isRunnable: null }],
      createdBy: admin.id,
    });
    // Force a per-memory `loc` unique collision by passing two rows that
    // derive the same loc and skipDuplicates: true. With skipDuplicates
    // the duplicate is silently dropped and the transaction commits —
    // but the prior `seed` edge is gone (a legitimate replacement). To
    // assert atomicity under failure, we wrap the call in a try/catch
    // and inject a failure by including a row whose targetId references
    // a node that gets deleted between resolution and write.
    const ghost = await db.node.create({
      data: { id: generateId(), memoryId: memory.id, loc: 'ghost', name: 'ghost' },
    });
    await db.node.delete({ where: { id: ghost.id } });
    let threw = false;
    try {
      await replaceOutgoingEdges({
        sourceNodeId: source.id,
        sourceLoc: source.loc,
        sourceMemoryId: source.memoryId,
        resolved: [{ targetNodeId: ghost.id, targetLoc: 'ghost', name: 'will-fk-error', loc: null, description: null, isRunnable: null }],
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
    expect(edges[0].name).toBe('seed');
  });
});

describe('two-phase API — partial-apply prevention', () => {
  it('does not call replaceOutgoingEdges when resolution fails (caller pattern)', async () => {
    const r = await resolveEdgeRefs(
      [
        { targetId: topLevel.id, name: 'good' },
        { targetId: 'does-not-exist', name: 'bad' },
      ],
      memory.id,
      adminAuth(),
    );
    // Resolution failed for one of the refs; caller would short-circuit
    // and never invoke replaceOutgoingEdges, so no edges are written
    // even for the good ref.
    expect('error' in r).toBe(true);
    expect(await db.edge.count({ where: { sourceId: source.id } })).toBe(0);
  });
});

/**
 * #755 — `resolveEdgeRefs` resolves an edge target through `resolveNodeRef`, a
 * pure DB lookup with NO auth context. Without a `canReadMemory` gate,
 * `hadron_create_node` / `hadron_update_node` could point an edge at a node in
 * a memory the caller cannot read — a foreign-memory existence oracle, and a
 * cross-tenant content read once the edge is hydrated via `Edge.target`. The
 * single-edge `addEdge` path was always gated; this bulk path was not.
 */
describe('resolveEdgeRefs — foreign-memory target gate (#755)', () => {
  let victimNode: { id: string };
  let outsiderAuth: AuthContext;

  beforeEach(async () => {
    const victimOrg = await db.organization.create({
      data: { id: generateId(), name: 'victim-org', urn: `victim-${generateId()}` },
    });
    const victimMem = await db.memory.create({
      data: {
        id: generateId(), organizationId: victimOrg.id, urn: `${victimOrg.urn}:secrets`,
        name: 'victim secrets', class: 'knowledge', visibility: 'ORGANIZATION',
      },
    });
    victimNode = await db.node.create({
      data: {
        id: generateId(), memoryId: victimMem.id, loc: 'crown-jewels',
        name: 'crown-jewels', content: 'CROSS-TENANT-SECRET',
      },
    });
    // An authenticated caller who belongs to NO org — no read on victimMem.
    const outsider = await db.user.create({
      data: { id: generateId(), githubId: 9402, githubUsername: 'roe-outsider', roles: ['READER'] },
    });
    outsiderAuth = { userId: outsider.id, roles: ['READER'], clientId: `user:${outsider.id}` };
  });

  it('refuses a target in a memory the caller cannot read', async () => {
    const r = await resolveEdgeRefs(
      [{ targetId: victimNode.id, name: 'exfil' }],
      memory.id,
      outsiderAuth,
    );
    expect('error' in r && r.error).toMatch(/Edge target not found/);
  });

  it('uses the genuine-miss wording — no existence oracle', async () => {
    const bogusId = generateId();
    const real = await resolveEdgeRefs(
      [{ targetId: victimNode.id, name: 'exfil' }],
      memory.id,
      outsiderAuth,
    );
    const bogus = await resolveEdgeRefs(
      [{ targetId: bogusId, name: 'exfil' }],
      memory.id,
      outsiderAuth,
    );
    // Each message echoes the caller's OWN ref, so compare the shape with the
    // ref factored out: a real-but-unreadable node and a node that never
    // existed must be indistinguishable.
    const shape = (msg: string | false, ref: string) => msg && msg.replace(ref, '<REF>');
    expect(shape('error' in real ? real.error : false, victimNode.id))
      .toBe(shape('error' in bogus ? bogus.error : false, bogusId));
    expect('error' in real && real.error).toBe(`Edge target not found: "${victimNode.id}"`);
  });

  it('a caller who CAN read the target still resolves it (no regression)', async () => {
    const r = await resolveEdgeRefs(
      [{ targetId: victimNode.id, name: 'ok' }],
      memory.id,
      adminAuth(),
    );
    expect('error' in r).toBe(false);
  });
});
