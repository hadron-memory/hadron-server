import { ApolloServer } from '@apollo/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

const F = resolvers as any;
const server = new ApolloServer<Context>({ typeDefs, resolvers });
beforeAll(() => server.start());
afterAll(() => server.stop());
const ctx = (userId?: string, extra: Partial<Context> = {}): Context => ({ db, userId, roles: ['READER'], ...extra });
let viewer: { id: string }; let target: { id: string }; let other: { id: string };
let shared: { id: string; name: string; urn: string }; let hidden: { id: string; name: string; urn: string };
const user = () => db.user.create({ data: { githubId: Math.floor(Math.random() * 1e9), githubUsername: `shared-${generateId()}` } });
const org = () => db.organization.create({ data: { name: 'Shared test', urn: `shared-${generateId()}.example` } });
const member = (userId: string, organizationId: string) => db.orgMember.create({ data: { userId, organizationId, role: 'READER' } });
const page = (c = ctx(viewer.id), args = {}, u = target) => F.User.sharedOrganizations(u, args, c);
beforeEach(async () => {
  await cleanDb(db);
  [viewer, target, other] = await Promise.all([user(), user(), user()]);
  [shared, hidden] = await Promise.all([org(), org()]);
  await Promise.all([member(viewer.id, shared.id), member(target.id, shared.id), member(target.id, hidden.id)]);
});

describe('#2179 shared organizations — red first', () => {
  it('returns only safe mutual organization scalars, and known-empty separately from null', async () => {
    expect(await page()).toEqual({ items: [{ id: shared.id, name: shared.name, urn: shared.urn }], total: 1 });
    expect(await page(ctx(other.id))).toEqual({ items: [], total: 0 });
    expect(await page(ctx())).toBeNull();
  });
  it('gives platform admins no membership shortcut and self only live memberships', async () => {
    expect(await page(ctx(other.id, { roles: ['ADMIN'] }))).toEqual({ items: [], total: 0 });
    expect(await page(ctx(target.id), {}, target)).toMatchObject({ total: 2 });
  });
  it('removes revoked memberships and deleted orgs or users on the next request', async () => {
    await db.orgMember.update({ where: { organizationId_userId: { userId: viewer.id, organizationId: shared.id } }, data: { deletedAt: new Date() } });
    expect(await page()).toEqual({ items: [], total: 0 });
    await db.orgMember.update({ where: { organizationId_userId: { userId: viewer.id, organizationId: shared.id } }, data: { deletedAt: null } });
    await db.organization.update({ where: { id: shared.id }, data: { deletedAt: new Date() } });
    expect(await page()).toEqual({ items: [], total: 0 });
    await db.user.update({ where: { id: target.id }, data: { deletedAt: new Date() } });
    expect(await page()).toBeNull();
  });
  it('refuses anonymous, key, run and refused-session viewers without membership probes', async () => {
    for (const c of [ctx(), ctx(undefined, { appKeyId: 'key', appId: 'app' }), ctx(viewer.id, { clientId: 'run:synthetic' }), ctx(viewer.id, { sessionBindingRefused: true })]) {
      let probes = 0;
      c.db = db.$extends({ query: { orgMember: { $allOperations: async ({ args, query }) => { probes++; return query(args); } } } }) as Context['db'];
      expect(await page(c)).toBeNull();
      expect(probes).toBe(0);
    }
    expect(await page(ctx(viewer.id, { appId: 'selected-app' }))).toMatchObject({ total: 1 });
  });
  it('confines impersonation to the effective viewer and the one shared org', async () => {
    await member(viewer.id, hidden.id);
    const imp = { sessionId: 'imp', actorUserId: other.id, orgId: shared.id, expiresAt: new Date(Date.now() + 60000) };
    expect(await page(ctx(viewer.id, { impersonation: imp }))).toEqual({ items: [{ id: shared.id, name: shared.name, urn: shared.urn }], total: 1 });
    expect(await page(ctx(other.id, { impersonation: imp }))).toEqual({ items: [], total: 0 });
  });
  it('supports count-only, bounded paging and stable id order after filtering', async () => {
    const rows = await Promise.all(Array.from({ length: 24 }, () => org()));
    await db.orgMember.createMany({ data: rows.flatMap(o => [viewer.id, target.id].map(userId => ({ organizationId: o.id, userId, role: 'READER' }))) });
    const all = [shared, ...rows].sort((a,b) => a.id.localeCompare(b.id));
    expect((await page()).items).toHaveLength(20);
    expect(await page(ctx(viewer.id), { limit: 0 })).toEqual({ items: [], total: 25 });
    const last = await page(ctx(viewer.id), { limit: 200, offset: 20 });
    expect(last.items.map((o: any) => o.id)).toEqual(all.slice(20).map(o => o.id));
    expect(last.total).toBe(25);
  });
  it('uses the actual nested GraphQL field and a safe leaf, with no full Organization relation', async () => {
    const response = await server.executeOperation({ query: '{ me { sharedOrganizations { items { id name urn } total } } }' }, { contextValue: ctx(viewer.id) });
    expect(response.body.kind).toBe('single');
    if (response.body.kind !== 'single') throw Error('Expected single response');
    expect(response.body.singleResult.errors).toBeUndefined();
    expect((response.body.singleResult.data as any).me.sharedOrganizations.total).toBe(1);
    const forbidden = await server.executeOperation({ query: '{ me { sharedOrganizations { items { members { role } } } } }' }, { contextValue: ctx(viewer.id) });
    if (forbidden.body.kind !== 'single') throw Error('Expected single response');
    expect(forbidden.body.singleResult.errors?.[0].message).toContain('Cannot query field "members"');
  });
});
