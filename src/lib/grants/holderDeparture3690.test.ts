/**
 * #3690 S2a-h — what happens to a grant when its HOLDER goes (cor:acl:140:03 Moves and How It Ends, :01 Relationships, :08;
 * rulings 0255 item 3 and 0259), tested at the database and through the person-erasure door. The grant ENDS and allows
 * nothing, its record STAYS, and the row keeps WHICH KIND of holder it had. An erased issuer's link goes only on an actual
 * erasure; an event is bound to its grant's App; a soft-deleted scope App allows nothing.
 *
 * Red on main: every holder FK is RESTRICT (the S1a interim), so each departure below is refused.
 */
import { beforeEach, afterAll, describe, expect, it } from 'vitest';
import { Prisma } from '../../generated/prisma/index.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { deleteUserAccount } from '../../controller/operations/deleteUser.js';
import { generateId } from '../id.js';
import { DB_NOW, dropTestActions, insertEvent, insertGrant, insertGrantUnguarded, raw, seedWorld, type World } from './grantFixtures3668.js';
import { grantLiveSql, isGrantLive } from './live.js';

let w: World;
beforeEach(async () => { await cleanDb(db); w = await seedWorld(); });
afterAll(async () => { await cleanDb(db); await dropTestActions(); });

const refused = (p: Promise<unknown>, pattern: RegExp) => expect(p).rejects.toThrow(pattern);
const exec = (sql: string, ...params: unknown[]) => db.$executeRawUnsafe(sql, ...params);
const HOURS_AGO = raw(`${DB_NOW} - interval '1 hour'`);

/** An ACTIVE grant (no shipped path makes one yet): the only way a departure is observable as "live -> not live". */
const activeGrant = (over: Record<string, unknown> = {}) => insertGrantUnguarded(w, { activated_at: HOURS_AGO, ...over } as never);

type Row = {
  id: string; app_id: string; user_id: string | null; agent_id: string | null; worker_id: string | null; grantee_app_id: string | null;
  issuer_user_id: string | null; reason: string; holder_departed_at: string | null; revoked_at: Date | null; live: boolean;
};
const read = async (id: string): Promise<Row | undefined> => (await db.$queryRaw<Row[]>(Prisma.sql`
  SELECT g.id, g.app_id, g.user_id, g.agent_id, g.worker_id, g.grantee_app_id, g.issuer_user_id, g.reason, (to_jsonb(g)->>'holder_departed_at') AS holder_departed_at,
    g.revoked_at, ${grantLiveSql('g')} AS live FROM grants g WHERE g.id = ${id}`))[0];

/** The four holder kinds, each with how to hard-delete the holder and which column keeps its sealed id. */
const KINDS: Array<{ kind: string; col: 'user_id' | 'agent_id' | 'worker_id' | 'grantee_app_id'; id: () => string; del: () => Promise<unknown> }> = [
  { kind: 'person', col: 'user_id', id: () => w.user2Id, del: () => db.user.delete({ where: { id: w.user2Id } }) },
  { kind: 'agent', col: 'agent_id', id: () => w.agentId, del: async () => { await db.worker.deleteMany({ where: { agentId: w.agentId } }); await db.agent.delete({ where: { id: w.agentId } }); } },
  { kind: 'worker', col: 'worker_id', id: () => w.workerId, del: () => db.worker.delete({ where: { id: w.workerId } }) },
  { kind: 'App', col: 'grantee_app_id', id: () => w.app2Id, del: () => db.app.delete({ where: { id: w.app2Id } }) },
];

