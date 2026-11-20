/**
 * #2213 slice S3 (Patrick's attach 6412781514, gate CHECKED T1 6412935160) — `hostRegistrationsPage` and
 * `dashboardWidgetsPage`, additive paged siblings of `hostRegistrations` and `dashboardWidgets`.
 * Spec: hrn:node:hadronmemory.com:specs:cor:api:120:04 (and :02 for the envelope).
 *
 * What this file pins, per field:
 *   - 25 rows paged at 7 cover every row once, in the old field's order, with `hasMore` false on the last page,
 *     and the pages concatenated equal the old field's list exactly.
 *   - Refusal parity: a refused caller gets the old field's answer (the same code and message for a registration
 *     read; the same empty answer for a widget read), so `total` tells it nothing.
 *   - Another App's or user's rows are never in `items` or `total`.
 *   - Each registration item keeps its workers, in `workerId` order.
 *   - `limit: 0` returns only `total`; the size edges are S1's `pageArgs`.
 *   - A host key's read is recorded once, with `count` = the items returned on that page.
 */
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { GraphQLError } from 'graphql';
import { randomBytes } from 'node:crypto';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { APP_KEY_PREFIX, hashAppKey } from '../../../middleware/auth.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

const Q = resolvers.Query as any;
const M = resolvers.Mutation as any;
const server = new ApolloServer<Context>({ typeDefs, resolvers });

type Page<T> = { items: T[]; total: number; hasMore: boolean };

/** The refusal a call ends in, as `{ code, message }`, or null when it resolves. */
async function refusal(p: Promise<unknown>): Promise<{ code: unknown; message: string } | null> {
  try { await p; } catch (e) {
    expect(e).toBeInstanceOf(GraphQLError);
    return { code: (e as GraphQLError).extensions?.code, message: (e as GraphQLError).message };
  }
  return null;
}

/** Walk every page at `size`, checking total and hasMore on each, and return the rows in order. */
async function walk<T>(read: (offset: number) => Promise<Page<T>>, expectedTotal: number, size: number): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; offset < expectedTotal; offset += size) {
    const p = await read(offset);
    expect(p.total).toBe(expectedTotal);
    expect(p.hasMore).toBe(offset + p.items.length < expectedTotal);
    out.push(...p.items);
  }
  expect(await read(expectedTotal)).toEqual({ items: [], total: expectedTotal, hasMore: false });
  return out;
}

async function sizeEdges(read: (args: Record<string, unknown>) => Promise<Page<unknown>>, total: number) {
  expect((await read({})).items).toHaveLength(Math.min(20, total));
  expect(await read({ limit: 0 })).toEqual({ items: [], total, hasMore: total > 0 });
  expect(await read({ limit: -3 })).toEqual({ items: [], total, hasMore: total > 0 });
  expect((await read({ limit: 100_000 })).items).toHaveLength(Math.min(200, total));
  expect((await read({ limit: 2, offset: -9 })).items).toEqual((await read({ limit: 2, offset: 0 })).items);
}

let n: number;
let org: { id: string; urn: string };
let app: { id: string };
let otherApp: { id: string };
let manager: { id: string };
let member: { id: string };
let outsider: { id: string };
let workers: string[];

const ctx = (userId?: string, extra: Partial<Context> = {}): Context => ({ db, userId, roles: ['READER'], ...extra }) as Context;
const keyCtx = (k: { id: string }, appId: string): Context =>
  ({ db, appId, appKeyId: k.id, organizationId: org.id, roles: [] }) as Context;
async function mkKey(appId: string, label: string) {
  const raw = `${APP_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  return db.appKey.create({ data: { id: generateId(), appId, keyHash: hashAppKey(raw), keyPreview: raw.slice(-4), label }, select: { id: true } });
}
const user = (k: number, name: string) =>
  db.user.create({ data: { githubId: k * 1_000_000 + n, githubUsername: `s3-${name}-${n}`, roles: ['READER'] }, select: { id: true } });

beforeEach(async () => {
  await cleanDb(db);
  n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { name: 'S3 pages', urn: `s3pages-${n}.example` }, select: { id: true, urn: true } });
  manager = await user(81, 'manager');
  member = await user(82, 'member');
  outsider = await user(83, 'outsider');
  await db.orgMember.create({ data: { organizationId: org.id, userId: manager.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgRef: org.id, name: 'S3 Agent' }, ctx(manager.id));
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` }, select: { id: true } });
  otherApp = await db.app.create({ data: { organizationId: org.id, name: 'Other', urn: `${org.urn}:other` }, select: { id: true } });
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
  workers = [];
  for (const slug of ['w-c', 'w-a', 'w-b']) {
    workers.push((await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: slug, slug }, select: { id: true } })).id);
  }
});

