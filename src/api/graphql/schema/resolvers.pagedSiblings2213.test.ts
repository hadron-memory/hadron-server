/**
 * #2213 S1 — the three additive page siblings (`tickersPage`,
 * `exchangeConnectionsPage`, `dashboardWidgetPresetsPage`) and the shared
 * `pageArgs` they size with. Spec: cor:api:120:02 / :04.
 *
 * What this file pins:
 *   - `pageArgs`: omitted/null limit 20, 0 count-only, negative 0, cap 200 (never
 *     a refusal), offset normalized to >= 0.
 *   - Each sibling: `{ items, total, hasMore }`, the SAME access scope and order as
 *     its old field, count and page from one RepeatableRead batch with database
 *     take/skip, ties never dropped or duplicated across pages, and no
 *     `extensions.warnings`.
 *   - `exchangeConnectionsPage` admits exactly the callers the old field admits
 *     (one shared admission) and its pages concatenate to the old list.
 *   - The old fields are unchanged above 20 rows.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';
import { pageArgs } from './resolvers.helpers.js';

const Q = resolvers.Query as any;
const server = new ApolloServer<Context>({ typeDefs, resolvers });

async function gql(query: string, ctx: Partial<Context>) {
  const res = await server.executeOperation({ query }, { contextValue: { db, ...ctx } as Context });
  if (res.body.kind !== 'single') throw new Error('unexpected');
  return res.body.singleResult;
}

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

describe('pageArgs', () => {
  it('omitted and null limit page at 20; 0 is count-only; negative is 0; over the cap is 200', () => {
    expect(pageArgs({})).toEqual({ take: 20, skip: 0 });
    expect(pageArgs({ limit: null, offset: null })).toEqual({ take: 20, skip: 0 });
    expect(pageArgs({ limit: 0 })).toEqual({ take: 0, skip: 0 });
    expect(pageArgs({ limit: -5 })).toEqual({ take: 0, skip: 0 });
    expect(pageArgs({ limit: 7 })).toEqual({ take: 7, skip: 0 });
    expect(pageArgs({ limit: 200 })).toEqual({ take: 200, skip: 0 });
    expect(pageArgs({ limit: 201 })).toEqual({ take: 200, skip: 0 });
    expect(pageArgs({ limit: 1_000_000 })).toEqual({ take: 200, skip: 0 });
  });

  it('a negative or omitted offset is 0', () => {
    expect(pageArgs({ offset: -3 })).toEqual({ take: 20, skip: 0 });
    expect(pageArgs({ offset: 40 })).toEqual({ take: 20, skip: 40 });
  });
});

// ── tickersPage ────────────────────────────────────────────────────────────

describe('tickersPage', () => {
  let member: { id: string };
  let outsider: { id: string };
  let app: { id: string };
  let otherApp: { id: string };
  const ctx = (userId: string): Context => ({ db, userId, roles: ['READER'] });

  async function seedTickers(appId: string, n: number, over: Record<string, unknown> = {}) {
    // One createdAt for every row: the id tiebreak alone must keep pages whole.
    const createdAt = new Date('2026-01-01T00:00:00Z');
    const rows = [];
    for (let i = 0; i < n; i++) {
      rows.push({
        id: generateId(), appId, name: `T${String(i).padStart(3, '0')}`, slug: `t${String(i).padStart(3, '0')}`,
        cadenceSeconds: 600, createdAt, ...over,
      });
    }
    await db.ticker.createMany({ data: rows });
  }

  beforeEach(async () => {
    await cleanDb(db);
    const suffix = generateId().slice(-8);
    const org = await db.organization.create({ data: { id: generateId(), name: 'p-org', urn: `p-org-${suffix}.com` } });
    member = await db.user.create({ data: { id: generateId(), handle: `pm-${suffix}`, roles: ['READER'] }, select: { id: true } });
    outsider = await db.user.create({ data: { id: generateId(), handle: `po-${suffix}`, roles: ['READER'] }, select: { id: true } });
    app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'A', urn: `${org.urn}:a` } });
    otherApp = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'B', urn: `${org.urn}:b` } });
    await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
  });

  afterEach(() => vi.restoreAllMocks());

  it('pages the same rows, in the same order, as the old field; ties never drop or duplicate', async () => {
    await seedTickers(app.id, 45);
    const old = await Q.tickers({}, { appRef: app.id }, ctx(member.id));
    expect(old).toHaveLength(45);

    const seen: string[] = [];
    for (let offset = 0; offset < 45; offset += 20) {
      const p = await Q.tickersPage({}, { appRef: app.id, limit: 20, offset }, ctx(member.id));
      expect(p.total).toBe(45);
      seen.push(...ids(p.items));
      expect(p.hasMore).toBe(offset + p.items.length < 45);
    }
    expect(seen).toEqual(ids(old));
    expect(new Set(seen).size).toBe(45);
  });

  it('size edges: omitted/null 20, 0 count-only, negative 0, over-cap 200, past-end empty', async () => {
    await seedTickers(app.id, 230);
    const c = ctx(member.id);
    expect((await Q.tickersPage({}, { appRef: app.id }, c)).items).toHaveLength(20);
    expect((await Q.tickersPage({}, { appRef: app.id, limit: null, offset: null }, c)).items).toHaveLength(20);

    const countOnly = await Q.tickersPage({}, { appRef: app.id, limit: 0 }, c);
    expect(countOnly).toEqual({ items: [], total: 230, hasMore: true });
    const negative = await Q.tickersPage({}, { appRef: app.id, limit: -1 }, c);
    expect(negative).toEqual({ items: [], total: 230, hasMore: true });

    const capped = await Q.tickersPage({}, { appRef: app.id, limit: 5000 }, c);
    expect(capped.items).toHaveLength(200);
    expect(capped.hasMore).toBe(true);

    const last = await Q.tickersPage({}, { appRef: app.id, limit: 200, offset: 200 }, c);
    expect(last.items).toHaveLength(30);
    expect(last.hasMore).toBe(false);

    const past = await Q.tickersPage({}, { appRef: app.id, limit: 20, offset: 9999 }, c);
    expect(past).toEqual({ items: [], total: 230, hasMore: false });
    const negOffset = await Q.tickersPage({}, { appRef: app.id, limit: 3, offset: -9 }, c);
    expect(ids(negOffset.items)).toEqual(ids((await Q.tickers({}, { appRef: app.id }, c)).slice(0, 3)));
  });

  it('hasMore is false on the last full page, and on an empty App', async () => {
    await seedTickers(app.id, 20);
    const c = ctx(member.id);
    const full = await Q.tickersPage({}, { appRef: app.id, limit: 20 }, c);
    expect(full.items).toHaveLength(20);
    expect(full.hasMore).toBe(false);
    await db.ticker.deleteMany({ where: { appId: app.id } });
    expect(await Q.tickersPage({}, { appRef: app.id }, c)).toEqual({ items: [], total: 0, hasMore: false });
    expect(await Q.tickersPage({}, { appRef: app.id, limit: 0 }, c)).toEqual({ items: [], total: 0, hasMore: false });
  });

  it('count and page share one scope: other Apps and deleted rows are in neither', async () => {
    await seedTickers(app.id, 3);
    await seedTickers(otherApp.id, 4);
    await db.ticker.createMany({
      data: ['D0', 'D1'].map((n) => ({ id: generateId(), appId: app.id, name: n, slug: n.toLowerCase(), cadenceSeconds: 600, deletedAt: new Date() })),
    });
    const p = await Q.tickersPage({}, { appRef: app.id, limit: 100 }, ctx(member.id));
    expect(p.total).toBe(3);
    expect(p.items).toHaveLength(3);
    expect(p.items.every((t: { appId: string }) => t.appId === app.id)).toBe(true);
  });

  it('refuses a non-participant exactly as the old field does', async () => {
    const code = async (p: Promise<unknown>) => {
      try { await p; } catch (e) { return (e as GraphQLError).extensions?.code; }
      return null;
    };
    const oldCode = await code(Q.tickers({}, { appRef: app.id }, ctx(outsider.id)));
    expect(oldCode).toBe('APP_NOT_FOUND');
    expect(await code(Q.tickersPage({}, { appRef: app.id }, ctx(outsider.id)))).toBe(oldCode);
  });

  it('runs count and page in one RepeatableRead batch with database take/skip', async () => {
    await seedTickers(app.id, 30);
    const find = vi.spyOn(db.ticker, 'findMany');
    const tx = vi.spyOn(db, '$transaction');
    await Q.tickersPage({}, { appRef: app.id, limit: 10, offset: 5 }, ctx(member.id));
    expect(find).toHaveBeenCalledWith(expect.objectContaining({ take: 10, skip: 5 }));
    expect(tx).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ isolationLevel: 'RepeatableRead' }));
  });

  it('answers over GraphQL with no extensions.warnings, and the old field stays whole above 20', async () => {
    await seedTickers(app.id, 25);
    const page = await gql(`query { tickersPage(appRef: "${app.id}") { total hasMore items { id } } }`, ctx(member.id));
    expect(page.errors).toBeUndefined();
    expect(page.extensions?.warnings).toBeUndefined();
    const data = page.data!.tickersPage as { total: number; hasMore: boolean; items: unknown[] };
    expect(data).toMatchObject({ total: 25, hasMore: true });
    expect(data.items).toHaveLength(20);
    const old = await gql(`query { tickers(appRef: "${app.id}") { id } }`, ctx(member.id));
    expect((old.data!.tickers as unknown[]).length).toBe(25);
    expect(old.extensions?.warnings).toBeUndefined();
  });
});

// ── dashboardWidgetPresetsPage ─────────────────────────────────────────────

describe('dashboardWidgetPresetsPage', () => {
  let user: { id: string };
  let other: { id: string };
  const ctx = (userId?: string, extra: Partial<Context> = {}): Context => ({ db, userId, roles: ['READER'], ...extra });

  async function seedPresets(userId: string, n: number, type: string = 'USAGE_ACTIVITY', prefix = 'P') {
    await db.dashboardWidgetPreset.createMany({
      data: Array.from({ length: n }, (_, i) => ({
        id: generateId(), userId, type: type as never, name: `${prefix}${String(i).padStart(3, '0')}`, config: {},
      })),
    });
  }

  beforeEach(async () => {
    await cleanDb(db);
    user = await db.user.create({ data: { id: generateId(), handle: `dp-${generateId().slice(-8)}` }, select: { id: true } });
    other = await db.user.create({ data: { id: generateId(), handle: `dq-${generateId().slice(-8)}` }, select: { id: true } });
  });

  afterEach(() => vi.restoreAllMocks());

  it('pages concatenate to the old list, in order, with the real total', async () => {
    await seedPresets(user.id, 45);
    const old = await Q.dashboardWidgetPresets({}, {}, ctx(user.id));
    const seen: string[] = [];
    for (let offset = 0; offset < 45; offset += 20) {
      const p = await Q.dashboardWidgetPresetsPage({}, { limit: 20, offset }, ctx(user.id));
      expect(p.total).toBe(45);
      expect(p.hasMore).toBe(offset + p.items.length < 45);
      seen.push(...ids(p.items));
    }
    expect(seen).toEqual(ids(old));
  });

  it('size edges: default 20, count-only, negative, over-cap 200, past-end', async () => {
    await seedPresets(user.id, 205);
    const c = ctx(user.id);
    expect((await Q.dashboardWidgetPresetsPage({}, {}, c)).items).toHaveLength(20);
    expect(await Q.dashboardWidgetPresetsPage({}, { limit: 0 }, c)).toEqual({ items: [], total: 205, hasMore: true });
    expect(await Q.dashboardWidgetPresetsPage({}, { limit: -4 }, c)).toEqual({ items: [], total: 205, hasMore: true });
    expect((await Q.dashboardWidgetPresetsPage({}, { limit: 9999 }, c)).items).toHaveLength(200);
    expect(await Q.dashboardWidgetPresetsPage({}, { offset: 500 }, c)).toEqual({ items: [], total: 205, hasMore: false });
  });

  it('count and page share the type filter and the owner scope', async () => {
    await seedPresets(user.id, 3, 'USAGE_ACTIVITY', 'A');
    await seedPresets(user.id, 2, 'RECENT_NODES', 'B');
    await seedPresets(other.id, 4, 'USAGE_ACTIVITY', 'C');
    const all = await Q.dashboardWidgetPresetsPage({}, { limit: 50 }, ctx(user.id));
    expect(all.total).toBe(5);
    const typed = await Q.dashboardWidgetPresetsPage({}, { type: 'RECENT_NODES', limit: 50 }, ctx(user.id));
    expect(typed.total).toBe(2);
    expect(typed.items.every((p: { userId: string; type: string }) => p.userId === user.id && p.type === 'RECENT_NODES')).toBe(true);
  });

  it('no user, or an impersonated caller, gets the empty page', async () => {
    await seedPresets(user.id, 3);
    const empty = { items: [], total: 0, hasMore: false };
    expect(await Q.dashboardWidgetPresetsPage({}, {}, ctx(undefined))).toEqual(empty);
    const imp = ctx(user.id, {
      impersonation: { orgId: generateId(), sessionId: 's', actorUserId: other.id, expiresAt: new Date(Date.now() + 60_000) } as never,
    });
    expect(await Q.dashboardWidgetPresetsPage({}, {}, imp)).toEqual(empty);
    expect(await Q.dashboardWidgetPresets({}, {}, imp)).toEqual([]);
  });

  it('runs count and page in one RepeatableRead batch with database take/skip', async () => {
    await seedPresets(user.id, 30);
    const find = vi.spyOn(db.dashboardWidgetPreset, 'findMany');
    const tx = vi.spyOn(db, '$transaction');
    await Q.dashboardWidgetPresetsPage({}, { limit: 10, offset: 5 }, ctx(user.id));
    expect(find).toHaveBeenCalledWith(expect.objectContaining({ take: 10, skip: 5 }));
    expect(tx).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ isolationLevel: 'RepeatableRead' }));
  });

  it('answers over GraphQL with no extensions.warnings; the old field stays whole above 20', async () => {
    await seedPresets(user.id, 25);
    const page = await gql(`query { dashboardWidgetPresetsPage { total hasMore items { id } } }`, ctx(user.id));
    expect(page.errors).toBeUndefined();
    expect(page.extensions?.warnings).toBeUndefined();
    expect(page.data!.dashboardWidgetPresetsPage).toMatchObject({ total: 25, hasMore: true });
    const old = await gql(`query { dashboardWidgetPresets { id } }`, ctx(user.id));
    expect((old.data!.dashboardWidgetPresets as unknown[]).length).toBe(25);
  });
});

// ── exchangeConnectionsPage ────────────────────────────────────────────────

describe('exchangeConnectionsPage', () => {
  let orgId: string;
  let otherOrgId: string;
  let users: Record<'admin' | 'orgOwner' | 'reader' | 'outsider' | 'platform', string>;

  async function mkUser(handle: string, githubId: number, roles: string[] = []) {
    return (await db.user.create({
      data: { id: generateId(), handle, githubId, githubUsername: handle, name: handle, roles: roles as never },
    })).id;
  }

  beforeEach(async () => {
    await cleanDb(db);
    users = {
      admin: await mkUser('pgadmin', 9301),
      orgOwner: await mkUser('pgowner', 9302),
      reader: await mkUser('pgreader', 9303),
      outsider: await mkUser('pgoutsider', 9304),
      platform: await mkUser('pgplatform', 9305, ['ADMIN']),
    };
    orgId = (await db.organization.create({ data: { id: generateId(), name: 'PG Org', urn: 'pgorg.test', createdBy: users.orgOwner } })).id;
    otherOrgId = (await db.organization.create({ data: { id: generateId(), name: 'PG Other', urn: 'pgother.test', createdBy: users.outsider } })).id;
    await db.orgMember.createMany({
      data: [
        { organizationId: orgId, userId: users.admin, role: 'ADMIN' },
        { organizationId: orgId, userId: users.orgOwner, role: 'OWNER' },
        { organizationId: orgId, userId: users.reader, role: 'READER' },
        { organizationId: otherOrgId, userId: users.outsider, role: 'ADMIN' },
      ],
    });
    const createdAt = new Date('2026-01-01T00:00:00Z');
    const mk = (organizationId: string, n: number, over: Record<string, unknown> = {}) =>
      db.exchangeConnection.createMany({
        data: Array.from({ length: n }, (_, i) => ({
          id: generateId(), organizationId, userId: users.admin, mailboxEmail: `${generateId().slice(-6)}-${i}@example.com`,
          toolConnectionId: `tool-${generateId()}`, createdBy: users.admin, createdAt, ...over,
        })),
      });
    await mk(orgId, 45);
    await mk(orgId, 2, { deletedAt: new Date() });
    await mk(otherOrgId, 3);
  });

  afterEach(() => vi.restoreAllMocks());

  const ctxFor = (who: keyof typeof users): Context =>
    ({ db, ...(who === 'platform' ? { userId: users.platform, roles: ['ADMIN'] } : { userId: users[who], roles: [] }) }) as Context;
  const imp = (target: string): Context =>
    ({ db, userId: target, roles: [], impersonation: { orgId, sessionId: 'support', actorUserId: users.platform, expiresAt: new Date(Date.now() + 3_600_000) } }) as Context;

  async function outcome(p: Promise<any>) {
    try { return { ok: await p }; } catch (e) { return { code: (e as GraphQLError).extensions?.code }; }
  }

  it('admits exactly the callers the old field admits, and refuses with the same code', async () => {
    const cases: Array<[string, Context]> = [
      ['admin', ctxFor('admin')], ['orgOwner', ctxFor('orgOwner')], ['platform', ctxFor('platform')],
      ['reader', ctxFor('reader')], ['outsider', ctxFor('outsider')],
      ['impersonated admin', imp(users.admin)], ['impersonated reader', imp(users.reader)],
    ];
    for (const [label, c] of cases) {
      const old = await outcome(Q.exchangeConnections({}, { orgId }, c));
      const page = await outcome(Q.exchangeConnectionsPage({}, { orgId, limit: 200 }, c));
      expect(Boolean(page.ok), label).toBe(Boolean(old.ok));
      expect(page.code, label).toBe(old.code);
      if (old.ok) expect(ids(page.ok.items), label).toEqual(ids(old.ok));
    }
    expect((await outcome(Q.exchangeConnections({}, { orgId }, ctxFor('reader')))).code).toBe('FORBIDDEN');
  });

  it('pages concatenate to the old list in order; ties never drop or duplicate', async () => {
    const c = ctxFor('admin');
    const old = await Q.exchangeConnections({}, { orgId }, c);
    expect(old).toHaveLength(45);
    const seen: string[] = [];
    for (let offset = 0; offset < 45; offset += 20) {
      const p = await Q.exchangeConnectionsPage({}, { orgId, limit: 20, offset }, c);
      expect(p.total).toBe(45);
      expect(p.hasMore).toBe(offset + p.items.length < 45);
      seen.push(...ids(p.items));
    }
    expect(seen).toEqual(ids(old));
    expect(new Set(seen).size).toBe(45);
  });

  it('size edges, and the count excludes deleted rows and another org', async () => {
    const c = ctxFor('admin');
    expect((await Q.exchangeConnectionsPage({}, { orgId }, c)).items).toHaveLength(20);
    expect(await Q.exchangeConnectionsPage({}, { orgId, limit: 0 }, c)).toMatchObject({ items: [], total: 45, hasMore: true });
    expect(await Q.exchangeConnectionsPage({}, { orgId, limit: -2 }, c)).toMatchObject({ items: [], total: 45, hasMore: true });
    expect((await Q.exchangeConnectionsPage({}, { orgId, limit: 9999 }, c)).items).toHaveLength(45);
    expect(await Q.exchangeConnectionsPage({}, { orgId, offset: 999 }, c)).toMatchObject({ items: [], total: 45, hasMore: false });
    expect((await Q.exchangeConnectionsPage({}, { orgId, limit: 45 }, c)).hasMore).toBe(false);
  });

  it('Organization.exchangeConnections still masks a refusal to [] and is unchanged above 20', async () => {
    const q = `query { organization(ref: "${orgId}") { exchangeConnections { id } } }`;
    const reader = await gql(q, ctxFor('reader'));
    expect(reader.errors).toBeUndefined();
    expect((reader.data!.organization as any).exchangeConnections).toEqual([]);
    const admin = await gql(q, ctxFor('admin'));
    expect((admin.data!.organization as any).exchangeConnections).toHaveLength(45);
  });

  it('runs count and page in one RepeatableRead batch with database take/skip', async () => {
    const find = vi.spyOn(db.exchangeConnection, 'findMany');
    const tx = vi.spyOn(db, '$transaction');
    await Q.exchangeConnectionsPage({}, { orgId, limit: 10, offset: 5 }, ctxFor('admin'));
    expect(find).toHaveBeenCalledWith(expect.objectContaining({ take: 10, skip: 5 }));
    expect(tx).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ isolationLevel: 'RepeatableRead' }));
  });

  it('answers over GraphQL with no extensions.warnings', async () => {
    const page = await gql(`query { exchangeConnectionsPage(orgId: "${orgId}", limit: 5) { total hasMore items { id mailboxEmail } } }`, ctxFor('admin'));
    expect(page.errors).toBeUndefined();
    expect(page.extensions?.warnings).toBeUndefined();
    expect(page.data!.exchangeConnectionsPage).toMatchObject({ total: 45, hasMore: true });
    const denied = await gql(`query { exchangeConnectionsPage(orgId: "${orgId}") { total } }`, ctxFor('reader'));
    expect(denied.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
  });
});
