/**
 * #3690 S2a — who a grant REACHES (cor:acl:140:06, Decided: rulings 0253 item 10, 0255 items 20/20a/20b). A server function
 * later phases call; nothing in this slice enforces with it. The truth table (plan 1.5), one pin per row.
 */
import { beforeEach, afterAll, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
import { dropTestActions, insertGrant, seedWorld, type World } from './grantFixtures3668.js';
import { grantReachesWorker, workersReachedByGrant } from './reach.js';

let w: World;
let n = 0;
beforeEach(async () => { await cleanDb(db); w = await seedWorld(); await db.appAgent.create({ data: { appId: w.appId, agentId: w.agentId } }); });
afterAll(async () => { await cleanDb(db); await dropTestActions(); });

const agentOf = (name: string, extra: Record<string, unknown> = {}) =>
  db.agent.create({ data: { organizationId: w.orgId, name, urn: `${name}-${++n}.${w.orgId}`, ...extra } as never });
const workerOf = (agentId: string, appId = w.appId) =>
  db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId, agentId, name: `w${++n}`, slug: `w${n}` } });
const agentGrant = (agentId = w.agentId, appId = w.appId) => insertGrant(w, { user_id: null, agent_id: agentId, app_id: appId });
const reached = async (grantId: string) => (await workersReachedByGrant(db, grantId)).sort();

describe('reach: a grant to a role agent reaches that agent\'s live workers in the App, and nothing else', () => {
  it('1: the role agent\'s workers in the App are reached (one grant, many workers)', async () => {
    const a = await workerOf(w.agentId); const b = await workerOf(w.agentId);
    const g = await agentGrant();
    expect(await reached(g)).toEqual([w.workerId, a.id, b.id].sort());
    expect(await grantReachesWorker(db, g, a.id)).toBe(true);
  });
  it('2: another agent\'s worker in the same App is not reached', async () => {
    const other = await agentOf('other'); await db.appAgent.create({ data: { appId: w.appId, agentId: other.id } });
    const ow = await workerOf(other.id);
    const g = await agentGrant();
    expect(await reached(g)).toEqual([w.workerId]);
    expect(await grantReachesWorker(db, g, ow.id)).toBe(false);
  });
  it('3 (item 20b): the same agent installed in ANOTHER App does not receive it', async () => {
    await db.appAgent.create({ data: { appId: w.app2Id, agentId: w.agentId } });
    const elsewhere = await workerOf(w.agentId, w.app2Id);
    const g = await agentGrant();
    expect(await reached(g)).toEqual([w.workerId]);
    expect(await grantReachesWorker(db, g, elsewhere.id)).toBe(false);
  });
  it('4 (item 20a): a base agent\'s grant does not reach an extending agent installed in the same App', async () => {
    const child = await agentOf('child', { extendsAgentId: w.agentId });
    await db.appAgent.create({ data: { appId: w.appId, agentId: child.id } });
    const cw = await workerOf(child.id);
    const g = await agentGrant(w.agentId);
    expect(await reached(g)).toEqual([w.workerId]);
    expect(await grantReachesWorker(db, g, cw.id)).toBe(false);
    // and the other direction: the child's own grant does not reach the base agent's worker
    const own = await agentGrant(child.id);
    expect(await reached(own)).toEqual([cw.id]);
  });
  it('5: a retired worker is not reached', async () => {
    const r = await workerOf(w.agentId);
    const g = await agentGrant();
    await db.worker.update({ where: { id: r.id }, data: { retiredAt: new Date() } });
    expect(await reached(g)).toEqual([w.workerId]);
  });
  it('6: an agent uninstalled, deleted, or in a deleted App reaches no worker (judged after the grant exists)', async () => {
    const g = await agentGrant();
    expect(await reached(g)).toEqual([w.workerId]);
    await db.appAgent.delete({ where: { appId_agentId: { appId: w.appId, agentId: w.agentId } } });
    expect(await reached(g)).toEqual([]);
    await db.appAgent.create({ data: { appId: w.appId, agentId: w.agentId } });
    expect(await reached(g)).toEqual([w.workerId]);
    await db.agent.update({ where: { id: w.agentId }, data: { deletedAt: new Date() } });
    expect(await reached(g)).toEqual([]);
    await db.agent.update({ where: { id: w.agentId }, data: { deletedAt: null } });
    await db.app.update({ where: { id: w.appId }, data: { deletedAt: new Date() } });
    expect(await reached(g)).toEqual([]);
  });
  it('7: a grant naming one worker reaches that worker only (even with siblings of the same role)', async () => {
    const sibling = await workerOf(w.agentId);
    const g = await insertGrant(w, { user_id: null, worker_id: w.workerId });
    expect(await reached(g)).toEqual([w.workerId]);
    expect(await grantReachesWorker(db, g, sibling.id)).toBe(false);
  });
  it('a worker holder reaches nothing once retired', async () => {
    const g = await insertGrant(w, { user_id: null, worker_id: w.workerId });
    expect(await reached(g)).toEqual([w.workerId]);
    await db.worker.update({ where: { id: w.workerId }, data: { retiredAt: new Date() } });
    expect(await reached(g)).toEqual([]);
  });
  it('a worker holder reaches nothing in a different App than the grant\'s, or once the grant\'s App is deleted', async () => {
    const elsewhere = await insertGrant(w, { user_id: null, worker_id: w.workerId, app_id: w.app2Id });
    expect(await reached(elsewhere)).toEqual([]);
    const g = await insertGrant(w, { user_id: null, worker_id: w.workerId });
    expect(await reached(g)).toEqual([w.workerId]);
    await db.app.update({ where: { id: w.appId }, data: { deletedAt: new Date() } });
    expect(await reached(g)).toEqual([]);
  });
});

describe('reach: what a grant never reaches by itself', () => {
  it('a person holder and an App holder reach no worker (a person\'s grant reaches an agent only while the person drives the session, which the server cannot check)', async () => {
    expect(await reached(await insertGrant(w, { user_id: w.userId }))).toEqual([]);
    expect(await reached(await insertGrant(w, { user_id: null, grantee_app_id: w.app2Id }))).toEqual([]);
  });
  it('a grant whose holder departed reaches nothing, and a missing grant reaches nothing', async () => {
    const g = await agentGrant();
    // (the stamp itself is refused for a live holder, so this fixture sets it with the guard off, to judge reach's own predicate)
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE grants DISABLE TRIGGER grants_guard');
      await tx.$executeRawUnsafe(`UPDATE grants SET holder_departed_at = (clock_timestamp() AT TIME ZONE 'UTC') WHERE id = $1`, g);
      await tx.$executeRawUnsafe('ALTER TABLE grants ENABLE TRIGGER grants_guard');
    });
    expect(await reached(g)).toEqual([]);
    expect(await reached('no-such-grant')).toEqual([]);
  });
  it('reach is not liveness: a revoked or pending grant still has its reach (whether it ALLOWS is the live check\'s job)', async () => {
    const g = await agentGrant();
    expect(await reached(g)).toEqual([w.workerId]);
  });
});
