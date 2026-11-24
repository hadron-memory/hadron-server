/**
 * #5061 (#2212 A4b, hrn:node:hadronmemory.com:specs:cor:api:120:04) — `AppKey.hostUsesPage`, the paged sibling of
 * `AppKey.hostUses` (hrn:node:hadronmemory.com:specs:cor:agt:070:07 S3). Additive: `{ items, total, hasMore }` through
 * the shared `pageArgs`, behind the same `managesApp` gate as the old field; the old field is unchanged.
 * `Mutation.collectHostOperations` is deliberately untouched (gate R1 = (a)).
 *
 * P1 pages, P2 refusal parity (+ the gate runs before any count), P3 no extra disclosure over HTTP, P4 the cap,
 * P5 the old field byte-identical (green on main BY DESIGN: it is the parity control), P6 admission charges the cap.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { createServer } from '../../../server.js';
import { APP_KEY_PREFIX, hashAppKey, mintUserApiKey } from '../../../middleware/auth.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const F = resolvers as any;
const ROWS = 201;

let org: { id: string; urn: string };
let app: { id: string };
let manager: { id: string };
let member: { id: string };
let orca1: { id: string };
let ids: string[]; // every row of orca1, in usedAt desc, id desc order
let tieIds: string[];
let managerKey: string;
let memberKey: string;
let url: string;
let server: Server;

/** A context whose `hostKeyUse.count` / `findMany` calls are recorded, so a pin can see whether a refused caller reached a read. */
function spyCtx(base: Partial<Context>) {
  const calls: string[] = [];
  const hk = new Proxy((db as any).hostKeyUse, {
    get(t, p) {
      const v = t[p];
      if (p === 'count' || p === 'findMany') return (...a: unknown[]) => { calls.push(p as string); return v.apply(t, a); };
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  const wrapped = new Proxy(db as any, {
    get(t, p) {
      if (p === 'hostKeyUse') return hk;
      const v = t[p];
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  return { ctx: { db: wrapped, roles: ['READER'], ...base } as Context, calls };
}
const ctx = (userId?: string, extra: Partial<Context> = {}): Context => ({ db, userId, roles: ['READER'], ...extra }) as Context;
const keyArg = () => ({ id: orca1.id, appId: app.id });

async function refusal(p: Promise<unknown>): Promise<{ code: unknown; message: string; extensions: Record<string, unknown> }> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(GraphQLError);
    const g = e as GraphQLError;
    return { code: g.extensions?.code, message: g.message, extensions: { ...g.extensions } };
  }
  throw new Error('expected a refusal');
}

beforeAll(async () => {
  // #3066: clean the worker's clone before the app starts (a retained rate-limit manifest refuses boot).
  await cleanDb(db);
  server = createHttpServer(await createServer());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/graphql`;

  const n = generateId();
  org = await db.organization.create({ data: { name: 'Uses', urn: `uses5061-${n}.example` }, select: { id: true, urn: true } });
  manager = await db.user.create({ data: { handle: `u5061-mgr-${n}`, roles: ['READER'] }, select: { id: true } });
  member = await db.user.create({ data: { handle: `u5061-mem-${n}`, roles: ['READER'] }, select: { id: true } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: manager.id, role: 'ADMIN' } });
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` }, select: { id: true } });
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
  const raw = `${APP_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  orca1 = await db.appKey.create({ data: { id: generateId(), appId: app.id, keyHash: hashAppKey(raw), keyPreview: raw.slice(-4), label: 'orca1' }, select: { id: true } });

  // 201 uses, one second apart, plus two rows that tie on usedAt (the id tie-break orders them).
  const t0 = Date.parse('2026-11-01T00:00:00Z');
  const rows = Array.from({ length: ROWS - 2 }, (_, i) => ({ id: generateId(), appKeyId: orca1.id, appId: app.id, hostId: 'orca1', action: 'collect', count: i, usedAt: new Date(t0 + i * 1000) }));
  const tieAt = new Date(t0 + 50_500);
  const ties = [generateId(), generateId()].map((id) => ({ id, appKeyId: orca1.id, appId: app.id, hostId: 'orca1', action: 'read', count: null, usedAt: tieAt }));
  await db.hostKeyUse.createMany({ data: [...rows, ...ties] });
  ids = (await db.hostKeyUse.findMany({ where: { appKeyId: orca1.id }, orderBy: [{ usedAt: 'desc' }, { id: 'desc' }], select: { id: true } })).map((r) => r.id);
  tieIds = ties.map((t) => t.id).sort().reverse();

  managerKey = (await mintUserApiKey(db, { userId: manager.id, label: null, createdBy: manager.id, issuedVia: 'test' })).rawKey;
  memberKey = (await mintUserApiKey(db, { userId: member.id, label: null, createdBy: member.id, issuedVia: 'test' })).rawKey;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

const post = async (key: string, query: string) => {
  const r = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ query }) });
  return { status: r.status, body: (await r.json()) as { data?: any; errors?: Array<{ message: string; path?: unknown[]; extensions?: Record<string, unknown> }> } };
};

describe('P1: hostUsesPage pages every use once, newest first, with total and hasMore', () => {
  it('limit 50 at offsets 0..200 covers all 201 rows in usedAt desc, id desc order', async () => {
    const seen: string[] = [];
    const hasMore: boolean[] = [];
    for (const offset of [0, 50, 100, 150, 200]) {
      const page = await F.AppKey.hostUsesPage(keyArg(), { limit: 50, offset }, ctx(manager.id));
      expect(page.total).toBe(ROWS);
      hasMore.push(page.hasMore);
      seen.push(...page.items.map((u: { id: string }) => u.id));
    }
    expect(hasMore).toEqual([true, true, true, true, false]);
    expect(seen).toEqual(ids);
    // The two rows that tie on usedAt come out by id desc, adjacent.
    const at = seen.indexOf(tieIds[0]);
    expect(seen.slice(at, at + 2)).toEqual(tieIds);
  });

  it('the items are whole HostKeyUse rows, as the old field returns them', async () => {
    const page = await F.AppKey.hostUsesPage(keyArg(), { limit: 3 }, ctx(manager.id));
    const old = await F.AppKey.hostUses(keyArg(), { first: 3 }, ctx(manager.id));
    expect(page.items).toEqual(old);
  });
});

describe('P2: a caller who may not read the uses gets the old field\'s refusal, before any read', () => {
  const callers: Array<[string, () => Partial<Context>]> = [
    ['an App member who does not manage the App', () => ({ userId: member.id })],
    ['the App key itself', () => ({ appId: app.id, appKeyId: orca1.id, organizationId: org.id, roles: [] })],
    ['the manager under impersonation', () => ({ userId: manager.id, impersonation: { actorUserId: member.id } } as Partial<Context>)],
    ['an unauthenticated caller', () => ({})],
  ];
  it.each(callers)('%s', async (_label, base) => {
    const page = spyCtx(base());
    const old = spyCtx(base());
    const a = await refusal(F.AppKey.hostUsesPage(keyArg(), { limit: 5 }, page.ctx));
    const b = await refusal(F.AppKey.hostUses(keyArg(), { first: 5 }, old.ctx));
    expect(a.code).toBe('FORBIDDEN');
    expect(a).toEqual(b);
    // The gate runs before the count: a refused caller never reaches a hostKeyUse read.
    expect(page.calls).toEqual([]);
  });
});

describe('P3: over HTTP, total discloses nothing the old field does not', () => {
  it('a member reading hostUsesPage { total } gets the same error at the same path as hostUses', async () => {
    const neu = await post(memberKey, `{ appKeysPage(appRef: "${app.id}") { items { id hostUsesPage { total } } } }`);
    const old = await post(memberKey, `{ appKeysPage(appRef: "${app.id}") { items { id hostUses { id } } } }`);
    // Both are refused the same way, whether at the inventory or at the field; neither returns a number.
    expect(neu.status).toBe(old.status);
    expect(neu.body.errors?.map((e) => [e.message, e.extensions?.code])).toEqual(old.body.errors?.map((e) => [e.message, e.extensions?.code]));
    expect(JSON.stringify(neu.body)).not.toMatch(/"total"\s*:\s*\d/);
  });

  it('the manager reads total and the first page over HTTP', async () => {
    const r = await post(managerKey, `{ appKeysPage(appRef: "${app.id}") { items { id hostUsesPage(limit: 2) { items { id } total hasMore } } } }`);
    expect(r.body.errors).toBeUndefined();
    const k = r.body.data.appKeysPage.items.find((i: { id: string }) => i.id === orca1.id);
    expect(k.hostUsesPage).toEqual({ items: ids.slice(0, 2).map((id) => ({ id })), total: ROWS, hasMore: true });
  });
});

describe('P4: the size is clamped through pageArgs', () => {
  it('an over-cap limit is served as 200, with hasMore', async () => {
    const page = await F.AppKey.hostUsesPage(keyArg(), { limit: 100_000 }, ctx(manager.id));
    expect(page.items).toHaveLength(200);
    expect(page).toMatchObject({ total: ROWS, hasMore: true });
  });
  it('limit 0 is count-only; a negative limit is 0; neither returns the table', async () => {
    expect(await F.AppKey.hostUsesPage(keyArg(), { limit: 0 }, ctx(manager.id))).toEqual({ items: [], total: ROWS, hasMore: true });
    expect(await F.AppKey.hostUsesPage(keyArg(), { limit: -5 }, ctx(manager.id))).toEqual({ items: [], total: ROWS, hasMore: true });
  });
  it('omitted limit is 20; a negative offset is 0', async () => {
    const page = await F.AppKey.hostUsesPage(keyArg(), { offset: -3 }, ctx(manager.id));
    expect(page.items.map((u: { id: string }) => u.id)).toEqual(ids.slice(0, 20));
  });
});

describe('P5 (green on main by design, the parity control): the old hostUses field is unchanged', () => {
  it.each([
    [{}, 20],
    [{ first: 0 }, 1],
    [{ first: -1 }, 1],
    [{ first: 500 }, 200],
  ] as const)('hostUses(%o) returns %i rows in the same order', async (args, n) => {
    const rows = await F.AppKey.hostUses(keyArg(), args, ctx(manager.id));
    expect(rows.map((u: { id: string }) => u.id)).toEqual(ids.slice(0, n));
  });
});

describe('P6: admission charges hostUsesPage for the page its resolver reads', () => {
  it('limit 2147483647 is admitted over HTTP and serves 200 rows', async () => {
    const r = await post(managerKey, `{ appKeysPage(appRef: "${app.id}", limit: 5) { items { id hostUsesPage(limit: 2147483647) { items { id } total hasMore } } } }`);
    expect(r.body.errors).toBeUndefined();
    expect(r.status).toBe(200);
    const k = r.body.data.appKeysPage.items.find((i: { id: string }) => i.id === orca1.id);
    expect(k.hostUsesPage.items).toHaveLength(200);
  });
});
