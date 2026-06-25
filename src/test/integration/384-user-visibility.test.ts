/**
 * Integration test for field-level user-visibility (#384), exercising the
 * actual GraphQL resolvers against the test DB.
 *
 * Fixture: two orgs.
 *   orgX — alice (OWNER), bob (CONTRIBUTOR)
 *   orgY — carol (OWNER)            ← shares no org with alice/bob
 *
 * Every user has a name + email + handle. The matrix is checked from each
 * viewer's perspective via the real `User.name` / `User.email` field
 * resolvers, the `OrgMember.role` resolver, and `Query.searchUsers`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { generateId } from '../../lib/id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';

const User = resolvers.User as {
  name: (u: unknown, a: unknown, c: Context) => Promise<string | null>;
  email: (u: unknown, a: unknown, c: Context) => Promise<string | null>;
};
const OrgMember = resolvers.OrgMember as {
  role: (m: unknown, a: unknown, c: Context) => Promise<string | null>;
};
const searchUsers = (resolvers.Query as Record<string, (p: unknown, a: unknown, c: Context) => Promise<unknown>>)
  .searchUsers;

function ctx(userId?: string, roles: Context['roles'] = []): Context {
  return { db, userId, roles };
}

interface Fx {
  alice: { id: string; name: string | null; email: string | null };
  bob: { id: string; name: string | null; email: string | null };
  carol: { id: string; name: string | null; email: string | null };
  orgX: string;
  aliceMember: { userId: string; organizationId: string; role: string };
  bobMember: { userId: string; organizationId: string; role: string };
}

async function build(): Promise<Fx> {
  const orgX = await db.organization.create({ data: { id: generateId(), name: 'OrgX', urn: 'org-x' } });
  const orgY = await db.organization.create({ data: { id: generateId(), name: 'OrgY', urn: 'org-y' } });

  const mk = (handle: string, n: number) =>
    db.user.create({
      data: {
        id: generateId(),
        handle,
        name: `${handle} Real Name`,
        email: `${handle}@example.com`,
        githubId: 80000 + n,
        githubUsername: handle,
      },
    });
  const alice = await mk('alice', 1);
  const bob = await mk('bob', 2);
  const carol = await mk('carol', 3);

  const aliceMember = await db.orgMember.create({
    data: { id: generateId(), organizationId: orgX.id, userId: alice.id, role: 'OWNER' },
  });
  const bobMember = await db.orgMember.create({
    data: { id: generateId(), organizationId: orgX.id, userId: bob.id, role: 'CONTRIBUTOR' },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: orgY.id, userId: carol.id, role: 'OWNER' },
  });

  return { alice, bob, carol, orgX: orgX.id, aliceMember, bobMember };
}

describe('#384 field-level user visibility', () => {
  let fx: Fx;
  beforeEach(async () => {
    await cleanDb(db);
    fx = await build();
  });

  describe('name / email', () => {
    it('self sees own fields', async () => {
      const c = ctx(fx.alice.id);
      expect(await User.name(fx.alice, {}, c)).toBe('alice Real Name');
      expect(await User.email(fx.alice, {}, c)).toBe('alice@example.com');
    });

    it('co-member sees the target fields', async () => {
      const c = ctx(fx.bob.id); // bob shares orgX with alice
      expect(await User.name(fx.alice, {}, c)).toBe('alice Real Name');
      expect(await User.email(fx.alice, {}, c)).toBe('alice@example.com');
    });

    it('stranger sees null name/email', async () => {
      const c = ctx(fx.carol.id); // carol shares no org with alice
      expect(await User.name(fx.alice, {}, c)).toBeNull();
      expect(await User.email(fx.alice, {}, c)).toBeNull();
    });

    it('unauthenticated caller sees null name/email', async () => {
      const c = ctx(undefined);
      expect(await User.name(fx.alice, {}, c)).toBeNull();
      expect(await User.email(fx.alice, {}, c)).toBeNull();
    });

    it('platform admin sees everyone', async () => {
      const c = ctx(generateId(), ['ADMIN']); // not even a co-member
      expect(await User.name(fx.alice, {}, c)).toBe('alice Real Name');
      expect(await User.email(fx.alice, {}, c)).toBe('alice@example.com');
    });
  });

  describe('OrgMember.role', () => {
    it('member sees their own role', async () => {
      expect(await OrgMember.role(fx.bobMember, {}, ctx(fx.bob.id))).toBe('CONTRIBUTOR');
    });

    it('ADMIN/OWNER co-member sees a member role', async () => {
      // alice is OWNER of orgX, viewing bob's membership
      expect(await OrgMember.role(fx.bobMember, {}, ctx(fx.alice.id))).toBe('CONTRIBUTOR');
    });

    it('non-admin co-member does not see another member role', async () => {
      // bob is only CONTRIBUTOR of orgX, viewing alice's membership
      expect(await OrgMember.role(fx.aliceMember, {}, ctx(fx.bob.id))).toBeNull();
    });

    it('stranger does not see the role', async () => {
      expect(await OrgMember.role(fx.aliceMember, {}, ctx(fx.carol.id))).toBeNull();
    });

    it('platform admin sees the role', async () => {
      expect(await OrgMember.role(fx.aliceMember, {}, ctx(generateId(), ['ADMIN']))).toBe('OWNER');
    });
  });

  describe('searchUsers projects only permitted fields', () => {
    it('a stranger gets id/handle but null name/email after field resolution', async () => {
      const c = ctx(fx.carol.id);
      const rows = (await searchUsers(null, { query: 'alice' }, c)) as Array<{ id: string; handle: string }>;
      const row = rows.find((r) => r.id === fx.alice.id);
      expect(row).toBeTruthy();
      expect(row!.handle).toBe('alice'); // always visible
      // The row carries raw columns; the User field resolvers null PII for a stranger.
      expect(await User.name(row!, {}, c)).toBeNull();
      expect(await User.email(row!, {}, c)).toBeNull();
    });

    it('a co-member gets full fields', async () => {
      const c = ctx(fx.bob.id);
      const rows = (await searchUsers(null, { query: 'alice' }, c)) as Array<{ id: string }>;
      const row = rows.find((r) => r.id === fx.alice.id)!;
      expect(await User.name(row, {}, c)).toBe('alice Real Name');
      expect(await User.email(row, {}, c)).toBe('alice@example.com');
    });
  });

  describe('searchUsers does not leak strangers via name/email matching (#384 oracle)', () => {
    // A user whose name/email do NOT overlap their public identifiers, so we can
    // distinguish a name/email match from a handle/githubUsername match.
    let zachId: string;
    beforeEach(async () => {
      const zach = await db.user.create({
        data: {
          id: generateId(),
          handle: 'znine',
          name: 'Zachary Quentin',
          email: 'zq-private@example.com',
          githubId: 90909,
          githubUsername: 'zq-gh',
        },
      });
      zachId = zach.id;
    });

    it('stranger cannot find a user by partial NAME', async () => {
      const rows = (await searchUsers(null, { query: 'Zachary' }, ctx(fx.carol.id))) as Array<{ id: string }>;
      expect(rows.find((r) => r.id === zachId)).toBeUndefined();
    });

    it('stranger cannot find a user by PARTIAL email', async () => {
      const rows = (await searchUsers(null, { query: 'zq-private' }, ctx(fx.carol.id))) as Array<{ id: string }>;
      expect(rows.find((r) => r.id === zachId)).toBeUndefined();
    });

    it('stranger CAN find a user by exact email (to add a known person)', async () => {
      const rows = (await searchUsers(
        null,
        { query: 'ZQ-Private@Example.com' },
        ctx(fx.carol.id),
      )) as Array<{ id: string }>;
      expect(rows.find((r) => r.id === zachId)).toBeTruthy();
    });

    it('stranger CAN find a user by handle / githubUsername', async () => {
      const byHandle = (await searchUsers(null, { query: 'znine' }, ctx(fx.carol.id))) as Array<{ id: string }>;
      expect(byHandle.find((r) => r.id === zachId)).toBeTruthy();
      const byGh = (await searchUsers(null, { query: 'zq-gh' }, ctx(fx.carol.id))) as Array<{ id: string }>;
      expect(byGh.find((r) => r.id === zachId)).toBeTruthy();
    });

    it('a platform admin can still find by partial name', async () => {
      const rows = (await searchUsers(null, { query: 'Zachary' }, ctx(generateId(), ['ADMIN']))) as Array<{
        id: string;
      }>;
      expect(rows.find((r) => r.id === zachId)).toBeTruthy();
    });
  });
});