describe('1/8: a holder that goes ends its grant; the record stays and keeps the kind of holder', () => {
  for (const k of KINDS) {
    it(`a hard-deleted ${k.kind} holder: the row stays, is no longer live, the departure is stamped and the sealed id stays`, async () => {
      const id = await activeGrant({ user_id: null, [k.col]: k.id() });
      expect((await read(id))?.live).toBe(true);
      await k.del();
      const row = await read(id);
      expect(row).toBeTruthy();
      expect(row!.live).toBe(false);
      expect(row!.holder_departed_at).not.toBeNull();
      // The kind is kept: exactly one holder column is set, and it is the one the grant had.
      const held = (['user_id', 'agent_id', 'worker_id', 'grantee_app_id'] as const).filter((c) => row![c] !== null);
      expect(held).toEqual([k.col]);
      expect(row![k.col]).toBe(k.id());
    });
  }
  it('a PENDING grant of a departed holder is ended too (it was never live, and now it can never become live)', async () => {
    const id = await insertGrant(w, { user_id: null, worker_id: w.workerId });
    await db.worker.delete({ where: { id: w.workerId } });
    expect((await read(id))!.holder_departed_at).not.toBeNull();
  });
  it('raw SQL deletes (the owner-rename reclaim path) end the grant as well: the mechanism is in the database, not a list of code paths', async () => {
    const id = await activeGrant({ user_id: null, agent_id: w.agentId });
    await db.worker.deleteMany({ where: { agentId: w.agentId } });
    await exec('DELETE FROM agents WHERE id = $1', w.agentId);
    expect(await read(id)).toMatchObject({ live: false, agent_id: w.agentId });
    expect((await read(id))!.holder_departed_at).not.toBeNull();
  });
  it('another holder of the same kind is untouched (the departure is scoped to the one that went)', async () => {
    const other = await db.worker.create({ data: { appId: w.appId, agentId: w.agentId, name: 'o', slug: 'o', signature: 's', trailer: 't' } });
    const mine = await activeGrant({ user_id: null, worker_id: w.workerId });
    const theirs = await activeGrant({ user_id: null, worker_id: other.id });
    await db.worker.delete({ where: { id: w.workerId } });
    expect((await read(mine))!.live).toBe(false);
    expect(await read(theirs)).toMatchObject({ live: true, holder_departed_at: null });
  });
  it('a grant already revoked keeps its first end: the departure does not stamp it', async () => {
    const id = await activeGrant({ user_id: null, worker_id: w.workerId, revoked_at: raw(DB_NOW), revoked_by: w.userId });
    await db.worker.delete({ where: { id: w.workerId } });
    expect(await read(id)).toMatchObject({ holder_departed_at: null });
  });
});

describe('the first end stands: an already expired or spent grant is not stamped (LOCAL/second-review P2, ae23ac1d)', () => {
  const ENDED: Array<[string, Record<string, unknown>]> = [
    ['expired a minute ago', { expires_at: raw(`${DB_NOW} - interval '1 minute'`), starts_at: raw(`${DB_NOW} - interval '2 hours'`) }],
    ['spent (use_count at max_uses)', { max_uses: 1, use_count: 1 }],
  ];
  for (const [name, over] of ENDED) {
    it(`${name}: a hard worker delete leaves holder_departed_at NULL, while an open grant of the same worker is stamped`, async () => {
      const ended = await activeGrant({ user_id: null, worker_id: w.workerId, ...over });
      const open = await activeGrant({ user_id: null, worker_id: w.workerId });
      expect((await read(ended))!.live).toBe(false);
      await db.worker.delete({ where: { id: w.workerId } });
      expect((await read(open))!.holder_departed_at).not.toBeNull();
      expect((await read(ended))!.holder_departed_at).toBeNull();
    });
  }
});

describe('5: the end happens once, and nothing re-points the holder', () => {
  it('the departure stamp is set once: it cannot be cleared, re-stamped, or set on a revoked row', async () => {
    const id = await activeGrant({ user_id: null, worker_id: w.workerId });
    await db.worker.delete({ where: { id: w.workerId } });
    await refused(exec('UPDATE grants SET holder_departed_at = NULL WHERE id = $1', id), /grants are append-only/);
    await refused(exec(`UPDATE grants SET holder_departed_at = ${DB_NOW} WHERE id = $1`, id), /grants are append-only/);
    const revoked = await activeGrant({ user_id: null, agent_id: w.agentId, revoked_at: raw(DB_NOW), revoked_by: w.userId });
    await refused(exec(`UPDATE grants SET holder_departed_at = ${DB_NOW} WHERE id = $1`, revoked), /grants are append-only/);
  });
  it('an ended grant cannot be re-pointed at another holder of any kind, or another user', async () => {
    const id = await activeGrant({ user_id: null, worker_id: w.workerId });
    await db.worker.delete({ where: { id: w.workerId } });
    const other = await db.worker.create({ data: { appId: w.appId, agentId: w.agentId, name: 'o', slug: 'o2', signature: 's', trailer: 't' } });
    await refused(exec('UPDATE grants SET worker_id = $2 WHERE id = $1', id, other.id), /grants are append-only/);
    await refused(exec('UPDATE grants SET worker_id = NULL, user_id = $2 WHERE id = $1', id, w.userId), /grants are append-only/);
    expect((await read(id))!.worker_id).toBe(w.workerId);
  });
});

