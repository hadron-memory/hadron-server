/**
 * #4171 (Holger ruling A, epic #1975; cor:acl:140:01, :03): a person who leaves the organization that owns an App ends the grants
 * they hold in that organization's Apps, in the removal's own transaction. First end stands; rejoining revives nothing; other
 * organizations, user-owned Apps and non-person holders are untouched.
 *
 * Fixture honesty: no shipped creator makes a PERSON-held grant today, so the rows are seeded through the test-only guard bypass
 * (insertGrantUnguarded); chronology below is as seeded (membership live, then removed, then stamped). Nothing here claims a
 * production person creator exists.
 */
import { beforeEach, afterAll, describe, expect, it } from 'vitest';
import { Prisma } from '../../../generated/prisma/index.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { DB_NOW, dropTestActions, insertGrant, insertGrantUnguarded, raw, seedWorld, type World } from '../../../lib/grants/grantFixtures3668.js';
import { endHeldGrants } from '../../../lib/grants/departure.js';
import { chargeGrantUse, readGrantForUpdate } from '../../../lib/grants/live.js';
import { waitForLockWaiters } from '../../../test/lockWait.js';
import { resolvers, type Context } from './resolvers.js';

const M = resolvers.Mutation as any;
const HOUR_AGO = raw(`${DB_NOW} - interval '1 hour'`);

let w: World;
let admin: { id: string };
let org2: { id: string };
let orgApp2: string; // an App of the SECOND organization
let personalApp: string; // a user-owned App of the member
const ctx = (userId: string): Context => ({ db, userId, roles: ['READER'] }) as Context;

type Row = { id: string; departed: boolean; stamp: string | null; revoked: boolean };
const row = async (id: string): Promise<Row> => (await db.$queryRaw<Row[]>(Prisma.sql`
  SELECT id, holder_departed_at IS NOT NULL AS departed, (to_jsonb(g)->>'holder_departed_at') AS stamp, revoked_at IS NOT NULL AS revoked
  FROM grants g WHERE id = ${id}`))[0]!;
const active = (over: Record<string, unknown>) => insertGrantUnguarded(w, { activated_at: HOUR_AGO, ...over } as never);
const remove = (userId = w.user2Id) => M.removeOrgMember({}, { orgId: w.orgId, userId }, ctx(admin.id));

beforeEach(async () => {
  await cleanDb(db);
  w = await seedWorld();
  admin = await db.user.create({ data: { handle: `adm-${generateId().slice(0, 8)}` } });
  await db.orgMember.createMany({ data: [
    { organizationId: w.orgId, userId: admin.id, role: 'OWNER' },
    { organizationId: w.orgId, userId: w.user2Id, role: 'CONTRIBUTOR' },
  ] });
  org2 = await db.organization.create({ data: { name: 'o2', urn: `o2-${generateId().slice(0, 8)}.test` } });
  await db.orgMember.create({ data: { organizationId: org2.id, userId: w.user2Id, role: 'CONTRIBUTOR' } });
  const a2 = await db.app.create({ data: { organizationId: org2.id, name: 'o2-app', urn: `${org2.id}:app` } });
  orgApp2 = a2.id;
  personalApp = (await db.app.create({ data: { ownerUserId: w.user2Id, name: 'mine', urn: `mine-${generateId().slice(0, 8)}:app` } })).id;
});
afterAll(async () => { await cleanDb(db); await dropTestActions(); });

