/**
 * #4180 (Holger R5, cor:acl:140:03; Victor's FIT on the issue): a grant records WHY its holder went, as a cause code with no
 * wording, set in the very statement that stamps the departure and never afterwards. The per-door causes are pinned in the
 * departure suites (#3690, #4171, #4172) and the read surfaces in resolvers.grantManager3711.test.ts; this file pins the database
 * half: the guard and the shape CHECK, and the defined value for a departure stamped before causes were kept (never a guess).
 *
 * Expand-safe (the migration header): the previous image stamps departures with no cause, so a stamp without one is still admitted
 * and reads REASON_NOT_RECORDED.
 */
import { beforeEach, afterAll, describe, expect, it } from 'vitest';
import { Prisma } from '../../generated/prisma/index.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { DB_NOW, dropTestActions, insertGrant, insertGrantUnguarded, raw, seedWorld, type World } from './grantFixtures3668.js';
import { endHeldGrants } from './departure.js';
import { endGrantsOfAgentsNoLongerInstalled } from './agentInstallDeparture.js';
import { listGrantsForManager } from './read.js';

let w: World;
beforeEach(async () => { await cleanDb(db); w = await seedWorld(); });
afterAll(async () => { await cleanDb(db); await dropTestActions(); });

const exec = (sql: string, ...params: unknown[]) => db.$executeRawUnsafe(sql, ...params);
// Which layer refuses (Antonio P3): the guard trigger runs BEFORE the row CHECK, so a pin that names one asserts that one.
const GUARD = /grants are append-only/;
const CHECK = /chk_grants_shape/;
const EITHER = /grants are append-only|chk_grants_shape/;
const refused = (p: Promise<unknown>, by: RegExp = GUARD) => expect(p).rejects.toThrow(by);
const active = (over: Record<string, unknown> = {}) => insertGrantUnguarded(w, { activated_at: raw(`${DB_NOW} - interval '1 hour'`), ...over } as never);
const cause = async (id: string) => (await db.$queryRaw<Array<{ c: string | null }>>(Prisma.sql`
  SELECT holder_departure_reason AS c FROM grants WHERE id = ${id}`))[0]!.c;
const retire = (workerId = w.workerId) => db.worker.update({ where: { id: workerId }, data: { retiredAt: new Date() } });
const STAMP = `UPDATE grants SET holder_departed_at = ${DB_NOW}`;