describe('a departure stamp needs its cause: the sealed holder has actually gone', () => {
  const stamp = (id: string) => exec(`UPDATE grants SET holder_departed_at = ${DB_NOW} WHERE id = $1`, id);
  it('a bare stamp on a grant whose holder is still there is refused, for every holder kind', async () => {
    for (const k of KINDS) {
      const id = await activeGrant({ user_id: null, [k.col]: k.id() });
      await refused(stamp(id), /grants are append-only/);
      expect((await read(id))!.holder_departed_at).toBeNull();
    }
  });
  it('the same stamp is accepted once the holder is soft-deleted (or retired), the cause the doors have', async () => {
    const worker = await activeGrant({ user_id: null, worker_id: w.workerId });
    await refused(stamp(worker), /grants are append-only/);
    await db.worker.update({ where: { id: w.workerId }, data: { retiredAt: new Date() } });
    await stamp(worker);
    const app = await activeGrant({ user_id: null, grantee_app_id: w.app2Id });
    await db.app.update({ where: { id: w.app2Id }, data: { deletedAt: new Date() } });
    await stamp(app);
    expect((await read(worker))!.live).toBe(false);
    expect((await read(app))!.holder_departed_at).not.toBeNull();
  });
});

describe('2/10: person erasure ends what the person HOLDS and leaves what the person ISSUED', () => {
  it('held by the erased person: ended (not live, stamped). Issued by them: still live, issuer link gone', async () => {
    const held = await activeGrant({ user_id: w.user2Id, issuer_user_id: w.userId });
    const issued = await activeGrant({ user_id: null, agent_id: w.agentId, issuer_user_id: w.user2Id, reason: 'kept words' });
    await deleteUserAccount(db, { targetUserId: w.user2Id, actorUserId: w.user2Id });
    expect(await read(held)).toMatchObject({ live: false, user_id: w.user2Id, issuer_user_id: w.userId });
    expect((await read(held))!.holder_departed_at).not.toBeNull();
    expect(await read(issued)).toMatchObject({ live: true, issuer_user_id: null, reason: 'kept words', holder_departed_at: null });
  });
  it('one person both the holder and the issuer of a row: the row ends AND loses the issuer link', async () => {
    const id = await activeGrant({ user_id: w.user2Id, issuer_user_id: w.user2Id });
    await deleteUserAccount(db, { targetUserId: w.user2Id, actorUserId: w.user2Id });
    expect(await read(id)).toMatchObject({ live: false, issuer_user_id: null });
    expect((await read(id))!.holder_departed_at).not.toBeNull();
  });
  it('erasure no longer fails whole when an owned Agent, Worker or App is a holder: every kind ends, the person is erased', async () => {
    const agent = await db.agent.create({ data: { ownerUserId: w.user2Id, name: 'owned-agent', urn: `hrn:agent:owned-${w.user2Id}` } as never });
    const app = await db.app.create({ data: { ownerUserId: w.user2Id, name: 'owned-app', urn: `owned-${w.user2Id}:app` } });
    const ids = [
      await activeGrant({ user_id: null, agent_id: agent.id }),
      await activeGrant({ user_id: null, grantee_app_id: app.id }),
      await activeGrant({ user_id: w.user2Id }),
    ];
    await deleteUserAccount(db, { targetUserId: w.user2Id, actorUserId: w.user2Id });
    expect((await db.user.findUniqueOrThrow({ where: { id: w.user2Id } })).deletedAt).not.toBeNull();
    for (const id of ids) {
      const row = await read(id);
      expect(row).toBeTruthy();
      expect(row!.live).toBe(false);
      expect(row!.holder_departed_at).not.toBeNull();
    }
  });
  it('a grant that never involved the erased person is untouched', async () => {
    const id = await activeGrant({ user_id: w.userId, issuer_user_id: w.userId });
    await deleteUserAccount(db, { targetUserId: w.user2Id, actorUserId: w.user2Id });
    expect(await read(id)).toMatchObject({ live: true, issuer_user_id: w.userId, holder_departed_at: null });
  });
});

