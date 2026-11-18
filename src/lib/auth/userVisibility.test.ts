/**
 * Unit tests for the field-level user-visibility matrix (#384).
 *
 * Pure over an injected fake `db` (only `orgMember.findMany` / `findFirst`
 * are touched), so the three relationship tiers — stranger, co-member,
 * admin/owner co-member — plus the self and platform-admin cases are
 * exercised deterministically without a database.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  canSeeUserPersonalFields,
  canSeeOrgMemberRole,
  type UserVisibilityCtx,
} from './userVisibility.js';
import type { PrismaClient } from '../../generated/prisma/index.js';

type Membership = { userId: string; organizationId: string; role: string };

/** A fake PrismaClient honoring just the two orgMember queries the helper runs. */
function fakeDb(memberships: Membership[]) {
  // Two shapes: the viewer's own orgs (userId = id), and (#2223) the bulk co-membership read
  // (userId IN targets, organizationId IN viewer orgs).
  const findMany = vi.fn(
    async ({ where }: { where: { userId: string | { in: string[] }; organizationId?: { in: string[] } } }) => {
      if (typeof where.userId === 'string') {
        const id = where.userId;
        return memberships.filter((m) => m.userId === id).map((m) => ({ organizationId: m.organizationId }));
      }
      const { userId: ids, organizationId: orgs } = where as { userId: { in: string[] }; organizationId: { in: string[] } };
      return memberships.filter((m) => ids.in.includes(m.userId) && orgs.in.includes(m.organizationId)).map((m) => ({ userId: m.userId }));
    },
  );
  const findFirst = vi.fn(
    async ({
      where,
    }: {
      where: { userId: string; organizationId: string | { in: string[] } };
    }) => {
      const { userId, organizationId } = where;
      if (organizationId && typeof organizationId === 'object' && 'in' in organizationId) {
        const hit = memberships.find((m) => m.userId === userId && organizationId.in.includes(m.organizationId));
        return hit ? { userId: hit.userId } : null;
      }
      const hit = memberships.find((m) => m.userId === userId && m.organizationId === organizationId);
      return hit ? { role: hit.role } : null;
    },
  );
  const db = { orgMember: { findMany, findFirst } } as unknown as PrismaClient;
  return { db, findMany, findFirst };
}

function ctx(db: PrismaClient, over: Partial<UserVisibilityCtx> = {}): UserVisibilityCtx {
  return { db, ...over };
}

describe('canSeeUserPersonalFields (name / email)', () => {
  it('always shows a user their own fields, even with no memberships', async () => {
    const { db } = fakeDb([]);
    expect(await canSeeUserPersonalFields(ctx(db, { userId: 'me' }), 'me')).toBe(true);
  });

  it('shows a co-member (shares an org) the target fields', async () => {
    const { db } = fakeDb([
      { userId: 'viewer', organizationId: 'orgX', role: 'CONTRIBUTOR' },
      { userId: 'target', organizationId: 'orgX', role: 'READER' },
    ]);
    expect(await canSeeUserPersonalFields(ctx(db, { userId: 'viewer' }), 'target')).toBe(true);
  });

  it('withholds fields from a stranger (no shared org)', async () => {
    const { db } = fakeDb([
      { userId: 'viewer', organizationId: 'orgX', role: 'OWNER' },
      { userId: 'target', organizationId: 'orgY', role: 'OWNER' },
    ]);
    expect(await canSeeUserPersonalFields(ctx(db, { userId: 'viewer' }), 'target')).toBe(false);
  });

  it('shows a platform ADMIN/OWNER everyone', async () => {
    const { db } = fakeDb([{ userId: 'target', organizationId: 'orgY', role: 'OWNER' }]);
    expect(await canSeeUserPersonalFields(ctx(db, { userId: 'admin', roles: ['ADMIN'] }), 'target')).toBe(true);
    expect(await canSeeUserPersonalFields(ctx(db, { userId: 'owner', roles: ['OWNER'] }), 'target')).toBe(true);
  });

  it('withholds fields from an unauthenticated / App-Key caller', async () => {
    const { db } = fakeDb([{ userId: 'target', organizationId: 'orgX', role: 'OWNER' }]);
    expect(await canSeeUserPersonalFields(ctx(db), 'target')).toBe(false);
  });

  it('returns false for a missing target id', async () => {
    const { db } = fakeDb([]);
    expect(await canSeeUserPersonalFields(ctx(db, { userId: 'me' }), null)).toBe(false);
    expect(await canSeeUserPersonalFields(ctx(db, { userId: 'me' }), undefined)).toBe(false);
  });

  it('memoizes membership lookups per ctx across repeated checks', async () => {
    const { db, findMany, findFirst } = fakeDb([
      { userId: 'viewer', organizationId: 'orgX', role: 'CONTRIBUTOR' },
      { userId: 'target', organizationId: 'orgX', role: 'READER' },
    ]);
    const c = ctx(db, { userId: 'viewer' });
    // name + email resolvers both ask about the same target — should collapse.
    await canSeeUserPersonalFields(c, 'target');
    await canSeeUserPersonalFields(c, 'target');
    expect(findMany).toHaveBeenCalledTimes(2); // viewer's orgs once + the target's membership once (#2223: bulk read)
    expect(findFirst).not.toHaveBeenCalled();
  });
});

describe('canSeeOrgMemberRole', () => {
  const member = { userId: 'target', organizationId: 'orgX' };

  it('shows a member their own role', async () => {
    const { db } = fakeDb([{ userId: 'target', organizationId: 'orgX', role: 'READER' }]);
    expect(await canSeeOrgMemberRole(ctx(db, { userId: 'target' }), member)).toBe(true);
  });

  it('shows the role to a co-member who is ADMIN/OWNER of that org', async () => {
    const adminDb = fakeDb([
      { userId: 'viewer', organizationId: 'orgX', role: 'ADMIN' },
      { userId: 'target', organizationId: 'orgX', role: 'READER' },
    ]);
    expect(await canSeeOrgMemberRole(ctx(adminDb.db, { userId: 'viewer' }), member)).toBe(true);

    const ownerDb = fakeDb([
      { userId: 'viewer', organizationId: 'orgX', role: 'OWNER' },
      { userId: 'target', organizationId: 'orgX', role: 'READER' },
    ]);
    expect(await canSeeOrgMemberRole(ctx(ownerDb.db, { userId: 'viewer' }), member)).toBe(true);
  });

  it('withholds the role from a co-member who is only READER/CONTRIBUTOR', async () => {
    const { db } = fakeDb([
      { userId: 'viewer', organizationId: 'orgX', role: 'CONTRIBUTOR' },
      { userId: 'target', organizationId: 'orgX', role: 'READER' },
    ]);
    expect(await canSeeOrgMemberRole(ctx(db, { userId: 'viewer' }), member)).toBe(false);
  });

  it('shows the role to a platform ADMIN/OWNER', async () => {
    const { db } = fakeDb([{ userId: 'target', organizationId: 'orgX', role: 'READER' }]);
    expect(await canSeeOrgMemberRole(ctx(db, { userId: 'someone', roles: ['ADMIN'] }), member)).toBe(true);
  });

  it('withholds the role from an unauthenticated caller', async () => {
    const { db } = fakeDb([{ userId: 'target', organizationId: 'orgX', role: 'READER' }]);
    expect(await canSeeOrgMemberRole(ctx(db), member)).toBe(false);
  });
});