describe('#4180: the cause is a fact of the departure, set with the stamp and never otherwise', () => {
  it('a grant cannot arrive with a cause', async () => {
    await refused(insertGrant(w, { user_id: null, worker_id: w.workerId, holder_departure_reason: 'WORKER_RETIRED' }), CHECK);
  });

  it('a cause cannot be written on a grant whose holder has not gone (no stamp in the same statement)', async () => {
    const id = await active({ user_id: null, worker_id: w.workerId });
    await refused(exec(`UPDATE grants SET holder_departure_reason = 'WORKER_RETIRED' WHERE id = $1`, id));
    await retire();
    await refused(exec(`UPDATE grants SET holder_departure_reason = 'WORKER_RETIRED' WHERE id = $1`, id)); // the holder went, the row did not
    expect(await cause(id)).toBeNull();
  });

  it('the first end\'s cause stands: it cannot be changed, cleared, or added later to a row stamped without one', async () => {
    const id = await active({ user_id: null, worker_id: w.workerId });
    await retire();
    await exec(`${STAMP}, holder_departure_reason = 'WORKER_RETIRED' WHERE id = $1`, id);
    expect(await cause(id)).toBe('WORKER_RETIRED');
    await refused(exec(`UPDATE grants SET holder_departure_reason = 'WORKER_DELETED' WHERE id = $1`, id));
    await refused(exec(`UPDATE grants SET holder_departure_reason = NULL WHERE id = $1`, id));
    const bare = await active({ user_id: null, worker_id: w.workerId });
    await exec(`${STAMP} WHERE id = $1`, bare); // the previous image's departure: a stamp with no cause (expand-safe)
    expect(await cause(bare)).toBeNull();
    await refused(exec(`UPDATE grants SET holder_departure_reason = 'WORKER_RETIRED' WHERE id = $1`, bare));
  });

  it('a cause must belong to the holder\'s kind, and an unknown code is refused', async () => {
    const id = await active({ user_id: null, worker_id: w.workerId });
    await retire();
    for (const wrong of ['USER_ERASED', 'ORG_LEFT', 'AGENT_DELETED', 'APP_DELETED', 'GUESSED', 'SECRET_DELETED', 'REASON_NOT_RECORDED', '']) {
      // A code of another kind that the evidence clauses also contradict is refused by the guard first; one they do not is the CHECK's.
      await refused(exec(`${STAMP}, holder_departure_reason = $2 WHERE id = $1`, id, wrong), EITHER);
    }
    await refused(exec(`${STAMP}, holder_departure_reason = 'GUESSED' WHERE id = $1`, id), CHECK);
    await refused(exec(`${STAMP}, holder_departure_reason = 'APP_DELETED' WHERE id = $1`, id), CHECK);
    // #4180: the two lapse causes are an agent's only (cause_fits requires a live agent, and the CHECK the agent kind).
    for (const agentOnly of ['ORG_DELETED', 'AGENT_LICENSE_EXPIRED']) await refused(exec(`${STAMP}, holder_departure_reason = $2 WHERE id = $1`, id, agentOnly), EITHER);
    expect(await cause(id)).toBeNull();
  });

  it('the CHECK\'s per-kind arms: a person\'s grant takes no App, worker or agent cause (Rodolfo SEC10 P3)', async () => {
    const id = await active({ user_id: w.user2Id });
    await db.user.update({ where: { id: w.user2Id }, data: { deletedAt: new Date() } });
    // APP_DELETED passes every evidence clause (it names no person), so only chk_grants_shape's user arm refuses it.
    await refused(exec(`${STAMP}, holder_departure_reason = 'APP_DELETED' WHERE id = $1`, id), CHECK);
    await refused(exec(`${STAMP}, holder_departure_reason = 'AGENT_IMPORTER_DELETED' WHERE id = $1`, id), EITHER);
    expect(await cause(id)).toBeNull();
  });

  it('a cause must agree with what happened to the holder: a retired worker is not DELETED, an erased person did not LEAVE', async () => {
    const worker = await active({ user_id: null, worker_id: w.workerId });
    await retire();
    await refused(exec(`${STAMP}, holder_departure_reason = 'WORKER_DELETED' WHERE id = $1`, worker));
    const person = await active({ user_id: w.user2Id });
    await db.user.update({ where: { id: w.user2Id }, data: { deletedAt: new Date() } });
    await refused(exec(`${STAMP}, holder_departure_reason = 'ORG_LEFT' WHERE id = $1`, person));
    await refused(exec(`${STAMP}, holder_departure_reason = 'ORG_REMOVED' WHERE id = $1`, person));
    await exec(`${STAMP}, holder_departure_reason = 'USER_ERASED' WHERE id = $1`, person);
    expect(await cause(person)).toBe('USER_ERASED');
  });

  it('the other halves: a person who only LEFT is not ERASED; a deleted worker is not RETIRED; a live agent is not DELETED, a deleted one did not lose an install', async () => {
    // A live person with no membership in the grant App's organization: the stamp is admitted, but only as a leave.
    const left = await active({ user_id: w.userId });
    await db.orgMember.deleteMany({ where: { userId: w.userId, organizationId: w.orgId } });
    await refused(exec(`${STAMP}, holder_departure_reason = 'USER_ERASED' WHERE id = $1`, left));
    await exec(`${STAMP}, holder_departure_reason = 'ORG_REMOVED' WHERE id = $1`, left);
    expect(await cause(left)).toBe('ORG_REMOVED');
    // A worker whose row is gone, on a grant the delete trigger did not stamp (test-only: the trigger is off for that delete).
    const gone = await active({ user_id: null, worker_id: w.workerId });
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE workers DISABLE TRIGGER workers_grant_holder_gone');
      await tx.$executeRawUnsafe('DELETE FROM workers WHERE id = $1', w.workerId);
      await tx.$executeRawUnsafe('ALTER TABLE workers ENABLE TRIGGER workers_grant_holder_gone');
    });
    await refused(exec(`${STAMP}, holder_departure_reason = 'WORKER_RETIRED' WHERE id = $1`, gone));
    await exec(`${STAMP}, holder_departure_reason = 'WORKER_DELETED' WHERE id = $1`, gone);
    expect(await cause(gone)).toBe('WORKER_DELETED');
    // A live agent with no installation in the grant's App: it left the App, it was not deleted.
    const uninstalled = await active({ user_id: null, agent_id: w.agentId });
    await db.appAgent.deleteMany({ where: { agentId: w.agentId } });
    await refused(exec(`${STAMP}, holder_departure_reason = 'AGENT_DELETED' WHERE id = $1`, uninstalled));
    await exec(`${STAMP}, holder_departure_reason = 'AGENT_UNINSTALLED' WHERE id = $1`, uninstalled);
    expect(await cause(uninstalled)).toBe('AGENT_UNINSTALLED');
    // #4180 (the #4696 lapse sweep's two causes): admitted for a live agent, like every other install loss.
    for (const lapse of ['AGENT_LICENSE_EXPIRED', 'ORG_DELETED']) {
      const g = await active({ user_id: null, agent_id: w.agentId });
      await exec(`${STAMP}, holder_departure_reason = $2 WHERE id = $1`, g, lapse);
      expect(await cause(g)).toBe(lapse);
    }
    // A soft-deleted agent: deleted, not uninstalled, whichever install-loss code is offered.
    const deleted = await active({ user_id: null, agent_id: w.agentId });
    await db.agent.update({ where: { id: w.agentId }, data: { deletedAt: new Date() } });
    for (const wrong of ['AGENT_UNINSTALLED', 'AGENT_IMPORTER_UNINSTALLED', 'AGENT_IMPORT_REMOVED', 'AGENT_LICENSE_REVOKED', 'AGENT_LICENSE_EXPIRED', 'ORG_DELETED']) {
      await refused(exec(`${STAMP}, holder_departure_reason = $2 WHERE id = $1`, deleted, wrong));
    }
    await exec(`${STAMP}, holder_departure_reason = 'AGENT_DELETED' WHERE id = $1`, deleted);
    expect(await cause(deleted)).toBe('AGENT_DELETED');
  });

  it('endHeldGrants stamps the cause it is given, and only on grants it ends (first end stands)', async () => {
    const open = await active({ user_id: null, worker_id: w.workerId });
    const revoked = await active({ user_id: null, worker_id: w.workerId, revoked_at: raw(DB_NOW), revoked_by: w.userId });
    await retire();
    await db.$transaction((tx) => endHeldGrants(tx, 'worker', w.workerId, 'WORKER_RETIRED'));
    expect([await cause(open), await cause(revoked)]).toEqual(['WORKER_RETIRED', null]);
  });
});

