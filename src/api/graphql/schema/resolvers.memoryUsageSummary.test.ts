/**
 * Integration tests for the memoryUsageSummary query.
 *
 * This op had zero existing test coverage. Added as part of spec
 * 007-entity-id-or-urn (which widens memoryId to accept ID or URN);
 * tests cover both the existing ID-input behavior (gap-fill) and the
 * new URN-input paths.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

let memory: { id: string; urn: string };
let emptyMemory: { id: string; urn: string };

function ctx(): Context {
  return { db };
}

beforeEach(async () => {
  await cleanDb(db);

  const org = await db.organization.create({
    data: {
      id: generateId(),
      name: 'usage-summary-org',
      urn: `usage-summary-org-${Date.now()}`,
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

  emptyMemory = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: `${org.urn}:empty-mem`,
      name: 'empty-mem',
      class: 'knowledge',
    },
  });

  // Two nodes in `memory`: alpha (2 reads, 1 write) + beta (1 read).
  await db.node.create({
    data: { id: generateId(), memoryId: memory.id, loc: 'alpha', name: 'alpha' },
  });
  await db.node.create({
    data: { id: generateId(), memoryId: memory.id, loc: 'beta', name: 'beta' },
  });

  // Usage events.
  await db.usageEvent.createMany({
    data: [
      { id: generateId(), type: 'read', nodeLoc: 'alpha' },
      { id: generateId(), type: 'read', nodeLoc: 'alpha' },
      { id: generateId(), type: 'write', nodeLoc: 'alpha' },
      { id: generateId(), type: 'read', nodeLoc: 'beta' },
    ],
  });
});

describe('memoryUsageSummary', () => {
  it('returns grouped counts of usage events per (nodeLoc, type) — input by ID', async () => {
    const result = await resolvers.Query.memoryUsageSummary(
      null,
      { memoryId: memory.id },
      ctx(),
    );
    expect(result).toHaveLength(3);

    // Sort for deterministic comparison.
    const sorted = [...result].sort((a, b) =>
      `${a.nodeLoc}-${a.type}`.localeCompare(`${b.nodeLoc}-${b.type}`),
    );
    expect(sorted).toEqual([
      { nodeLoc: 'alpha', type: 'read', count: 2 },
      { nodeLoc: 'alpha', type: 'write', count: 1 },
      { nodeLoc: 'beta', type: 'read', count: 1 },
    ]);
  });

  // 007-entity-id-or-urn: memoryUsageSummary accepts memoryId as ID or URN.
  it('accepts a URN as memoryId input — identical effect to ID input', async () => {
    const result = await resolvers.Query.memoryUsageSummary(
      null,
      { memoryId: memory.urn },
      ctx(),
    );
    expect(result).toHaveLength(3);
    const totalCount = result.reduce((sum, r) => sum + r.count, 0);
    expect(totalCount).toBe(4); // 2 + 1 + 1
  });

  it('accepts a prefixed URN (urn:memory:...) as memoryId input', async () => {
    const result = await resolvers.Query.memoryUsageSummary(
      null,
      { memoryId: `urn:memory:${memory.urn}` },
      ctx(),
    );
    expect(result).toHaveLength(3);
  });

  it('returns an empty array for a memory with no nodes', async () => {
    const result = await resolvers.Query.memoryUsageSummary(
      null,
      { memoryId: emptyMemory.id },
      ctx(),
    );
    expect(result).toEqual([]);
  });

  it('rejects an unknown memoryId with MEMORY_NOT_FOUND', async () => {
    await expect(
      resolvers.Query.memoryUsageSummary(
        null,
        // 25-char cuid-shaped string that doesn't exist in DB.
        { memoryId: 'cnonexistentnonexistent12' },
        ctx(),
      ),
    ).rejects.toThrow(/MEMORY_NOT_FOUND/);
  });
});
