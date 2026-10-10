/**
 * #1733 — an unverified org may take an undotted root (Holger's option (c),
 * team chat #7865), so a user with no domain can create an organization.
 * Org roots and user handles still share one case-insensitive principal pool
 * (#692), so the two never collide; the root resolves to its principal by
 * lookup, never by whether it has a dot.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { ensureUserPrincipal } from '../../../lib/principal/mintPrincipal.js';
import { resolveOrgRef } from '../../../lib/entityRef/orgRef.js';
import { resolvers, type Context } from './resolvers.js';

const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;

let user: { id: string; handle: string | null; principalId: string | null };
const ctx = (userId = user.id): Context => ({ db, userId, roles: ['READER'] }) as Context;
const create = (urn: string, userId = user.id) => M.createOrganization({}, { name: urn, urn }, ctx(userId));
const rename = async (orgId: string, urn: string) => {
  await db.orgMember.upsert({
    where: { organizationId_userId: { organizationId: orgId, userId: user.id } },
    create: { organizationId: orgId, userId: user.id, role: 'OWNER' },
    update: {},
  });
  return M.updateOrganization({}, { id: orgId, urn }, ctx());
};
const reasonOf = async (p: Promise<unknown>) => {
  try { await p; return 'NO_ERROR'; } catch (e) {
    if (e instanceof GraphQLError) return `${String(e.extensions.code)}: ${e.message}`;
    return (e as { reason?: string }).reason ?? (e as Error).message;
  }
};

beforeEach(async () => {
  await cleanDb(db);
  user = await db.user.create({ data: { id: generateId(), handle: 'founder', roles: ['READER'] } });
  await ensureUserPrincipal(db, user);
});

describe('#1733: an org may take an undotted root', () => {
  it('createOrganization accepts an undotted root, mints its org principal and makes the caller OWNER', async () => {
    const org = await create('minicoders');
    expect(org.urn).toBe('minicoders');
    const principal = await db.principal.findUniqueOrThrow({ where: { name: 'minicoders' } });
    expect(principal).toMatchObject({ kind: 'org', status: 'active' });
    expect(await db.orgMember.findFirst({ where: { organizationId: org.id, userId: user.id } }))
      .toMatchObject({ role: 'OWNER' });
  });

  it('a dotted root is still accepted (no domain verification exists yet)', async () => {
    await expect(create('acme.test')).resolves.toMatchObject({ urn: 'acme.test' });
  });

  it('an org can rename between undotted and dotted roots, through the normal rename', async () => {
    const org = await create('minicoders');
    await expect(rename(org.id, 'minicoders.org')).resolves.toMatchObject({ urn: 'minicoders.org' });
    await expect(rename(org.id, 'minicoders-den')).resolves.toMatchObject({ urn: 'minicoders-den' });
  });

  it('an undotted root resolves to its org by lookup: the org ref, and memories under it', async () => {
    const org = await create('minicoders');
    expect(await resolveOrgRef(db, 'hrn:org:minicoders')).toEqual({ id: org.id });
    const memory = await M.createMemory({}, { orgId: org.id, name: 'notes' }, ctx());
    expect(memory.urn.startsWith('minicoders:')).toBe(true);
    const found = await resolvers.Query.memory({}, { ref: `hrn:mem:${memory.urn}` }, ctx());
    expect(found?.id).toBe(memory.id);
  });
});

describe('#1733: the shared pool and the bare-root rules still hold', () => {
  it("an undotted org root can't take a user's handle, and a handle can't take an undotted org's root", async () => {
    expect(await reasonOf(create('founder'))).toMatch(/taken|ROOT_NAME_TAKEN/i);
    await create('minicoders');
    const other = await db.user.create({ data: { id: generateId(), handle: 'other', roles: ['READER'] } });
    await ensureUserPrincipal(db, other);
    await expect(M.updateMyProfile({}, { handle: 'minicoders' }, ctx(other.id))).rejects.toThrow();
    expect((await db.user.findUniqueOrThrow({ where: { id: other.id } })).handle).toBe('other');
  });

  it('two orgs cannot share an undotted root, in any case', async () => {
    await create('minicoders');
    const other = await db.user.create({ data: { id: generateId(), handle: 'other2', roles: ['READER'] } });
    expect(await reasonOf(create('minicoders', other.id))).toMatch(/taken|ROOT_NAME_TAKEN/i);
    expect(await reasonOf(create('MiniCoders', other.id))).not.toBe('NO_ERROR');
  });

  it.each([
    ['a scheme prefix', 'hrn:org:minicoders', 'org-urn-not-bare'],
    ['a colon', 'mini:coders', 'org-urn-not-bare'],
    ['upper case', 'MiniCoders', 'slug-not-lowercase'],
    ['a reserved word', 'hadron', null],
  ])('still refuses %s', async (_label, urn, reason) => {
    const got = await reasonOf(create(urn));
    expect(got).not.toBe('NO_ERROR');
    if (reason) expect(got).toBe(reason);
  });

  // A ref is an ID when it is ID-shaped (entityRef/shape.ts). A dotted root
  // never was; an undotted one can be, and would then be looked up as an ID.
  it.each([
    ['a UUIDv7-hex id', '0193a1b2c3d4e5f60718293a4b5c6d7e'],
    ['a cuid', 'cabcdefghijklmnopqrstuvwx'],
  ])('refuses an undotted root shaped like %s, on create and on rename', async (_label, urn) => {
    expect(await reasonOf(create(urn))).toMatch(/^ORG_ROOT_ID_SHAPED/);
    const org = await create('minicoders');
    expect(await reasonOf(rename(org.id, urn))).toMatch(/^ORG_ROOT_ID_SHAPED/);
    expect(await db.principal.findUnique({ where: { name: urn } })).toBeNull();
  });
});
