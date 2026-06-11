/**
 * Integration tests for the usageEvents query's memoryId and nodeId filters
 * (issue #249 + follow-up).
 *
 * usageEvents was previously global (type / nodeLoc only). It now accepts:
 *   - memoryId (ID or URN): scopes to events whose node belongs to that memory,
 *     via the UsageEvent→Node relation (FK-precise — collision-proof).
 *   - nodeId (node token): a PK / URN resolves to a single node (exact nodeId
 *     FK); a bare loc exact-matches nodeLoc across memories (like nodeUsage).
 *
 * The fixture deliberately puts the loc `alpha` in two memories to prove the
 * relation/FK scoping is collision-proof and to contrast PK (precise) vs
 * bare-loc (cross-memory) node addressing. Tests also cover ID/URN input
 * variants, the empty-memory case, the deprecated nodeLoc arg, and that
 * omitting all filters preserves the prior global behavior.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

let memory: { id: string; urn: string };
let otherMemory: { id: string; urn: string };
let emptyMemory: { id: string; urn: string };
let alphaNode: { id: string };
let betaNode: { id: string };
let gammaNode: { id: string };
let otherAlphaNode: { id: string };

// These tests exercise filter *mechanics* (memoryId / nodeId / type / paging),
// not access control — so they run as a global ADMIN, which sees every
// (knowledge-class) fixture memory. Access scoping (#250) is covered separately
// in resolvers.usageEvents.access.test.ts.
function ctx(): Context {
  return { db, roles: ['ADMIN'], userId: 'admin-user' } as Context;
}

beforeEach(async () => {
  await cleanDb(db);

  const org = await db.organization.create({
    data: {
      id: generateId(),
      name: 'usage-events-org',
      urn: `usage-events-org-${generateId()}`,
    },
  });

  memory = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: `${org.urn}:populated-mem`,
      name: 'populated-mem',
      class: 'knowledge',
    },
  });

  otherMemory = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: `${org.urn}:other-mem`,
      name: 'other-mem',
      class: 'knowledge',
    },
  });

  emptyMemory = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: `${org.urn}:empty-mem`,
      name: 'empty-mem',
      class: 'knowledge',
    },
  });

  // `memory`: alpha (2 reads, 1 write) + beta (1 read).
  alphaNode = await db.node.create({
    data: { id: generateId(), memoryId: memory.id, loc: 'alpha', name: 'alpha' },
  });
  betaNode = await db.node.create({
    data: { id: generateId(), memoryId: memory.id, loc: 'beta', name: 'beta' },
  });
  // `otherMemory`: gamma (1 read) + a SECOND node also at loc `alpha` (1 read).
  // The colliding `alpha` proves memoryId/PK scoping is FK-precise (it must NOT
  // leak into `memory`'s results) while bare-loc `alpha` spans both memories.
  gammaNode = await db.node.create({
    data: { id: generateId(), memoryId: otherMemory.id, loc: 'gamma', name: 'gamma' },
  });
  otherAlphaNode = await db.node.create({
    data: { id: generateId(), memoryId: otherMemory.id, loc: 'alpha', name: 'alpha' },
  });

  // Events carry both nodeLoc (loc/bare-loc path) and nodeId (memory + per-node
  // FK paths), mirroring how the MCP ingest writes them.
  await db.usageEvent.createMany({
    data: [
      { id: generateId(), type: 'read', nodeLoc: 'alpha', nodeId: alphaNode.id },
      { id: generateId(), type: 'read', nodeLoc: 'alpha', nodeId: alphaNode.id },
      { id: generateId(), type: 'write', nodeLoc: 'alpha', nodeId: alphaNode.id },
      { id: generateId(), type: 'read', nodeLoc: 'beta', nodeId: betaNode.id },
      { id: generateId(), type: 'read', nodeLoc: 'gamma', nodeId: gammaNode.id },
      // otherMemory's alpha — same loc as memory's alpha, different memory/node.
      { id: generateId(), type: 'read', nodeLoc: 'alpha', nodeId: otherAlphaNode.id },
    ],
  });
});

describe('usageEvents memoryId filter', () => {
  it('scopes events to the memory\'s nodes only — input by ID (collision-proof)', async () => {
    const result = await resolvers.Query.usageEvents(null, { memoryId: memory.id }, ctx());
    // 4 events across memory's alpha(3)+beta(1). Crucially, otherMemory's alpha
    // event (same loc, different memory) is excluded — the FK relation filter is
    // collision-proof where a nodeLoc-IN filter would have leaked it (→ 5).
    expect(result).toHaveLength(4);
    const locs = new Set(result.map((e: { nodeLoc: string | null }) => e.nodeLoc));
    expect(locs).toEqual(new Set(['alpha', 'beta']));
    // All belong to memory's nodes, not otherMemory's alpha.
    const ids = new Set(result.map((e: { nodeId: string | null }) => e.nodeId));
    expect(ids.has(otherAlphaNode.id)).toBe(false);
  });

  it('accepts a bare URN as memoryId — identical effect to ID', async () => {
    const result = await resolvers.Query.usageEvents(null, { memoryId: memory.urn }, ctx());
    expect(result).toHaveLength(4);
  });

  it('accepts a prefixed URN (urn:memory:...) as memoryId', async () => {
    const result = await resolvers.Query.usageEvents(
      null,
      { memoryId: `urn:memory:${memory.urn}` },
      ctx(),
    );
    expect(result).toHaveLength(4);
  });

  it('returns an empty array for a memory with no nodes', async () => {
    const result = await resolvers.Query.usageEvents(null, { memoryId: emptyMemory.id }, ctx());
    expect(result).toEqual([]);
  });

  it('combines memoryId with type', async () => {
    const result = await resolvers.Query.usageEvents(
      null,
      { memoryId: memory.id, type: 'write' },
      ctx(),
    );
    expect(result).toHaveLength(1);
    expect(result[0].nodeLoc).toBe('alpha');
  });

  it('narrows within the memory scope when nodeLoc is also given', async () => {
    const result = await resolvers.Query.usageEvents(
      null,
      { memoryId: memory.id, nodeLoc: 'beta' },
      ctx(),
    );
    // beta is within the memory; gamma is excluded even though both are
    // outside an explicit list — memoryId scope wins, nodeLoc narrows.
    expect(result).toHaveLength(1);
    expect(result[0].nodeLoc).toBe('beta');
  });

  it('without memoryId, returns global results (unchanged behavior)', async () => {
    const result = await resolvers.Query.usageEvents(null, {}, ctx());
    // All 6 events across every memory (alpha×3, beta, gamma, otherMemory alpha).
    expect(result).toHaveLength(6);
  });

  it('rejects an unknown memoryId with MEMORY_NOT_FOUND', async () => {
    await expect(
      resolvers.Query.usageEvents(
        null,
        // 25-char cuid-shaped string that doesn't exist in DB.
        { memoryId: 'cnonexistentnonexistent12' },
        ctx(),
      ),
    ).rejects.toThrow(/MEMORY_NOT_FOUND/);
  });
});

describe('usageEvents nodeId filter', () => {
  it('scopes events to a single node — input by node PK (no memoryId)', async () => {
    const result = await resolvers.Query.usageEvents(null, { nodeId: alphaNode.id }, ctx());
    // alpha has 3 events; beta/gamma excluded.
    expect(result).toHaveLength(3);
    const locs = new Set(result.map((e: { nodeLoc: string | null }) => e.nodeLoc));
    expect(locs).toEqual(new Set(['alpha']));
  });

  it('accepts a bare node URN (<memory-urn>:<loc>) — identical effect to PK', async () => {
    const result = await resolvers.Query.usageEvents(
      null,
      { nodeId: `${memory.urn}:alpha` },
      ctx(),
    );
    expect(result).toHaveLength(3);
  });

  it('accepts a prefixed node URN (urn:node:...)', async () => {
    const result = await resolvers.Query.usageEvents(
      null,
      { nodeId: `urn:node:${memory.urn}:alpha` },
      ctx(),
    );
    expect(result).toHaveLength(3);
  });

  it('combines nodeId with type', async () => {
    const result = await resolvers.Query.usageEvents(
      null,
      { nodeId: alphaNode.id, type: 'write' },
      ctx(),
    );
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('write');
  });

  it('PK is memory-precise even when the loc collides across memories', async () => {
    // `alpha` exists in both memory and otherMemory. Addressing by PK returns
    // ONLY memory's alpha events (3), not otherMemory's alpha event.
    const result = await resolvers.Query.usageEvents(null, { nodeId: alphaNode.id }, ctx());
    expect(result).toHaveLength(3);
    const ids = new Set(result.map((e: { nodeId: string | null }) => e.nodeId));
    expect(ids).toEqual(new Set([alphaNode.id]));
  });

  it('bare loc spans memories where PK does not — same collision, different intent', async () => {
    // Contrast with the PK test above: the bare loc `alpha` matches the loc in
    // BOTH memories (3 in memory + 1 in otherMemory = 4).
    const result = await resolvers.Query.usageEvents(null, { nodeId: 'alpha' }, ctx());
    expect(result).toHaveLength(4);
    const ids = new Set(result.map((e: { nodeId: string | null }) => e.nodeId));
    expect(ids).toEqual(new Set([alphaNode.id, otherAlphaNode.id]));
  });

  it('rejects an unknown PK/URN nodeId with NODE_NOT_FOUND', async () => {
    await expect(
      resolvers.Query.usageEvents(
        null,
        { nodeId: 'cnonexistentnonexistent12' },
        ctx(),
      ),
    ).rejects.toThrow(/NODE_NOT_FOUND/);
  });

  // A urn:-prefixed input is always a node ref: a wrong-type URN fails loudly
  // (resolveNodeRef rejects it) rather than silently degrading to a loc filter.
  it('rejects a wrong-type urn: nodeId loudly (does not treat it as a loc)', async () => {
    await expect(
      resolvers.Query.usageEvents(
        null,
        { nodeId: `urn:memory:${memory.urn}` },
        ctx(),
      ),
    ).rejects.toThrow(/NODE_NOT_FOUND/);
  });

  // Bare-loc form: nodeId that isn't a PK or a fully-qualified node URN is
  // treated as a loc and exact-matched against nodeLoc (like nodeUsage).
  it('accepts a bare loc as nodeId — exact nodeLoc match', async () => {
    const result = await resolvers.Query.usageEvents(null, { nodeId: 'beta' }, ctx());
    expect(result).toHaveLength(1);
    expect(result[0].nodeLoc).toBe('beta');
  });

  it('bare-loc nodeId combines with type', async () => {
    const result = await resolvers.Query.usageEvents(
      null,
      { nodeId: 'alpha', type: 'read' },
      ctx(),
    );
    // alpha reads: 2 in memory + 1 in otherMemory = 3 (the alpha write excluded).
    expect(result).toHaveLength(3);
  });

  it('bare-loc nodeId is a filter, not a lookup — unknown loc yields [] (no throw)', async () => {
    const result = await resolvers.Query.usageEvents(null, { nodeId: 'no-such-loc' }, ctx());
    expect(result).toEqual([]);
  });
});
