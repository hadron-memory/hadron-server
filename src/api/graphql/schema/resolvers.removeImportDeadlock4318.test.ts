/**
 * #4318 (follow-up of #4210; cor:acl:140:01, :03): `removeAgentImport` fences the Apps its edge could witness an install in
 * in TWO sorted batches, the Apps read first, then the Apps a re-read finds. The two batches together are not one sorted
 * set, so two removals of different parents can cross: P1 in App A and P2 in App B, each installed into the other's App
 * between its two reads, each then waits in its second batch on the App the other fenced first, and Postgres aborts one
 * with 40P01. The fix retries the resolver's WHOLE transaction on a deadlock (`retryOnDeadlock`), a fresh attempt that
 * re-reads under its new locks. The edge delete and its grant stamps stay ONE unit (Victor's FIT): grants end from the
 * re-read, never from an aborted attempt's reads, and none is stamped twice.
 *
 * The cycle is formed for real: a test-only seam parks each removal between its reads (a barrier), the installs land
 * while both are parked, and both are released together. Two connections and barriers, no sleeps or load.
 */
import { afterEach, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { Prisma } from '../../../generated/prisma/index.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { DB_NOW, dropTestActions, insertGrantUnguarded, raw, seedWorld, type World } from '../../../lib/grants/grantFixtures3668.js';
import { removeAgentImportHooks } from '../../../controller/operations/removeAgentImport.js';
import { resolvers, type Context } from './resolvers.js';

const M = resolvers.Mutation as any;
const HOUR_AGO = raw(`${DB_NOW} - interval '1 hour'`);

let w: World;
let child: { id: string };
let owner1: { id: string };
let owner2: { id: string };
const ctx = (userId: string): Context => ({ db, userId, roles: ['READER'] }) as Context;
const departed = async (id: string) => (await db.$queryRaw<{ d: boolean }[]>(Prisma.sql`
  SELECT holder_departed_at IS NOT NULL AS d FROM grants WHERE id = ${id}`))[0]!.d;
const install = (appId: string, agentId: string) => db.appAgent.create({ data: { appId, agentId } });
let edgePos = 100;
async function importEdge(parentAgentId: string, importedAgentId: string) {
  await db.agentOrgGrant.upsert({
    where: { orgId_agentId: { orgId: w.orgId, agentId: importedAgentId } },
    create: { orgId: w.orgId, agentId: importedAgentId, activatedAt: new Date() }, update: {},
  });
  await db.agentImport.create({ data: { parentAgentId, importedAgentId, position: edgePos++, required: true, agentOrgGrantOrgId: w.orgId, agentOrgGrantAgentId: importedAgentId } });
}
const remove = (parent: { id: string }, as: { id: string }) =>
  M.removeAgentImport({}, { parentAgentRef: parent.id, importedAgentRef: child.id }, ctx(as.id));
const outcome = (r: PromiseSettledResult<unknown>) => (r.status === 'fulfilled' ? 'ok' : String((r.reason as Error)?.message ?? r.reason));

beforeEach(async () => {
  await cleanDb(db);
  w = await seedWorld();
  owner1 = await db.user.create({ data: { handle: `o1-${generateId().slice(0, 8)}` } });
  owner2 = await db.user.create({ data: { handle: `o2-${generateId().slice(0, 8)}` } });
  child = await db.agent.create({ data: { organizationId: w.orgId, name: 'child', urn: `${w.orgId}:child` } });
});
afterEach(() => { delete removeAgentImportHooks.betweenFenceReads; });
afterAll(async () => { await cleanDb(db); await dropTestActions(); });

/**
 * P1 (owner1) installed in App A, P2 (owner2) in App B, both importing `child`; the child holds a live grant in each App.
 * User-owned parents with different owners take different authority keys, so nothing but the App fences orders them.
 */
async function crossedWorld() {
  const p1 = await db.agent.create({ data: { ownerUserId: owner1.id, name: 'p1', urn: `p1-${generateId()}` } });
  const p2 = await db.agent.create({ data: { ownerUserId: owner2.id, name: 'p2', urn: `p2-${generateId()}` } });
  await install(w.appId, p1.id); await install(w.app2Id, p2.id);
  await importEdge(p1.id, child.id); await importEdge(p2.id, child.id);
  const gA = await insertGrantUnguarded(w, { user_id: null, agent_id: child.id, app_id: w.appId, activated_at: HOUR_AGO } as never);
  const gB = await insertGrantUnguarded(w, { user_id: null, agent_id: child.id, app_id: w.app2Id, activated_at: HOUR_AGO } as never);
  return { p1, p2, gA, gB };
}

/**
 * Park each parent's FIRST attempt between its reads; once both are parked, land P1 in B and P2 in A, then release both.
 * A retried attempt passes the seam without parking.
 */
function crossAtTheSeam(p1: string, p2: string) {
  const parked = new Set<string>();
  let release!: () => void;
  const released = new Promise<void>((r) => { release = r; });
  let bothParked!: () => void;
  const both = new Promise<void>((r) => { bothParked = r; });
  removeAgentImportHooks.betweenFenceReads = async (parentAgentId) => {
    if (parked.has(parentAgentId)) return; // a retry: no second park
    parked.add(parentAgentId);
    if (parked.size === 2) bothParked();
    await released;
  };
  return {
    cross: async () => {
      await both;
      // Plain inserts take FOR KEY SHARE on the App, which the fences' FOR NO KEY UPDATE does not block.
      await install(w.app2Id, p1); await install(w.appId, p2);
      release();
    },
  };
}

describe('#4318 crossed removeAgentImport fences', () => {
  it('two removals crossed between their reads both succeed, and each grant is stamped once', async () => {
    const { p1, p2, gA, gB } = await crossedWorld();
    const { cross } = crossAtTheSeam(p1.id, p2.id);
    const [r1, r2] = await Promise.allSettled([remove(p1, owner1), remove(p2, owner2), cross()]);
    expect([outcome(r1), outcome(r2)]).toEqual(['ok', 'ok']);
    // Both edges are gone and neither parent's install witnesses the child any more: its grants in both Apps end.
    expect(await db.agentImport.count({ where: { importedAgentId: child.id } })).toBe(0);
    expect([await departed(gA), await departed(gB)]).toEqual([true, true]);
    // ONE unit: a second departure of an ended grant is refused by the guard, so a double stamp cannot happen silently.
    const stamps = await db.$queryRaw<{ n: bigint }[]>(Prisma.sql`
      SELECT count(*) AS n FROM grants WHERE agent_id = ${child.id} AND holder_departed_at IS NOT NULL`);
    expect(Number(stamps[0]!.n)).toBe(2);
  }, 60_000);

  it('control: a single removal through the same seam (no crossing) succeeds and ends the grant its edge witnessed', async () => {
    const { p1, gA, gB } = await crossedWorld();
    removeAgentImportHooks.betweenFenceReads = async () => {};
    await expect(remove(p1, owner1)).resolves.toBe(true);
    expect([await departed(gA), await departed(gB)]).toEqual([true, false]);
  }, 60_000);
});