describe('3: the issuer link goes only on an actual erasure', () => {
  it('nulling issuer_user_id of a LIVE person is refused by the database; after the soft delete, or a hard delete, it goes', async () => {
    const id = await insertGrant(w, { user_id: null, agent_id: w.agentId, issuer_user_id: w.user2Id });
    await refused(exec('UPDATE grants SET issuer_user_id = NULL WHERE id = $1', id), /grants are append-only/);
    expect((await read(id))!.issuer_user_id).toBe(w.user2Id);
    await db.user.update({ where: { id: w.user2Id }, data: { deletedAt: new Date() } });
    await exec('UPDATE grants SET issuer_user_id = NULL WHERE id = $1', id);
    expect((await read(id))!.issuer_user_id).toBeNull();
    const hard = await insertGrant(w, { user_id: null, agent_id: w.agentId, issuer_user_id: w.userId });
    await db.user.delete({ where: { id: w.userId } });
    expect((await read(hard))!.issuer_user_id).toBeNull();
  });
});

describe('4: an event is bound to its grant\'s App', () => {
  it('an event whose app_id differs from its grant\'s is refused; the matching one passes; an unknown grant is refused', async () => {
    const id = await insertGrant(w);
    await refused(insertEvent(w, id, { app_id: w.app2Id }), /grant event|grants/i);
    await insertEvent(w, id);
    await refused(insertEvent(w, generateId()), /grant event|grants/i);
  });
});

describe('6: App deletion still deletes its grants and events', () => {
  it('the scope App\'s hard delete takes grants and events, including a grant whose holder is a worker of that App', async () => {
    const id = await insertGrant(w, { user_id: null, worker_id: w.workerId });
    await insertEvent(w, id);
    await db.app.delete({ where: { id: w.appId } });
    expect(await db.$queryRawUnsafe('SELECT id FROM grants')).toHaveLength(0);
    expect(await db.$queryRawUnsafe('SELECT id FROM grant_events')).toHaveLength(0);
  });
  it('an App that is BOTH a grant\'s scope and its holder deletes cleanly', async () => {
    await insertGrant(w, { user_id: null, grantee_app_id: w.appId });
    await db.app.delete({ where: { id: w.appId } });
    expect(await db.$queryRawUnsafe('SELECT id FROM grants')).toHaveLength(0);
  });
});

describe('9: a soft-deleted scope App allows nothing', () => {
  it('the SQL fragment and the in-memory function agree: live until the App is soft-deleted, not live after', async () => {
    const id = await activeGrant({});
    expect((await read(id))!.live).toBe(true);
    await db.app.update({ where: { id: w.appId }, data: { deletedAt: new Date() } });
    expect((await read(id))!.live).toBe(false);
    const fields = { activatedAt: new Date(0), revokedAt: null, startsAt: null, expiresAt: null, maxUses: null, useCount: 0, holderDepartedAt: null };
    expect(isGrantLive({ ...fields, appDeletedAt: null }, new Date())).toBe(true);
    expect(isGrantLive({ ...fields, appDeletedAt: new Date() }, new Date())).toBe(false);
    expect(isGrantLive({ ...fields, appDeletedAt: null, holderDepartedAt: new Date() }, new Date())).toBe(false);
  });
});

describe('a grant cannot be inserted for a holder that does not exist or has already gone', () => {
  it('a missing worker, agent or App holder, and a soft-deleted agent, App, person or a retired worker are refused', async () => {
    await refused(insertGrant(w, { user_id: null, worker_id: generateId() }), /holder/i);
    await refused(insertGrant(w, { user_id: null, agent_id: generateId() }), /holder/i);
    await refused(insertGrant(w, { user_id: null, grantee_app_id: generateId() }), /holder/i);
    await refused(insertGrant(w, { user_id: generateId() }), /holder/i);
    await db.agent.update({ where: { id: w.agentId }, data: { deletedAt: new Date() } });
    await refused(insertGrant(w, { user_id: null, agent_id: w.agentId }), /holder/i);
    await db.app.update({ where: { id: w.app2Id }, data: { deletedAt: new Date() } });
    await refused(insertGrant(w, { user_id: null, grantee_app_id: w.app2Id }), /holder/i);
    await db.user.update({ where: { id: w.user2Id }, data: { deletedAt: new Date() } });
    await refused(insertGrant(w, { user_id: w.user2Id }), /holder/i);
    await db.worker.update({ where: { id: w.workerId }, data: { retiredAt: new Date() } });
    await refused(insertGrant(w, { user_id: null, worker_id: w.workerId }), /holder/i);
    expect(await db.$queryRawUnsafe('SELECT id FROM grants')).toHaveLength(0);
  });
});