/** `count` registrations on `appId`, host ids h00..; each lists every worker given, inserted in reverse id order. */
async function seedRegistrations(appId: string, count: number, prefix = 'h', withWorkers: string[] = []) {
  const now = new Date();
  for (let i = count - 1; i >= 0; i--) {
    await db.hostRegistration.create({
      data: {
        appId, hostId: `${prefix}${String(i).padStart(2, '0')}`, label: `Host ${i}`, pollIntervalSeconds: 60, refreshedAt: now,
        workers: { create: [...withWorkers].sort().reverse().map((workerId) => ({ workerId, family: 'claude', worktrees: [] })) },
      },
    });
  }
}

describe('hostRegistrationsPage', () => {
  const page = (c: Context, args: Record<string, unknown> = {}, appRef = app.id): Promise<Page<any>> =>
    Q.hostRegistrationsPage({}, { appRef, ...args }, c);

  it('25 registrations paged at 7 cover every row once, in the old field\'s hostId order', async () => {
    await seedRegistrations(app.id, 25);
    const rows = await walk((offset) => page(ctx(member.id), { limit: 7, offset }), 25, 7);
    const old = await Q.hostRegistrations({}, { appRef: app.id }, ctx(member.id));
    expect(rows.map((r) => r.hostId)).toEqual(old.map((r: any) => r.hostId));
    expect(rows.map((r) => r.hostId)).toEqual([...rows.map((r) => r.hostId)].sort());
    const withoutLive = (r: any) => { const { live: _live, ...rest } = r; return rest; };
    expect(rows.map(withoutLive)).toEqual(old.map(withoutLive)); // live is derived per read, on the reader's clock
    await sizeEdges((a) => page(ctx(member.id), a), 25);
  });

  it('each item keeps its workers, in workerId order', async () => {
    await seedRegistrations(app.id, 3, 'h', workers);
    const p = await page(ctx(member.id), { limit: 2, offset: 1 });
    expect(p.items.map((r) => r.hostId)).toEqual(['h01', 'h02']);
    for (const r of p.items) expect(r.workers.map((w: any) => w.workerId)).toEqual([...workers].sort());
  });

  it('another App\'s registrations are in neither items nor total', async () => {
    await seedRegistrations(app.id, 4);
    await seedRegistrations(otherApp.id, 9, 'x');
    const p = await page(ctx(member.id), { limit: 50 });
    expect(p.total).toBe(4);
    expect(p.items.map((r) => r.hostId)).toEqual(['h00', 'h01', 'h02', 'h03']);
  });

  it('refuses exactly as the old field does: an outsider and a foreign App key learn nothing, not even total', async () => {
    await seedRegistrations(app.id, 5);
    const foreign = await mkKey(otherApp.id, 'foreign');
    for (const c of [ctx(outsider.id), keyCtx(foreign, otherApp.id), ctx(undefined)]) {
      const was = await refusal(Q.hostRegistrations({}, { appRef: app.id }, c));
      expect(was).not.toBeNull();
      expect(await refusal(page(c))).toEqual(was);
      expect(await refusal(page(c, { limit: 0 }))).toEqual(was);
    }
    const missing = await refusal(Q.hostRegistrations({}, { appRef: generateId() }, ctx(member.id)));
    expect(await refusal(page(ctx(member.id), {}, generateId()))).toEqual(missing);
  });

  it('the App\'s own key reads the page, and its read is recorded once with count = the items on that page', async () => {
    await seedRegistrations(app.id, 9);
    const key = await mkKey(app.id, 'plain');
    const p = await page(keyCtx(key, app.id), { limit: 4, offset: 6 });
    expect(p).toMatchObject({ total: 9, hasMore: false });
    expect(p.items).toHaveLength(3);
    const uses = await db.hostKeyUse.findMany({ where: { appKeyId: key.id, action: 'read' } });
    expect(uses.map((u) => u.count)).toEqual([3]);
    await page(keyCtx(key, app.id), { limit: 0 });
    expect((await db.hostKeyUse.findMany({ where: { appKeyId: key.id, action: 'read' }, orderBy: { usedAt: 'asc' } })).map((u) => u.count)).toEqual([3, 0]);
  });

  it('is in the schema with the envelope, and its description sends a deciding consumer to the end', async () => {
    await seedRegistrations(app.id, 2, 'h', workers);
    const res = await server.executeOperation(
      { query: `query($a:String!){ hostRegistrationsPage(appRef:$a, limit:1){ items{ hostId workers{ workerId } } total hasMore } }`, variables: { a: app.id } },
      { contextValue: ctx(member.id) },
    );
    if (res.body.kind !== 'single') throw new Error('unexpected');
    expect(res.body.singleResult.errors).toBeUndefined();
    expect(res.body.singleResult.data).toEqual({
      hostRegistrationsPage: { items: [{ hostId: 'h00', workers: [...workers].sort().map((workerId) => ({ workerId })) }], total: 2, hasMore: true },
    });
    expect(typeDefs).toMatch(/hostRegistrationsPage\(appRef: String!, limit: Int, offset: Int\): HostRegistrationPage!/);
  });
});

