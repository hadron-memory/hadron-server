/** #4157: `Secret.versions` / `currentVersion` cost a constant number of version queries across a page of App secrets. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

let ownerId: string;
let appId: string;
const context = (userId: string): Context => ({ db, userId, roles: [] } as unknown as Context);
const R = resolvers as any;

async function makeSecret(name: string, versions: number) {
  const s = await R.Mutation.createSecret({}, { ownerType: 'app', ownerRef: appId, name, kind: 'generic', value: 'v1' }, context(ownerId));
  for (let i = 2; i <= versions; i++) await R.Mutation.updateSecret({}, { ref: s.id, value: `v${i}` }, context(ownerId));
  return s;
}

/** Counts every statement the version fields send: the Prisma model calls and the raw windowed read. */
function spyVersionQueries() {
  const model = db.secretVersion as any;
  const spies = ['findFirst', 'findMany', 'count', 'groupBy'].map((m) => vi.spyOn(model, m));
  const raw = vi.spyOn(db as any, '$queryRaw');
  return () => spies.reduce((n, s) => n + s.mock.calls.length, 0) + raw.mock.calls.length;
}

beforeEach(async () => {
  process.env.HADRON_ENCRYPTION_KEY = '11'.repeat(32);
  process.env.SECRET_ROOT_KEY = '22'.repeat(32);
  await cleanDb(db);
  ownerId = (await db.user.create({ data: { email: `${generateId()}@b4157.test` } })).id;
  appId = (await db.app.create({ data: { name: 'B4157', ownerUserId: ownerId, urn: `${generateId().toLowerCase()}:b4157` } })).id;
});
afterEach(() => vi.restoreAllMocks());

const page = (ctx: Context, secrets: any[], args: any = {}) =>
  Promise.all(secrets.map(async (s) => ({
    cur: await R.Secret.currentVersion(s, {}, ctx),
    ver: await R.Secret.versions(s, args, ctx),
  })));

describe('#4157 versions batching', () => {
  it('uses a constant number of version queries however many secrets the page holds (acceptance 1)', async () => {
    const counts: number[] = [];
    for (const n of [1, 6]) {
      await cleanDb(db);
      ownerId = (await db.user.create({ data: { email: `${generateId()}@b4157.test` } })).id;
      appId = (await db.app.create({ data: { name: 'B4157', ownerUserId: ownerId, urn: `${generateId().toLowerCase()}:b4157` } })).id;
      const secrets: any[] = [];
      for (let i = 0; i < n; i++) secrets.push(await makeSecret(`s${i}`, 2));
      const rows = (await R.Query.secrets({}, { ownerType: 'app', ownerRef: appId }, context(ownerId))).items;
      const count = spyVersionQueries();
      await page(context(ownerId), rows);
      counts.push(count());
      vi.restoreAllMocks();
    }
    expect(counts[1]).toBe(counts[0]);
    expect(counts[0]).toBeLessThanOrEqual(3);
  });

  it('keeps each parent its own page, total, hasMore and newest version under batching (acceptance 2)', async () => {
    const a = await makeSecret('a', 5);
    const b = await makeSecret('b', 2);
    const ctx = context(ownerId);
    const [ra, rb] = await page(ctx, [a, b], { limit: 2, offset: 1 });
    expect(ra.ver.items.map((v: any) => v.versionNo)).toEqual([4, 3]);
    expect(ra.ver).toMatchObject({ total: 5, hasMore: true });
    expect(rb.ver.items.map((v: any) => v.versionNo)).toEqual([1]);
    expect(rb.ver).toMatchObject({ total: 2, hasMore: false });
    // currentVersion is the real newest, not derived from the offset page.
    expect([ra.cur, rb.cur]).toEqual([5, 2]);
    // An offset past the end: empty page, real total, newest still real.
    const [past] = await page(ctx, [a], { limit: 2, offset: 50 });
    expect(past.ver).toMatchObject({ items: [], total: 5, hasMore: false });
    expect(past.cur).toBe(5);
    // limit 0 counts only.
    const [zero] = await page(ctx, [a, b], { limit: 0 });
    expect(zero.ver).toMatchObject({ items: [], total: 5, hasMore: true });
  });

  it('serves the same bytes as one unbatched read per secret (acceptance 3)', async () => {
    const a = await makeSecret('a', 4);
    const b = await makeSecret('b', 3);
    const ctx = context(ownerId);
    const batched = await page(ctx, [a, b], { limit: 3 });
    for (const [i, s] of [a, b].entries()) {
      const direct = await db.secretVersion.findMany({
        where: { secretId: s.id }, orderBy: { versionNo: 'desc' }, take: 3,
        select: { id: true, versionNo: true, sizeBytes: true, writtenAt: true, writtenByUserId: true, writtenByWorkerId: true, supersededAt: true },
      });
      expect(JSON.stringify(batched[i].ver.items)).toBe(JSON.stringify(direct));
    }
    expect(JSON.stringify(batched)).not.toMatch(/valueEncrypted|ciphertext/i);
  });

  it('answers different pages for the same secret raised in one tick, and isolates secrets (cross-owner)', async () => {
    const a = await makeSecret('a', 4);
    const b = await makeSecret('b', 1);
    const ctx = context(ownerId);
    const [p1, p2] = await Promise.all([R.Secret.versions(a, { limit: 1 }, ctx), R.Secret.versions(a, { limit: 2, offset: 2 }, ctx)]);
    expect(p1.items.map((v: any) => v.versionNo)).toEqual([4]);
    expect(p2.items.map((v: any) => v.versionNo)).toEqual([2, 1]);
    const [only] = await page(ctx, [b]);
    expect(only.ver.items.map((v: any) => v.versionNo)).toEqual([1]);
  });

  it('org and user secrets and a lone parent cost no version query (controls)', async () => {
    const org = { id: generateId(), ownerType: 'org' };
    const user = { id: generateId(), ownerType: 'user' };
    const count = spyVersionQueries();
    const out = await page(context(ownerId), [org, user]);
    expect(count()).toBe(0);
    expect(out).toEqual([
      { cur: null, ver: { items: [], total: 0, hasMore: false } },
      { cur: null, ver: { items: [], total: 0, hasMore: false } },
    ]);
  });

  it('does not keep a result past the tick: a later read sees a later write', async () => {
    const a = await makeSecret('a', 1);
    const ctx = context(ownerId);
    expect((await page(ctx, [a]))[0].cur).toBe(1);
    await R.Mutation.updateSecret({}, { ref: a.id, value: 'again' }, ctx);
    expect((await page(ctx, [a]))[0].cur).toBe(2);
  });
});
