/**
 * Integration tests for the memoryUsageSummary query.
 *
 * Originally added for spec 007-entity-id-or-urn (ID-or-URN memoryId). Extended
 * for #253:
 *   - scoping moved from `nodeLoc: { in: locs }` to the UsageEvent→Node relation
 *     (FK-precise — a node named `alpha` in another memory no longer inflates
 *     this memory's counts).
 *   - access control (#250, mirrored from usageEvents): a memory the caller
 *     can't read returns [] (no existence leak).
 *
 * Filter/grouping-mechanics tests run as a global ADMIN (sees every fixture
 * memory). Access scoping is covered in its own describe block with real
 * principals. Events carry nodeId (the relation filter keys on it).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

let org: { id: string; urn: string };
let memory: { id: string; urn: string };
let otherMemory: { id: string; urn: string };
let emptyMemory: { id: string; urn: string };
let userMember: { id: string };
let userOutsider: { id: string };

// Mechanics tests run as ADMIN (sees all fixture memories).
function ctx(): Context {
  return { db, roles: ['ADMIN'], userId: 'admin-user' } as Context;
}

beforeEach(async () => {
  await cleanDb(db);

  org = await db.organization.create({
    data: { id: generateId(), name: 'usage-summary-org', urn: `usage-summary-org-${generateId()}` },
  });

  memory = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:populated-mem`, name: 'populated-mem', class: 'knowledge' },
  });
  otherMemory = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:other-mem`, name: 'other-mem', class: 'knowledge' },
  });
  emptyMemory = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:empty-mem`, name: 'empty-mem', class: 'knowledge' },
  });

  // `memory`: alpha (2 reads, 1 write) + beta (1 read).
  const alphaNode = await db.node.create({
    data: { id: generateId(), memoryId: memory.id, loc: 'alpha', name: 'alpha' },
  });
  const betaNode = await db.node.create({
    data: { id: generateId(), memoryId: memory.id, loc: 'beta', name: 'beta' },
  });
  // `otherMemory`: a SECOND node also at loc `alpha` (1 read) — the collision
  // that the old `nodeLoc: { in }` scoping would have wrongly counted.
  const otherAlphaNode = await db.node.create({
    data: { id: generateId(), memoryId: otherMemory.id, loc: 'alpha', name: 'alpha' },
  });

  // Events carry nodeId — the relation filter keys on it (events with a null
  // nodeId are intentionally excluded from the summary).
  await db.usageEvent.createMany({
    data: [
      { id: generateId(), type: 'read', nodeLoc: 'alpha', nodeId: alphaNode.id },
      { id: generateId(), type: 'read', nodeLoc: 'alpha', nodeId: alphaNode.id },
      { id: generateId(), type: 'write', nodeLoc: 'alpha', nodeId: alphaNode.id },
      { id: generateId(), type: 'read', nodeLoc: 'beta', nodeId: betaNode.id },
      { id: generateId(), type: 'read', nodeLoc: 'alpha', nodeId: otherAlphaNode.id }, // otherMemory
    ],
  });

  userMember = await db.user.create({ data: { githubId: 7001, githubUsername: 'sum-mem', roles: ['READER'] } });
  userOutsider = await db.user.create({ data: { githubId: 7002, githubUsername: 'sum-out', roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: userMember.id, role: 'READER' } });
});

describe('memoryUsageSummary', () => {
  it('returns grouped counts per (nodeLoc, type) — collision-proof (input by ID)', async () => {
    const result = await resolvers.Query.memoryUsageSummary(null, { memoryId: memory.id }, ctx());
    expect(result).toHaveLength(3);

    const sorted = [...result].sort((a, b) =>
      `${a.nodeLoc}-${a.type}`.localeCompare(`${b.nodeLoc}-${b.type}`),
    );
    // alpha-read is 2, NOT 3 — otherMemory's alpha event is excluded by the
    // relation filter (the old loc-IN approach would have leaked it).
    expect(sorted).toEqual([
      { nodeLoc: 'alpha', type: 'read', count: 2 },
      { nodeLoc: 'alpha', type: 'write', count: 1 },
      { nodeLoc: 'beta', type: 'read', count: 1 },
    ]);
  });

  // 007-entity-id-or-urn: memoryUsageSummary accepts memoryId as ID or URN.
  it('accepts a URN as memoryId input — identical effect to ID input', async () => {
    const result = await resolvers.Query.memoryUsageSummary(null, { memoryId: memory.urn }, ctx());
    expect(result).toHaveLength(3);
    const totalCount = result.reduce((sum, r) => sum + r.count, 0);
    expect(totalCount).toBe(4); // 2 + 1 + 1, NOT 5 (otherMemory alpha excluded)
  });

  it('accepts a prefixed URN (urn:memory:...) as memoryId input', async () => {
    const result = await resolvers.Query.memoryUsageSummary(null, { memoryId: `urn:memory:${memory.urn}` }, ctx());
    expect(result).toHaveLength(3);
  });

  it('returns an empty array for a memory with no nodes', async () => {
    const result = await resolvers.Query.memoryUsageSummary(null, { memoryId: emptyMemory.id }, ctx());
    expect(result).toEqual([]);
  });

  it('rejects an unknown memoryId with MEMORY_NOT_FOUND', async () => {
    await expect(
      resolvers.Query.memoryUsageSummary(null, { memoryId: 'cnonexistentnonexistent12' }, ctx()),
    ).rejects.toThrow(/MEMORY_NOT_FOUND/);
  });

  // UsageSummaryEntry.nodeLoc is String! — an event with nodeId set but a null
  // nodeLoc must not surface as a { nodeLoc: null } group (which the relation
  // scoping would otherwise admit, violating the schema contract).
  it('excludes events whose nodeLoc is null (no null group)', async () => {
    const ghost = await db.node.create({
      data: { id: generateId(), memoryId: memory.id, loc: 'ghost', name: 'ghost' },
    });
    await db.usageEvent.create({
      data: { id: generateId(), type: 'read', nodeLoc: null, nodeId: ghost.id },
    });
    const result = await resolvers.Query.memoryUsageSummary(null, { memoryId: memory.id }, ctx());
    expect(result.every((r) => r.nodeLoc !== null)).toBe(true);
    // Unchanged from the baseline: alpha(read/write), beta(read) — ghost excluded.
    expect(result).toHaveLength(3);
  });
});

describe('memoryUsageSummary access control (#250)', () => {
  it('an org member can read their memory\'s summary', async () => {
    const result = await resolvers.Query.memoryUsageSummary(
      null, { memoryId: memory.id }, { db, userId: userMember.id, roles: ['READER'] } as Context,
    );
    expect(result).toHaveLength(3);
  });

  it('a non-member is denied with [] (no existence leak)', async () => {
    const result = await resolvers.Query.memoryUsageSummary(
      null, { memoryId: memory.id }, { db, userId: userOutsider.id, roles: ['READER'] } as Context,
    );
    expect(result).toEqual([]);
  });

  it('a caller with no role is rejected by the READER gate', async () => {
    await expect(
      resolvers.Query.memoryUsageSummary(null, { memoryId: memory.id }, { db, roles: [] } as Context),
    ).rejects.toThrow('Forbidden');
  });
});