describe('dashboardWidgetsPage', () => {
  const page = (c: Context, args: Record<string, unknown> = {}): Promise<Page<any>> => Q.dashboardWidgetsPage({}, args, c);

  /** `count` widgets for `userId`; positions collide in pairs so the id tiebreak is exercised. */
  async function seedWidgets(userId: string, count: number) {
    await db.dashboardWidget.createMany({
      data: Array.from({ length: count }, (_, i) => ({ id: generateId(), userId, type: 'MEMORY_STATS' as const, position: Math.floor(i / 2) })),
    });
  }

  it('25 widgets paged at 7 cover every row once, in the old field\'s position, id order', async () => {
    await seedWidgets(member.id, 25);
    const rows = await walk((offset) => page(ctx(member.id), { limit: 7, offset }), 25, 7);
    const old = await Q.dashboardWidgets({}, {}, ctx(member.id));
    expect(rows.map((w) => w.id)).toEqual(old.map((w: any) => w.id));
    expect(new Set(rows.map((w) => w.id)).size).toBe(25);
    await sizeEdges((a) => page(ctx(member.id), a), 25);
  });

  it('another user\'s widgets are in neither items nor total', async () => {
    await seedWidgets(member.id, 3);
    await seedWidgets(manager.id, 8);
    const p = await page(ctx(member.id), { limit: 50 });
    expect(p.total).toBe(3);
    expect(p.items.every((w) => w.userId === member.id)).toBe(true);
  });

  it('an unauthenticated, App-key or impersonated caller gets the empty page, as the old field gives []', async () => {
    await seedWidgets(member.id, 6);
    const key = await mkKey(app.id, 'plain');
    const impersonated = ctx(member.id, {
      impersonation: { sessionId: generateId(), actorUserId: manager.id, orgId: org.id, expiresAt: new Date(Date.now() + 60_000) } as never,
    });
    for (const c of [ctx(undefined), keyCtx(key, app.id), impersonated]) {
      expect(await Q.dashboardWidgets({}, {}, c)).toEqual([]);
      expect(await page(c)).toEqual({ items: [], total: 0, hasMore: false });
      expect(await page(c, { limit: 0 })).toEqual({ items: [], total: 0, hasMore: false });
    }
  });

  it('is in the schema with the envelope', async () => {
    await seedWidgets(member.id, 2);
    const res = await server.executeOperation({ query: '{ dashboardWidgetsPage(limit: 1){ items{ id } total hasMore } }' }, { contextValue: ctx(member.id) });
    if (res.body.kind !== 'single') throw new Error('unexpected');
    expect(res.body.singleResult.errors).toBeUndefined();
    expect(res.body.singleResult.data).toMatchObject({ dashboardWidgetsPage: { total: 2, hasMore: true } });
    expect(typeDefs).toMatch(/dashboardWidgetsPage\(limit: Int, offset: Int\): DashboardWidgetPage!/);
  });
});