describe('P: the removal ends the person\'s grants in that organization\'s Apps, and nothing else', () => {
  it('P1/P2/P3/P4: both Apps of the org end (live and pending); another org, a user-owned App, another person, a worker and an agent stay', async () => {
    const live = await active({ user_id: w.user2Id, app_id: w.appId });
    const pending = await insertGrant(w, { user_id: w.user2Id, app_id: w.app2Id });
    const otherOrg = await active({ user_id: w.user2Id, app_id: orgApp2 });
    const personal = await active({ user_id: w.user2Id, app_id: personalApp });
    const otherPerson = await active({ user_id: w.userId, app_id: w.appId });
    const worker = await active({ user_id: null, worker_id: w.workerId });
    const agent = await active({ user_id: null, agent_id: w.agentId });
    await remove();
    expect((await row(live)).departed).toBe(true);
    expect((await row(pending)).departed).toBe(true);
    for (const id of [otherOrg, personal, otherPerson, worker, agent]) expect((await row(id)).departed, id).toBe(false);
  });

  it('P5: the first end stands: revoked, an earlier departure, expired and spent rows are not stamped anew', async () => {
    const revoked = await active({ user_id: w.user2Id, revoked_at: raw(DB_NOW), revoked_by: admin.id });
    const departed = await active({ user_id: w.user2Id, holder_departed_at: HOUR_AGO });
    const expired = await active({ user_id: w.user2Id, activated_at: raw(`${DB_NOW} - interval '3 hours'`), expires_at: HOUR_AGO });
    const spent = await active({ user_id: w.user2Id, max_uses: 1, use_count: 1 });
    const before = await row(departed);
    await remove();
    expect((await row(revoked)).departed).toBe(false);
    expect((await row(departed)).stamp).toBe(before.stamp);
    expect((await row(expired)).departed).toBe(false);
    expect((await row(spent)).departed).toBe(false);
  });

  it('P6: rejoining revives nothing (the stamp stays; a new grant must be issued)', async () => {
    const id = await active({ user_id: w.user2Id });
    await remove();
    const stamp = (await row(id)).stamp;
    await M.addOrgMember({}, { orgId: w.orgId, userId: w.user2Id, role: 'CONTRIBUTOR' }, ctx(admin.id));
    expect(await db.orgMember.count({ where: { organizationId: w.orgId, userId: w.user2Id, deletedAt: null } })).toBe(1);
    expect(await row(id)).toMatchObject({ departed: true, stamp });
  });

  it('P7: self-removal by an admin ends the admin\'s own grants the same way', async () => {
    await db.orgMember.update({ where: { organizationId_userId: { organizationId: w.orgId, userId: w.user2Id } }, data: { role: 'ADMIN' } });
    const id = await active({ user_id: w.user2Id });
    await M.removeOrgMember({}, { orgId: w.orgId, userId: w.user2Id }, ctx(w.user2Id));
    expect((await row(id)).departed).toBe(true);
  });

  it('P9: a second removal is the idempotent no-op and moves nothing', async () => {
    const id = await active({ user_id: w.user2Id });
    await remove();
    const first = await row(id);
    await remove();
    expect(await row(id)).toEqual(first);
  });
});

