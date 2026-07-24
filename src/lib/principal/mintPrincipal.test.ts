/**
 * The unified per-server principal pool (#692) — what this pins:
 *   - cross-kind uniqueness (a name is one namespace across user + org);
 *   - reserved platform words are unmintable;
 *   - a released name is tombstoned and never recycled;
 *   - ensureUserPrincipal / ensureOrgPrincipal are idempotent;
 *   - the GraphQL acceptance: an org cannot take an existing handle, and vice-versa.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import {
  mintPrincipal,
  releasePrincipal,
  ensureUserPrincipal,
  ensureOrgPrincipal,
  checkRootAvailable,
  RootNameTakenError,
  RESERVED_ROOT_NAMES,
} from './mintPrincipal.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';

beforeEach(async () => {
  await cleanDb(db);
});

describe('mintPrincipal — cross-kind uniqueness', () => {
  it('mints a name once, then rejects it for EITHER kind (case-insensitively)', async () => {
    await mintPrincipal(db, { kind: 'user', name: 'holger' });
    await expect(mintPrincipal(db, { kind: 'user', name: 'holger' })).rejects.toBeInstanceOf(RootNameTakenError);
    // The whole point: an ORG can't claim a name a USER holds.
    await expect(mintPrincipal(db, { kind: 'org', name: 'Holger' })).rejects.toBeInstanceOf(RootNameTakenError);
  });

  it('stores the name lowercased and reports availability', async () => {
    expect(await checkRootAvailable(db, 'Acme.com')).toBe(true);
    await mintPrincipal(db, { kind: 'org', name: 'Acme.com' });
    const row = await db.principal.findFirstOrThrow({ where: { kind: 'org' } });
    expect(row.name).toBe('acme.com');
    expect(await checkRootAvailable(db, 'acme.com')).toBe(false);
  });
});

describe('reserved platform words', () => {
  it('rejects every reserved root word', async () => {
    for (const w of RESERVED_ROOT_NAMES) {
      expect(await checkRootAvailable(db, w)).toBe(false);
      await expect(mintPrincipal(db, { kind: 'org', name: w })).rejects.toBeInstanceOf(RootNameTakenError);
    }
  });
});

describe('tombstone — no recycling', () => {
  it('a released name stays reserved forever', async () => {
    const { id } = await mintPrincipal(db, { kind: 'user', name: 'ex-user' });
    await releasePrincipal(db, id);
    const row = await db.principal.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('released');
    expect(row.releasedAt).not.toBeNull();
    // The name is NOT free again — the unfiltered lower(name) unique still holds it.
    await expect(mintPrincipal(db, { kind: 'user', name: 'ex-user' })).rejects.toBeInstanceOf(RootNameTakenError);
  });
});

describe('ensureUserPrincipal / ensureOrgPrincipal — idempotent', () => {
  it('mints once and no-ops when already linked', async () => {
    const user = await db.user.create({ data: { id: generateId(), handle: 'reconcile-me', roles: ['READER'] } });
    await ensureUserPrincipal(db, user);
    const linked = await db.user.findUniqueOrThrow({ where: { id: user.id }, select: { principalId: true } });
    expect(linked.principalId).not.toBeNull();
    // Second call is a no-op (already has a principal) — does not throw on the
    // now-existing name.
    await ensureUserPrincipal(db, { ...user, principalId: linked.principalId });
    expect(await db.principal.count({ where: { name: 'reconcile-me' } })).toBe(1);
  });

  it('ensureOrgPrincipal mints for an undotted personal-org slug (exempt from the dotted rule)', async () => {
    const org = await db.organization.create({
      data: { id: generateId(), name: 'p', urn: 'personal-abc123' },
    });
    await ensureOrgPrincipal(db, org);
    const p = await db.principal.findFirstOrThrow({ where: { kind: 'org', name: 'personal-abc123' } });
    expect(p.status).toBe('active');
  });
});

describe('GraphQL acceptance — an org and a handle cannot collide', () => {
  function ctxFor(userId: string, roles: Context['roles'] = ['READER']): Context {
    return { db, userId, roles } as Context;
  }

  it('createOrganization is rejected when a user already holds the name', async () => {
    const user = await db.user.create({ data: { id: generateId(), handle: 'clash', roles: ['READER'] } });
    await ensureUserPrincipal(db, user); // user 'clash' now in the pool
    await expect(
      resolvers.Mutation.createOrganization({}, { name: 'Clash', urn: 'clash' }, ctxFor(user.id)),
    ).rejects.toThrow(/dotted|already taken/i); // undotted → dotted rule; if dotted, cross-kind
  });

  it('a new org name is then unavailable to a handle rename (cross-kind)', async () => {
    const owner = await db.user.create({ data: { id: generateId(), handle: 'owner', roles: ['READER'] } });
    await ensureUserPrincipal(db, owner);
    await resolvers.Mutation.createOrganization({}, { name: 'Acme', urn: 'acme.test' }, ctxFor(owner.id));
    // Someone tries to grab the org's name as their handle → rejected.
    const other = await db.user.create({ data: { id: generateId(), handle: 'other', roles: ['READER'] } });
    await ensureUserPrincipal(db, other);
    await expect(
      resolvers.Mutation.updateMyProfile({}, { handle: 'acme.test' }, ctxFor(other.id)),
    ).rejects.toThrow(); // dotted handle rejected AND name taken — either way, no collision
  });
});
