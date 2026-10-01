/**
 * #1370 — a soft-deleted org's former members no longer authorize anywhere.
 *
 * `softDeleteOrganizationCore` keeps every `OrgMember` row (the audit record),
 * and every shared membership read checked only the MEMBERSHIP's `deletedAt`.
 * So a deleted org's former ADMIN kept their former role at every gate,
 * indefinitely. The shared predicate `LIVE_ORG_MEMBERSHIP` adds the org's own
 * liveness to every authorizing and enumerating read; gates and lists move
 * together (the #362 drift rule).
 *
 * Controls: the same user stays fully authorized in a SECOND, live org (the
 * fix is per org, not per user), and the membership rows are untouched.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { requireOrgRole, isOrgMemberOrAdmin } from '../../api/graphql/schema/resolvers.helpers.js';
import { softDeleteOrganizationCore } from '../../controller/operations/softDeleteOrganization.js';
import { getMemberOrgIds } from '../../lib/auth/memberOrgIds.js';
import { getOrgReadableMemoryIds } from '../../lib/auth/orgReadableMemory.js';
import { requireOrgAction } from '../../lib/auth/orgAction.js';
import { canReadMemory } from '../../mcp/access-control.js';
import { generateId } from '../../lib/id.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let dead: { id: string };
let live: { id: string };
let admin: { id: string };
let deadMem: { id: string };
let liveMem: { id: string };

const ctx = (): Context => ({ db, roles: [], userId: admin.id } as unknown as Context);

beforeEach(async () => {
  await cleanDb(db);
  admin = await db.user.create({ data: { githubId: 137001, githubUsername: 'ex-admin-1370', roles: [] } });
  dead = await db.organization.create({ data: { id: generateId(), name: 'dead-org', urn: 'dead-org-1370' } });
  live = await db.organization.create({ data: { id: generateId(), name: 'live-org', urn: 'live-org-1370' } });
  for (const org of [dead, live]) {
    await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  }
  deadMem = await db.memory.create({ data: {
    id: generateId(), organizationId: dead.id, urn: 'dead-org-1370:km', name: 'km', class: 'knowledge', visibility: 'ORGANIZATION',
  } });
  liveMem = await db.memory.create({ data: {
    id: generateId(), organizationId: live.id, urn: 'live-org-1370:km', name: 'km', class: 'knowledge', visibility: 'ORGANIZATION',
  } });
});

describe('#1370 — org liveness at the shared membership gates', () => {
  it('CONTROL: before deletion, the admin passes every gate in both orgs', async () => {
    for (const org of [dead, live]) {
      await expect(requireOrgRole(ctx(), org.id, 'ADMIN')).resolves.toBeUndefined();
      expect(await isOrgMemberOrAdmin(ctx(), org.id)).toBe(true);
    }
    expect((await getMemberOrgIds(db, admin.id)).sort()).toEqual([dead.id, live.id].sort());
    expect(await getOrgReadableMemoryIds(db, admin.id)).toEqual(expect.arrayContaining([deadMem.id, liveMem.id]));
  });

  it('after a soft delete, the former ADMIN is refused by the gates and dropped from enumeration', async () => {
    await softDeleteOrganizationCore(db, dead.id);
    // The audit record is untouched: the membership row is still live.
    expect(await db.orgMember.findFirst({ where: { organizationId: dead.id, userId: admin.id, deletedAt: null } })).not.toBeNull();

    await expect(requireOrgRole(ctx(), dead.id, 'ADMIN')).rejects.toThrow('Forbidden');
    await expect(requireOrgRole(ctx(), dead.id, 'READER')).rejects.toThrow('Forbidden');
    await expect(requireOrgAction(ctx(), dead.id, 'memory.create')).rejects.toThrow('Forbidden');
    expect(await isOrgMemberOrAdmin(ctx(), dead.id)).toBe(false);
    expect(await getMemberOrgIds(db, admin.id)).not.toContain(dead.id);
    expect(await getOrgReadableMemoryIds(db, admin.id)).not.toContain(deadMem.id);
    expect(await canReadMemory(db, { userId: admin.id, roles: [] }, deadMem.id)).toBe(false);
  });

  it('after a soft delete, the resolver door is closed: updateMemory on the dead org memory is refused', async () => {
    await softDeleteOrganizationCore(db, dead.id);
    await expect(
      resolvers.Mutation.updateMemory({}, { id: deadMem.id, name: 'renamed-after-death' } as never, ctx()),
    ).rejects.toThrow();
    expect((await db.memory.findUniqueOrThrow({ where: { id: deadMem.id } })).name).toBe('km');
  });

  it('CONTROL: the same user keeps full access in a second, LIVE org (per org, not per user)', async () => {
    await softDeleteOrganizationCore(db, dead.id);
    await expect(requireOrgRole(ctx(), live.id, 'ADMIN')).resolves.toBeUndefined();
    await expect(requireOrgAction(ctx(), live.id, 'memory.create')).resolves.toBeUndefined();
    expect(await isOrgMemberOrAdmin(ctx(), live.id)).toBe(true);
    expect(await getMemberOrgIds(db, admin.id)).toEqual([live.id]);
    expect(await getOrgReadableMemoryIds(db, admin.id)).toContain(liveMem.id);
    expect(await canReadMemory(db, { userId: admin.id, roles: [] }, liveMem.id)).toBe(true);
    const updated = await resolvers.Mutation.updateMemory({}, { id: liveMem.id, name: 'still-mine' } as never, ctx());
    expect(updated.name).toBe('still-mine');
  });
});
