/**
 * Integration tests for the usageEvents query's memoryId filter (issue #249).
 *
 * usageEvents was previously global (type / nodeLoc only). This issue adds an
 * optional memoryId argument that scopes results to the memory's node locs,
 * mirroring memoryUsageSummary. Tests cover the new scoping, ID-or-URN input,
 * the empty-memory short-circuit, the memoryId+nodeLoc interaction, and that
 * omitting memoryId preserves the prior global behavior.
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

// usageEvents calls requireRole(ctx, 'READER'); supply a role so the gate passes.
function ctx(): Context {
  return { db, roles: ['READER'] } as Context;
}

beforeEach(async () => {
  await cleanDb(db);

  const org = await db.organization.create({
    data: {
      id: generateId(),
      name: 'usage-events-org',
      urn: `usage-events-org-${Date.now()}`,
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
  // `otherMemory`: gamma (1 read) — must NOT appear in memory-scoped results.
  gammaNode = await db.node.create({
    data: { id: generateId(), memoryId: otherMemory.id, loc: 'gamma', name: 'gamma' },
  });

  // Events carry both nodeLoc (memory-scope path) and nodeId (per-node path),
  // mirroring how the MCP ingest writes them.
  await db.usageEvent.createMany({
    data: [
      { id: generateId(), type: 'read', nodeLoc: 'alpha', nodeId: alphaNode.id },
      { id: generateId(), type: 'read', nodeLoc: 'alpha', nodeId: alphaNode.id },
      { id: generateId(), type: 'write', nodeLoc: 'alpha', nodeId: alphaNode.id },
      { id: generateId(), type: 'read', nodeLoc: 'beta', nodeId: betaNode.id },
      { id: generateId(), type: 'read', nodeLoc: 'gamma', nodeId: gammaNode.id },
    ],
  });
});

describe('usageEvents memoryId filter', () => {
  it('scopes events to the memory\'s nodes only — input by ID', async () => {
    const result = await resolvers.Query.usageEvents(null, { memoryId: memory.id }, ctx());
    // 4 events across alpha+beta; gamma (otherMemory) excluded.
    expect(result).toHaveLength(4);
    const locs = new Set(result.map((e: { nodeLoc: string | null }) => e.nodeLoc));
    expect(locs).toEqual(new Set(['alpha', 'beta']));
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
    // All 5 events across every memory.
    expect(result).toHaveLength(5);
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

  it('returns a single node\'s events even when its loc lives in another memory too', async () => {
    // gamma is in otherMemory; addressing it by PK returns only its event.
    const result = await resolvers.Query.usageEvents(null, { nodeId: gammaNode.id }, ctx());
    expect(result).toHaveLength(1);
    expect(result[0].nodeLoc).toBe('gamma');
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
    expect(result).toHaveLength(2); // alpha has 2 reads + 1 write
  });

  it('bare-loc nodeId is a filter, not a lookup — unknown loc yields [] (no throw)', async () => {
    const result = await resolvers.Query.usageEvents(null, { nodeId: 'no-such-loc' }, ctx());
    expect(result).toEqual([]);
  });
});
