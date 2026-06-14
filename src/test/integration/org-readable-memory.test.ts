/**
 * getOrgReadableMemoryIds — the shared org/public/subscription read-set used
 * by both the portal gate (getAccessibleMemoryIds) and the MCP gate
 * (getMemoryAccess). Pins the two security-sensitive behaviors hardened in
 * PR #270 review:
 *   - a falsy userId fails closed (returns []) rather than Prisma silently
 *     dropping the filter and matching every org's memberships;
 *   - a REVOKED (soft-deleted) cross-org subscription stops granting read.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../helpers.js';
import { generateId } from '../../lib/id.js';
import { getOrgReadableMemoryIds } from '../../lib/auth/orgReadableMemory.js';

describe('getOrgReadableMemoryIds', () => {
  beforeEach(async () => {
    await cleanDb(db);
  });

  it('fails closed on a falsy userId (no Prisma match-all bypass)', async () => {
    await createDbOrgAndGraph(db, { orgName: 'acme.com', graphName: 'kb' });
    expect(await getOrgReadableMemoryIds(db, '')).toEqual([]);
    // @ts-expect-error — exercising the undefined footgun the guard defends.
    expect(await getOrgReadableMemoryIds(db, undefined)).toEqual([]);
  });

  it('grants org members read on their org knowledge memory', async () => {
    const { org, graph } = await createDbOrgAndGraph(db, { orgName: 'acme.com', graphName: 'kb' });
    const user = await db.user.create({ data: { id: generateId(), handle: 'u1' } });
    await db.orgMember.create({
      data: { id: generateId(), organizationId: org.id, userId: user.id, role: 'READER' },
    });
    expect(await getOrgReadableMemoryIds(db, user.id)).toContain(graph.id);
  });

  it('a soft-deleted cross-org subscription no longer grants read', async () => {
    // Memory owned by org A; user is a member of org B which subscribes to it.
    const { graph: memA } = await createDbOrgAndGraph(db, { orgName: 'a.com', graphName: 'shared' });
    const { org: orgB } = await createDbOrgAndGraph(db, { orgName: 'b.com', graphName: 'b-kb' });
    const user = await db.user.create({ data: { id: generateId(), handle: 'sub-user' } });
    await db.orgMember.create({
      data: { id: generateId(), organizationId: orgB.id, userId: user.id, role: 'READER' },
    });

    // Active subscription → read granted.
    const sub = await db.memorySubscription.create({
      data: { memoryId: memA.id, organizationId: orgB.id, role: 'READER' },
    });
    expect(await getOrgReadableMemoryIds(db, user.id)).toContain(memA.id);

    // Revoke (soft-delete) → read withdrawn.
    await db.memorySubscription.update({
      where: { memoryId_organizationId: { memoryId: memA.id, organizationId: orgB.id } },
      data: { deletedAt: new Date() },
    });
    expect(await getOrgReadableMemoryIds(db, user.id)).not.toContain(memA.id);
    void sub;
  });
});
