/**
 * #3668 S1a — the person links of a grant row under account merge and erasure.
 *  - cor:acl:140:08: erasing the ISSUER removes the link and keeps the reason.
 *  - mergeUsers rewrites the CURRENT holder, issuer, requester, revoker and verifier links to the survivor, with explicit
 *    old/new identity checks; grant_events actors stay sealed; a merge never moves a row to another App.
 *  - Holder erasure is UNSELECTED (cor:acl:140:08 Open, all holder kinds). RESTRICT is INTERIM referential integrity on empty
 *    tables (gate 6712456240), pinned here as what the database does today, NOT as the erasure rule.
 */
import { beforeEach, afterAll, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { mergeUsers } from '../../test/mergeConsent.js';
import { deleteUserAccount } from '../../controller/operations/deleteUser.js';
import { dropTestActions, insertEvent, insertGrant, insertGrantUnguarded, seedWorld, type World } from './grantFixtures3668.js';

let w: World;
beforeEach(async () => { await cleanDb(db); w = await seedWorld(); });
afterAll(async () => { await cleanDb(db); await dropTestActions(); });
type G = { id: string; app_id: string; user_id: string | null; issuer_user_id: string | null; requested_by_user_id: string | null; revoked_by: string | null; verified_by: string | null; reason: string };
const read = (id: string) => db.$queryRawUnsafe<G[]>(`SELECT id, app_id, user_id, issuer_user_id, requested_by_user_id, revoked_by, verified_by, reason FROM grants WHERE id = $1`, id).then((r) => r[0]);

describe('deleteUser', () => {
  it('erasing the issuer nulls issuer_user_id, keeps the reason, and leaves the grant otherwise as it was', async () => {
    const id = await insertGrant(w, { user_id: null, agent_id: w.agentId, issuer_user_id: w.user2Id, reason: 'kept words' });
    await deleteUserAccount(db, { targetUserId: w.user2Id, actorUserId: w.user2Id });
    expect(await read(id)).toMatchObject({ id, issuer_user_id: null, reason: 'kept words', app_id: w.appId });
  });
  it('erasing someone else leaves the issuer link', async () => {
    const id = await insertGrant(w, { user_id: null, agent_id: w.agentId, issuer_user_id: w.user2Id });
    await deleteUserAccount(db, { targetUserId: w.userId, actorUserId: w.userId });
    expect((await read(id)).issuer_user_id).toBe(w.user2Id);
  });
  it('INTERIM, not the holder-erasure rule (cor:acl:140:08 Open): erasure that would hard-delete a HOLDER is refused whole by the RESTRICT foreign key, with no partial write', async () => {
    // deleteUser hard-deletes the erased person's own Agents; one of them holds a grant, and the person issued another.
    const agent = await db.agent.create({ data: { ownerUserId: w.user2Id, name: 'owned-agent', urn: `hrn:agent:owned-${w.user2Id}` } as never });
    const held = await insertGrant(w, { user_id: null, agent_id: agent.id });
    const issued = await insertGrant(w, { issuer_user_id: w.user2Id });
    await expect(deleteUserAccount(db, { targetUserId: w.user2Id, actorUserId: w.user2Id })).rejects.toThrow();
    expect((await db.user.findUniqueOrThrow({ where: { id: w.user2Id } })).deletedAt).toBeNull();
    expect(await db.agent.count({ where: { id: agent.id } })).toBe(1);
    expect(await read(held)).toMatchObject({ id: held });
    expect((await read(issued)).issuer_user_id).toBe(w.user2Id); // the issuer nulling rolled back with the rest
  });
});

describe('mergeUsers', () => {
  it('moves every current person link from the source to the survivor, and only that source\'s', async () => {
    const third = await db.user.create({ data: { handle: 'g3-third' } });
    const mine = await insertGrantUnguarded(w, {
      user_id: w.userId, issuer_user_id: w.userId, requested_by_user_id: w.userId, revoked_at: new Date('2026-01-01'), revoked_by: w.userId, activated_at: new Date('2026-01-01'), verified_by: w.userId,
    });
    const others = await insertGrantUnguarded(w, { user_id: third.id, issuer_user_id: third.id, requested_by_user_id: third.id, revoked_at: new Date('2026-01-01'), revoked_by: third.id, activated_at: new Date('2026-01-01'), verified_by: third.id });
    await mergeUsers(db, { sourceUserId: w.userId, targetUserId: w.user2Id });
    expect(await read(mine)).toMatchObject({ user_id: w.user2Id, issuer_user_id: w.user2Id, requested_by_user_id: w.user2Id, revoked_by: w.user2Id, verified_by: w.user2Id, app_id: w.appId });
    expect(await read(others)).toMatchObject({ user_id: third.id, issuer_user_id: third.id, requested_by_user_id: third.id, revoked_by: third.id, verified_by: third.id });
  });
  it('never moves a row to another App, and leaves the row\'s terms alone', async () => {
    const id = await insertGrant(w, { user_id: w.userId, reason: 'same words' });
    await mergeUsers(db, { sourceUserId: w.userId, targetUserId: w.user2Id });
    expect(await read(id)).toMatchObject({ app_id: w.appId, reason: 'same words' });
  });
  it('seals event actors: a merge does not rewrite grant_events.actor_user_id', async () => {
    const g = await insertGrant(w);
    const e = await insertEvent(w, g, { actor_user_id: w.userId });
    await mergeUsers(db, { sourceUserId: w.userId, targetUserId: w.user2Id });
    expect((await db.$queryRawUnsafe<Array<{ actor_user_id: string }>>(`SELECT actor_user_id FROM grant_events WHERE id = $1`, e))[0].actor_user_id).toBe(w.userId);
  });
});