describe('N: refusals and rollback end nothing', () => {
  it('N1: the last-owner refusal ends nothing', async () => {
    const id = await active({ user_id: admin.id });
    await expect(remove(admin.id)).rejects.toThrow(/last owner/i);
    expect((await row(id)).departed).toBe(false);
    expect(await db.orgMember.count({ where: { organizationId: w.orgId, userId: admin.id, deletedAt: null } })).toBe(1);
  });

  it('N2: a caller who may not remove ends nothing', async () => {
    const id = await active({ user_id: w.user2Id });
    await expect(M.removeOrgMember({}, { orgId: w.orgId, userId: w.user2Id }, ctx(w.userId))).rejects.toThrow();
    expect((await row(id)).departed).toBe(false);
  });

  it('N3: a failure AFTER the departure rolls the membership and the stamp back together', async () => {
    const id = await active({ user_id: w.user2Id });
    await expect(db.$transaction(async (tx) => {
      await tx.orgMember.update({ where: { organizationId_userId: { organizationId: w.orgId, userId: w.user2Id } }, data: { deletedAt: new Date() } });
      await endHeldGrants(tx, 'user', w.user2Id, { organizationId: w.orgId });
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect((await row(id)).departed).toBe(false);
    expect(await db.orgMember.count({ where: { organizationId: w.orgId, userId: w.user2Id, deletedAt: null } })).toBe(1);
  });
});

describe('K: the helper and the SQL cause', () => {
  it('K1: the scoped call before the membership is removed is refused by the guard (the person is still a live member)', async () => {
    await active({ user_id: w.user2Id });
    await expect(db.$transaction((tx) => endHeldGrants(tx, 'user', w.user2Id, { organizationId: w.orgId }))).rejects.toThrow(/append-only/);
  });

  it('K2: the scope is the organization: a membership removed in org A ends only org A\'s grants even when called for org B\'s id', async () => {
    const a = await active({ user_id: w.user2Id, app_id: w.appId });
    const b = await active({ user_id: w.user2Id, app_id: orgApp2 });
    await db.orgMember.update({ where: { organizationId_userId: { organizationId: w.orgId, userId: w.user2Id } }, data: { deletedAt: new Date() } });
    await db.$transaction((tx) => endHeldGrants(tx, 'user', w.user2Id, { organizationId: w.orgId }));
    expect((await row(a)).departed).toBe(true);
    expect((await row(b)).departed).toBe(false);
  });
});

describe('G: the database guard\'s person arm, against a real guarded UPDATE (bare stamps)', () => {
  const stamp = (id: string) => db.$executeRawUnsafe(`UPDATE grants SET holder_departed_at = ${DB_NOW} WHERE id = $1`, id);
  const member = (userId = w.user2Id) => ({ organizationId_userId: { organizationId: w.orgId, userId } });
  it('G1: a live member of the grant App\'s organization: refused', async () => {
    await expect(stamp(await active({ user_id: w.user2Id }))).rejects.toThrow(/append-only/);
  });
  it('G2/G3: membership soft-deleted, or no membership row at all: admitted', async () => {
    const a = await active({ user_id: w.user2Id });
    await db.orgMember.update({ where: member(), data: { deletedAt: new Date() } });
    await expect(stamp(a)).resolves.toBe(1);
    const b = await active({ user_id: w.userId });
    await expect(stamp(b)).resolves.toBe(1); // w.userId never joined any organization
  });
  it('G4: live only in ANOTHER organization admits; live in the grant App\'s organization (absent elsewhere) refuses', async () => {
    await db.orgMember.update({ where: member(), data: { deletedAt: new Date() } });
    await expect(stamp(await active({ user_id: w.user2Id, app_id: w.appId }))).resolves.toBe(1); // still live in org2
    await db.orgMember.update({ where: member(), data: { deletedAt: null } });
    await db.orgMember.delete({ where: { organizationId_userId: { organizationId: org2.id, userId: w.user2Id } } });
    await expect(stamp(await active({ user_id: w.user2Id, app_id: w.appId }))).rejects.toThrow(/append-only/);
  });
  it('G5: a user-owned App has no org leave: a live person\'s stamp stays refused', async () => {
    await expect(stamp(await active({ user_id: w.user2Id, app_id: personalApp }))).rejects.toThrow(/append-only/);
  });
  it('G6/G7: an erased person admits as before; a revoked or already departed row is still refused (first end)', async () => {
    const erased = await active({ user_id: w.user2Id });
    await db.user.update({ where: { id: w.user2Id }, data: { deletedAt: new Date() } });
    await expect(stamp(erased)).resolves.toBe(1);
    const revoked = await active({ user_id: w.user2Id, revoked_at: raw(DB_NOW), revoked_by: admin.id });
    await expect(stamp(revoked)).rejects.toThrow(/append-only/);
    await expect(stamp(erased)).rejects.toThrow(/append-only/);
  });
});

// #4210 §10 (Rodolfo): a grant that EXPIRES while the door waits on its row lock keeps its expiry, not a departure stamp.
describe('expiry while the door waits on the grant row', () => {
  it('a grant expiring while the org leave waits on its row is not stamped', async () => {
    const id = await active({ user_id: w.user2Id, app_id: w.appId, activated_at: raw(`${DB_NOW} - interval '2 hours'`), expires_at: raw(`${DB_NOW} + interval '2 seconds'`) });
    let release!: () => void; let locked!: () => void;
    const lockedP = new Promise<void>((r) => { locked = r; }); const releaseP = new Promise<void>((r) => { release = r; });
    const blocker = db.$transaction(async (tx) => { await tx.$queryRaw`SELECT id FROM grants WHERE id = ${id} FOR UPDATE`; locked(); await releaseP; }, { timeout: 20_000 });
    await lockedP;
    const p = remove();
    try { await waitForLockWaiters(db as any); await new Promise((r) => setTimeout(r, 2600)); } finally { release(); }
    await blocker; await p;
    expect((await row(id)).departed).toBe(false);
  }, 30_000);
});

// #4210 (gate on #4171: "transaction/lock order against grant issue/use and rejoin", unclaimed at e8c200e7). Person-held issue is
// unreachable from the current creator (gate selections), so the interleaves are a USE and a REJOIN racing a leave that is in flight.
describe('#4210 interleaves: a move racing an org leave that is in flight', () => {
  /** Start the leave and hold it at its grant lock phase (a blocker holds `blockerId`). */
  async function leaveHeldAtGrantLocks(blockerId: string) {
    let release!: () => void; let locked!: () => void;
    const lockedP = new Promise<void>((r) => { locked = r; }); const releaseP = new Promise<void>((r) => { release = r; });
    const blocker = db.$transaction(async (tx) => { await tx.$queryRaw`SELECT id FROM grants WHERE id = ${blockerId} FOR UPDATE`; locked(); await releaseP; }, { timeout: 20_000 });
    await lockedP;
    const door = remove();
    await waitForLockWaiters(db as any);
    return { done: async () => { release(); await blocker; return door; } };
  }

  it('USE first: a use holding the grant row counts, and the leave then ends the grant', async () => {
    const g = await active({ user_id: w.user2Id, app_id: w.appId, max_uses: 3 });
    let release!: () => void; let locked!: () => void;
    const lockedP = new Promise<void>((r) => { locked = r; }); const releaseP = new Promise<void>((r) => { release = r; });
    const use = db.$transaction(async (tx) => {
      const live = await readGrantForUpdate(tx, g); locked(); await releaseP;
      return live?.live ? chargeGrantUse(tx, g, w.appId) : false;
    }, { timeout: 20_000 });
    await lockedP;
    const door = remove();
    try { await waitForLockWaiters(db as any); } finally { release(); }
    expect(await use).toBe(true);
    await door;
    const [r] = await db.$queryRaw<Array<{ use_count: number; departed: boolean }>>(Prisma.sql`
      SELECT use_count, holder_departed_at IS NOT NULL AS departed FROM grants WHERE id = ${g}`);
    expect(r).toEqual({ use_count: 1, departed: true });
  }, 30_000);

  it('USE after: a use waiting behind the in-flight leave is refused once it commits', async () => {
    const g = await active({ user_id: w.user2Id, app_id: w.appId, max_uses: 3 });
    const { done } = await leaveHeldAtGrantLocks(g);
    const use = db.$transaction(async (tx) => { const live = await readGrantForUpdate(tx, g); return live?.live ? chargeGrantUse(tx, g, w.appId) : false; }, { timeout: 20_000 });
    await waitForLockWaiters(db as any, 2);
    await done();
    expect(await use).toBe(false);
    expect(await row(g)).toMatchObject({ departed: true });
  }, 30_000);

  it('REJOIN: a rejoin racing the in-flight leave revives nothing: the grant ends either way', async () => {
    const g = await active({ user_id: w.user2Id, app_id: w.appId });
    const { done } = await leaveHeldAtGrantLocks(g);
    // The real rejoin door, while the leave is in flight: it lands before or after the leave commits, never in between.
    const rejoin = M.addOrgMember({}, { orgId: w.orgId, userId: w.user2Id, role: 'CONTRIBUTOR' }, ctx(admin.id))
      .then(() => 'rejoined', (e: Error) => e.message);
    await new Promise((r) => setTimeout(r, 200));
    await done();
    await rejoin;
    expect(await row(g)).toMatchObject({ departed: true });
  }, 30_000);
});