describe('#4180 (BLIND P2, Antonio): a door\'s cause yields to what already happened to the holder; it never aborts the door', () => {
  it('an install-loss door ending an agent that is ALREADY deleted (unstamped rows) records AGENT_DELETED and commits', async () => {
    const id = await active({ user_id: null, agent_id: w.agentId });
    await db.agent.update({ where: { id: w.agentId }, data: { deletedAt: new Date() } }); // deleted, its grant never stamped
    for (const reason of ['AGENT_UNINSTALLED', 'AGENT_IMPORT_REMOVED', 'AGENT_LICENSE_REVOKED', 'AGENT_LICENSE_EXPIRED', 'ORG_DELETED'] as const) {
      const other = await active({ user_id: null, agent_id: w.agentId });
      const { ended } = await db.$transaction((tx) => endGrantsOfAgentsNoLongerInstalled(tx, [{ appId: w.appId, agentId: w.agentId }], null, reason));
      expect(ended).toBeGreaterThanOrEqual(1);
      expect(await cause(other)).toBe('AGENT_DELETED');
    }
    expect(await cause(id)).toBe('AGENT_DELETED');
  });

  it('an org removal ending a person who is ALREADY erased (unstamped rows) records USER_ERASED and commits', async () => {
    const id = await active({ user_id: w.user2Id });
    await db.user.update({ where: { id: w.user2Id }, data: { deletedAt: new Date() } });
    for (const reason of ['ORG_LEFT', 'ORG_REMOVED'] as const) {
      const other = await active({ user_id: w.user2Id });
      expect(await db.$transaction((tx) => endHeldGrants(tx, 'user', w.user2Id, reason, { organizationId: w.orgId }))).toBeGreaterThanOrEqual(1);
      expect(await cause(other)).toBe('USER_ERASED');
    }
    expect(await cause(id)).toBe('USER_ERASED');
  });

  it('a live holder keeps the door\'s own cause (the yield applies only to a holder that already went that other way)', async () => {
    const id = await active({ user_id: w.user2Id });
    await db.orgMember.deleteMany({ where: { userId: w.user2Id, organizationId: w.orgId } });
    await db.$transaction((tx) => endHeldGrants(tx, 'user', w.user2Id, 'ORG_LEFT', { organizationId: w.orgId }));
    expect(await cause(id)).toBe('ORG_LEFT');
  });
});

describe('#4180: a departure stamped before causes were kept reads REASON_NOT_RECORDED, never a guess', () => {
  it('even when today\'s data would suggest a cause (the person row is gone), the read says the cause was not recorded', async () => {
    const id = await active({ user_id: w.user2Id, holder_departed_at: raw(DB_NOW) });
    await db.user.delete({ where: { id: w.user2Id } }); // an inference would say USER_ERASED; the record does not
    expect(await cause(id)).toBeNull();
    const page = await listGrantsForManager(db, w.appId, {});
    expect(page.items.find((g) => g.id === id)).toMatchObject({ state: 'HOLDER_GONE', holderDepartureReason: 'REASON_NOT_RECORDED' });
  });

  it('a grant whose holder has not gone reads no cause at all', async () => {
    const id = await active({ user_id: null, worker_id: w.workerId });
    const page = await listGrantsForManager(db, w.appId, {});
    expect(page.items.find((g) => g.id === id)?.holderDepartureReason).toBeNull();
  });
});
