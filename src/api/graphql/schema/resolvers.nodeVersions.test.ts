/**
 * Integration tests for the nodeVersions query (#602).
 *
 * Two behaviors under test:
 *   - nodeRef accepts an ID or a fully-qualified node URN (cor:api:140,
 *     routed through resolveNodeRef) — was a raw `nodeId` PK.
 *   - a memory-read gate (previously ABSENT — any authenticated caller could
 *     read any tenant's node version history). A node whose memory the caller
 *     can't read returns [], and an unknown ref returns [] too (no existence
 *     disclosure), mirroring memoryUsageSummary.
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

  org = await db.organization.create({
    data: { id: generateId(), name: 'nv-org', urn: 'nv-org' },
  });
  memory = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:mem`, name: 'mem', class: 'knowledge' },
  });
  node = await db.node.create({
    data: { id: generateId(), memoryId: memory.id, loc: 'guide', name: 'Guide' },
  });
  // Three snapshots for this node.
  await db.nodeVersion.createMany({
    data: [
      { id: generateId(), nodeId: node.id, loc: 'guide', name: 'v1' },
      { id: generateId(), nodeId: node.id, loc: 'guide', name: 'v2' },
      { id: generateId(), nodeId: node.id, loc: 'guide', name: 'v3' },
    ],
  });

  userMember = await db.user.create({ data: { githubId: 7101, githubUsername: 'nv-mem', roles: ['READER'] } });
  userOutsider = await db.user.create({ data: { githubId: 7102, githubUsername: 'nv-out', roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: userMember.id, role: 'READER' } });
});

describe('nodeVersions', () => {
  it('returns a node\'s version history (input by ID)', async () => {
    const result = await resolvers.Query.nodeVersions(null, { nodeRef: node.id }, adminCtx());
    expect(result).toHaveLength(3);
  });

  // cor:api:140 / 007-entity-id-or-urn: nodeRef accepts a bare full node URN.
  it('accepts a bare node URN as nodeRef', async () => {
    const result = await resolvers.Query.nodeVersions(
      null, { nodeRef: `${memory.urn}:${node.loc}` }, adminCtx(),
    );
    expect(result).toHaveLength(3);
  });

  it('accepts a prefixed canonical node URN as nodeRef', async () => {
    const result = await resolvers.Query.nodeVersions(
      null, { nodeRef: `urn:node:${org.urn}::mem::${node.loc}` }, adminCtx(),
    );
    expect(result).toHaveLength(3);
  });

  it('honors the limit', async () => {
    const result = await resolvers.Query.nodeVersions(null, { nodeRef: node.id, limit: 2 }, adminCtx());
    expect(result).toHaveLength(2);
  });

  it('returns [] for an unknown nodeRef (no existence disclosure)', async () => {
    const result = await resolvers.Query.nodeVersions(
      null, { nodeRef: 'cnonexistentnonexistent12' }, adminCtx(),
    );
    expect(result).toEqual([]);
  });
});

describe('nodeVersions access control (#602)', () => {
  it('an org member can read their node\'s version history', async () => {
    const result = await resolvers.Query.nodeVersions(
      null, { nodeRef: node.id }, { db, userId: userMember.id, roles: ['READER'] } as Context,
    );
    expect(result).toHaveLength(3);
  });

  it('a non-member is denied with [] even though the node exists (no existence leak)', async () => {
    const result = await resolvers.Query.nodeVersions(
      null, { nodeRef: node.id }, { db, userId: userOutsider.id, roles: ['READER'] } as Context,
    );
    expect(result).toEqual([]);
  });

  it('a caller with no role is rejected by the READER gate', async () => {
    await expect(
      resolvers.Query.nodeVersions(null, { nodeRef: node.id }, { db, roles: [] } as Context),
    ).rejects.toThrow('Forbidden');
  });
});
