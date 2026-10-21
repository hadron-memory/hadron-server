import { ApolloServer } from '@apollo/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
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
  it('requires the target membership and both live users on every new request', async () => {
    await member(viewer.id, hidden.id);
    await db.orgMember.update({ where: { organizationId_userId: { userId: target.id, organizationId: hidden.id } }, data: { deletedAt: new Date() } });
    expect(await page()).toEqual({ items: [{ id: shared.id, name: shared.name, urn: shared.urn }], total: 1 });
    await db.user.update({ where: { id: viewer.id }, data: { deletedAt: new Date() } });
    expect(await page()).toBeNull();
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
    for (const c of [ctx(), ctx(undefined, { appKeyId: 'key', appId: 'app' }), ctx(viewer.id, { appKeyId: 'key', appId: 'app' }), ctx(viewer.id, { clientId: 'run:synthetic' }), ctx(viewer.id, { sessionBindingRefused: true })]) {
      let probes = 0;
      c.db = db.$extends({ query: { orgMember: { $allOperations: async ({ args, query }) => { probes++; return query(args); } } } }) as Context['db'];
      expect(await page(c)).toBeNull();
      expect(probes).toBe(0);
    }
    expect(await page(ctx(viewer.id, { appId: 'selected-app' }))).toMatchObject({ total: 1 });
  });
  it('uses the human viewer for a worker-bound user without adding the Worker App organization', async () => {
    const agent = await db.agent.create({ data: { organizationId: hidden.id, name: 'Worker agent', urn: `${hidden.urn}:agent` } });
    const app = await db.app.create({ data: { organizationId: hidden.id, name: 'Worker App', urn: `${hidden.urn}:worker-app` } });
    await db.appMember.create({ data: { appId: app.id, userId: viewer.id, role: 'member' } });
    const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id,
      name: 'Bound', slug: 'bound', heldByUserId: viewer.id } });
    const session = await db.session.create({ data: { id: generateId(), appId: app.id, agentId: agent.id,
      workerId: worker.id, userId: viewer.id, tool: 'vitest' } });
    expect(await page(ctx(viewer.id, { sessionId: session.id, appId: app.id }))).toEqual({
      items: [{ id: shared.id, name: shared.name, urn: shared.urn }], total: 1,
    });
  });
  it('confines impersonation to the effective viewer and the one shared org', async () => {
    await member(viewer.id, hidden.id);
    const imp = { sessionId: 'imp', actorUserId: other.id, orgId: shared.id, expiresAt: new Date(Date.now() + 60000) };
    expect(await page(ctx(viewer.id, { impersonation: imp }))).toEqual({ items: [{ id: shared.id, name: shared.name, urn: shared.urn }], total: 1 });
    expect(await page(ctx(other.id, { impersonation: imp }))).toEqual({ items: [], total: 0 });
  });
  it('supports count-only, bounded paging and stable id order after filtering', async () => {
    const rows = await Promise.all(Array.from({ length: 204 }, () => org()));
    await db.orgMember.createMany({ data: rows.flatMap(o => [viewer.id, target.id].map(userId => ({ organizationId: o.id, userId, role: 'READER' }))) });
    const all = [shared, ...rows].sort((a,b) => a.id.localeCompare(b.id));
    expect((await page()).items).toHaveLength(20);
    expect(await page(ctx(viewer.id), { limit: 0 })).toEqual({ items: [], total: 205 });
    const last = await page(ctx(viewer.id), { limit: 1000, offset: 200 });
    expect(last.items.map((o: any) => o.id)).toEqual(all.slice(200).map(o => o.id));
    expect(last.total).toBe(205);
    expect((await page(ctx(viewer.id), { limit: 1000, offset: -1 })).items).toHaveLength(200);
  });
  it('uses the actual nested GraphQL field and a safe leaf, with no full Organization relation', async () => {
    const response = await server.executeOperation({ query: 'query($ref: ID!) { user(ref: $ref) { sharedOrganizations { items { id name urn } total } } }', variables: { ref: target.id } }, { contextValue: ctx(viewer.id) });
    expect(response.body.kind).toBe('single');
    if (response.body.kind !== 'single') throw Error('Expected single response');
    expect(response.body.singleResult.errors).toBeUndefined();
    expect((response.body.singleResult.data as any).user.sharedOrganizations.total).toBe(1);
    const forbidden = await server.executeOperation({ query: '{ me { sharedOrganizations { items { members { role } } } } }' }, { contextValue: ctx(viewer.id) });
    if (forbidden.body.kind !== 'single') throw Error('Expected single response');
    expect(forbidden.body.singleResult.errors?.[0].message).toContain('Cannot query field "members"');
  });
  it('batches sibling targets and keeps viewer/page caches off the parent User', async () => {
    const targets = await Promise.all(Array.from({ length: 100 }, () => user()));
    await db.orgMember.createMany({ data: targets.map(u => ({ userId: u.id, organizationId: shared.id, role: 'READER' })) });
    for (const size of [1, 100]) {
      const calls: string[] = [];
      const traced = db.$extends({ query: { $allOperations: async ({ model, operation, args, query }) => {
        calls.push(`${model ?? 'raw'}:${operation}`); return query(args);
      } } });
      const c = ctx(viewer.id, { db: traced as Context['db'] });
      const pages = await Promise.all(targets.slice(0, size).map(u => page(c, {}, u)));
      expect(pages.every(p => p.total === 1 && p.items.length === 1)).toBe(true);
      expect(calls).toHaveLength(4);
      expect(await page(c, { limit: 0 }, targets[0])).toEqual({ items: [], total: 1 });
    }
    const parent = targets[0];
    expect(await page(ctx(other.id), {}, parent)).toEqual({ items: [], total: 0 });
    const reused = ctx(viewer.id);
    expect((await page(reused, {}, parent)).total).toBe(1);
    reused.userId = other.id;
    expect(await page(reused, {}, parent)).toEqual({ items: [], total: 0 });
  });
  it('keeps total and items in one snapshot when target membership is revoked between them', async () => {
    let reached!: () => void; let release!: () => void;
    const ready = new Promise<void>(r => { reached = r; });
    const barrier = new Promise<void>(r => { release = r; });
    const traced = db.$extends({ query: { $allOperations: async ({ operation, args, query }) => {
      if (operation === '$queryRaw' && JSON.stringify(args).includes('WITH ranked AS')) { reached(); await barrier; }
      return query(args);
    } } });
    const pending = page(ctx(viewer.id, { db: traced as Context['db'] }));
    await ready;
    try {
      await db.orgMember.update({ where: { organizationId_userId: { userId: target.id, organizationId: shared.id } }, data: { deletedAt: new Date() } });
    } finally { release(); }
    expect(await pending).toEqual({ items: [{ id: shared.id, name: shared.name, urn: shared.urn }], total: 1 });
    expect(await page()).toEqual({ items: [], total: 0 });
  });
});
