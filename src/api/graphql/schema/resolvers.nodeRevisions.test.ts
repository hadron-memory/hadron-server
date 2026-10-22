/**
 * Integration tests for the nodeRevisions query (#602).
 *
 * Two behaviors under test:
 *   - nodeRef accepts an ID or a fully-qualified node URN (cor:api:140,
 *     routed through resolveNodeRef) — was a raw `nodeId` PK.
 *   - a memory-read gate (previously ABSENT — any authenticated caller could
 *     read any tenant's node revision history). A node whose memory the caller
 *     can't read returns [], and an unknown ref returns [] too (no existence
 *     disclosure), mirroring memoryUsageSummary. Per-SNAPSHOT gating closes the
 *     moved-node leak (Codex P1): a node moved across memories keeps its id, so
 *     its history can hold snapshots captured in a memory the caller can't read.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

let org: { id: string; urn: string };
let memory: { id: string; urn: string };
let node: { id: string; loc: string };
let userMember: { id: string };
let userOutsider: { id: string };

// Mechanics tests run as a global ADMIN (sees every fixture memory).
function adminCtx(): Context {
  return { db, roles: ['ADMIN'], userId: 'admin-user' } as Context;
}

beforeEach(async () => {
  await cleanDb(db);
  await db.user.create({ data: { id: 'admin-user', roles: ['ADMIN'] } });

  org = await db.organization.create({
    data: { id: generateId(), name: 'nv-org', urn: 'nv-org' },
  });
  memory = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:mem`, name: 'mem', class: 'knowledge' },
  });
  node = await db.node.create({
    data: { id: generateId(), memoryId: memory.id, loc: 'guide', name: 'Guide' },
  });
  // Three snapshots for this node, all captured while it lived in `memory`.
  await db.nodeRevision.createMany({
    data: [
      { id: generateId(), nodeId: node.id, memoryId: memory.id, loc: 'guide', name: 'v1' },
      { id: generateId(), nodeId: node.id, memoryId: memory.id, loc: 'guide', name: 'v2' },
      { id: generateId(), nodeId: node.id, memoryId: memory.id, loc: 'guide', name: 'v3' },
    ],
  });

  userMember = await db.user.create({ data: { githubId: 7101, githubUsername: 'nv-mem', roles: ['READER'] } });
  userOutsider = await db.user.create({ data: { githubId: 7102, githubUsername: 'nv-out', roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: userMember.id, role: 'READER' } });
});

describe('nodeRevisions', () => {
  it('returns a node\'s revision history (input by ID)', async () => {
    const result = await resolvers.Query.nodeRevisions(null, { nodeRef: node.id }, adminCtx());
    expect(result).toHaveLength(3);
  });

  // cor:api:140 / 007-entity-id-or-urn: nodeRef accepts a bare full node URN.
  it('accepts a bare node URN as nodeRef', async () => {
    const result = await resolvers.Query.nodeRevisions(
      null, { nodeRef: `${memory.urn}:${node.loc}` }, adminCtx(),
    );
    expect(result).toHaveLength(3);
  });

  it('accepts a prefixed canonical node URN as nodeRef', async () => {
    const result = await resolvers.Query.nodeRevisions(
      null, { nodeRef: `urn:node:${org.urn}::mem::${node.loc}` }, adminCtx(),
    );
    expect(result).toHaveLength(3);
  });

  it('honors the limit', async () => {
    const result = await resolvers.Query.nodeRevisions(null, { nodeRef: node.id, limit: 2 }, adminCtx());
    expect(result).toHaveLength(2);
  });

  it('returns [] for an unknown nodeRef (no existence disclosure)', async () => {
    const result = await resolvers.Query.nodeRevisions(
      null, { nodeRef: 'cnonexistentnonexistent12' }, adminCtx(),
    );
    expect(result).toEqual([]);
  });

  it('includes a legacy NULL-memoryId snapshot (falls back to the current memory)', async () => {
    await db.nodeRevision.create({
      data: { id: generateId(), nodeId: node.id, memoryId: null, loc: 'guide', name: 'legacy' },
    });
    const result = await resolvers.Query.nodeRevisions(
      null, { nodeRef: node.id }, { db, userId: userMember.id, roles: ['READER'] } as Context,
    );
    // 3 stamped-in-`memory` + the legacy NULL row = 4 (member can read `memory`).
    expect(result).toHaveLength(4);
  });
});

describe('nodeRevisions access control (#602)', () => {
  it('an org member can read their node\'s revision history', async () => {
    const result = await resolvers.Query.nodeRevisions(
      null, { nodeRef: node.id }, { db, userId: userMember.id, roles: ['READER'] } as Context,
    );
    expect(result).toHaveLength(3);
  });

  it('a non-member is denied with [] even though the node exists (no existence leak)', async () => {
    const result = await resolvers.Query.nodeRevisions(
      null, { nodeRef: node.id }, { db, userId: userOutsider.id, roles: ['READER'] } as Context,
    );
    expect(result).toEqual([]);
  });

  it('a caller with no role is rejected by the READER gate', async () => {
    await expect(
      resolvers.Query.nodeRevisions(null, { nodeRef: node.id }, { db, roles: [] } as Context),
    ).rejects.toThrow('Forbidden');
  });

  // Codex P1: a node moved from a restricted memory into a readable one keeps
  // its stable id, so its pre-move snapshots would leak without per-snapshot
  // gating. The reader can read the node's CURRENT memory but not the memory a
  // historical snapshot was captured in.
  it('drops snapshots captured in a memory the caller cannot read (moved-node leak)', async () => {
    const otherOrg = await db.organization.create({
      data: { id: generateId(), name: 'nv-other', urn: 'nv-other' },
    });
    const restrictedMem = await db.memory.create({
      data: { id: generateId(), organizationId: otherOrg.id, urn: 'nv-other:secret', name: 'secret', class: 'knowledge' },
    });
    // A snapshot for `node` (current memory = `memory`) captured while it lived
    // in the restricted memory of another org.
    await db.nodeRevision.create({
      data: { id: generateId(), nodeId: node.id, memoryId: restrictedMem.id, loc: 'guide', name: 'secret-era' },
    });

    // userMember can read `memory` but is NOT a member of otherOrg.
    const result = await resolvers.Query.nodeRevisions(
      null, { nodeRef: node.id }, { db, userId: userMember.id, roles: ['READER'] } as Context,
    );
    // Only the 3 snapshots from the readable `memory` — the restricted one is dropped.
    expect(result).toHaveLength(3);
    expect(result.every((v) => v.memoryId !== restrictedMem.id)).toBe(true);
  });

  it('moveNode stamps the SOURCE memory on the pre-move snapshot', async () => {
    const dest = await db.memory.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:dest`, name: 'dest', class: 'knowledge' },
    });
    const mover = await db.node.create({
      data: { id: generateId(), memoryId: memory.id, loc: 'movable', name: 'Movable' },
    });
    await resolvers.Mutation.moveNode(
      null, { sourceRef: mover.id, targetMemoryRef: dest.id }, adminCtx(),
    );
    // Live node now lives in dest; the pre-move snapshot records the SOURCE memory.
    const moved = await db.node.findUniqueOrThrow({ where: { id: mover.id } });
    expect(moved.memoryId).toBe(dest.id);
    const snap = await db.nodeRevision.findFirstOrThrow({ where: { nodeId: mover.id } });
    expect(snap.memoryId).toBe(memory.id);
  });
});
