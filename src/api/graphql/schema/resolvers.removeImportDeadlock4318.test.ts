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
/**
 * A cross-install with a BOUNDED lock wait (#4354 BLIND delta F1): if a lock-mode regression made the insert wait on a
 * lock a parked removal holds, it fails within `CROSS_LOCK_TIMEOUT` naming the install, and the barrier's `finally`
 * releases the removals, instead of the test hanging until an external timeout.
 */
const CROSS_LOCK_TIMEOUT = '5s';
const boundedInstall = async (appId: string, agentId: string, label: string) => {
  try {
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${CROSS_LOCK_TIMEOUT}'`);
      await tx.appAgent.create({ data: { appId, agentId } });
    }, { timeout: 30_000 });
  } catch (e) {
    // Timeout wording only for Postgres's own lock-timeout cancel; anything else is named neutrally, and the original
    // error is kept as the cause either way (#4354 BLIND delta2 F2). Prisma reports a model operation's Postgres error
    // only inside an UnknownRequestError's message (no code or meta), so the check requires that exact diagnostic: SQLSTATE
    // 55P03 WITH "canceling statement due to lock timeout" (55P03 alone also covers NOWAIT), (#4354 BLIND delta3 F2).
    const message = String((e as Error)?.message ?? e);
    const lockTimeout = e instanceof Prisma.PrismaClientUnknownRequestError
      && /PostgresError \{ code: "55P03", message: "canceling statement due to lock timeout"/.test(message);
    throw new Error(lockTimeout
      ? `cross-install ${label} did not land within lock_timeout ${CROSS_LOCK_TIMEOUT}: ${message}`
      : `cross-install ${label} failed: ${message}`, { cause: e });
  }
};
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
 * A retried attempt passes the seam without parking, and every arrival is counted, so the pin can assert the retry
 * happened. `abort` releases everything at once (#4354 BLIND F2): a removal that settles before it parks, a failed
 * install, or the test's own cleanup can never leave the other transaction parked.
 */
function crossAtTheSeam(p1: string, p2: string) {
  const arrivals = new Map<string, number>();
  let release!: () => void;
  const released = new Promise<void>((r) => { release = r; });
  let bothParked!: () => void;
  let failParking!: (e: Error) => void;
  const both = new Promise<void>((r, j) => { bothParked = r; failParking = j; });
  removeAgentImportHooks.betweenFenceReads = async (parentAgentId) => {
    const n = (arrivals.get(parentAgentId) ?? 0) + 1;
    arrivals.set(parentAgentId, n);
    if (n > 1) return; // a retry: no second park
    if ([p1, p2].every((p) => arrivals.has(p))) bothParked();
    await released;
  };
  const abort = (why: string) => { failParking(new Error(why)); release(); };
  return {
    arrivals,
    abort,
    /** Wraps a removal so that settling before it parked aborts the crossing instead of hanging it. */
    removal: (parent: string, run: () => Promise<unknown>) => run().finally(() => {
      if (!arrivals.has(parent)) abort(`removal of ${parent} settled before it reached the seam`);
    }),
    cross: async () => {
      try {
        await both;
        // Plain inserts take FOR KEY SHARE on the App, which the fences' FOR NO KEY UPDATE does not block.
        await boundedInstall(w.app2Id, p1, 'P1 into App B'); await boundedInstall(w.appId, p2, 'P2 into App A');
      } finally {
        release();
      }
    },
  };
}

describe('#4318 crossed removeAgentImport fences', () => {
  it('two removals crossed between their reads both succeed (one after a retry), and each grant ends', async () => {
    const { p1, p2, gA, gB } = await crossedWorld();
    const seam = crossAtTheSeam(p1.id, p2.id);
    try {
      const results = await Promise.allSettled([
        seam.removal(p1.id, () => remove(p1, owner1)), seam.removal(p2.id, () => remove(p2, owner2)), seam.cross(),
      ]);
      // All three surface: a failed cross-install is a failure of the pin, not something to discard.
      expect(results.map(outcome)).toEqual(['ok', 'ok', 'ok']);
    } finally {
      seam.abort('cleanup');
    }
    // The cycle really formed: one parent came back to the seam on a second attempt (the deadlock retry).
    expect([...seam.arrivals.values()].sort()).toEqual([1, 2]);
    // Both edges are gone and neither parent's install witnesses the child any more: its grants in both Apps end.
    expect(await db.agentImport.count({ where: { importedAgentId: child.id } })).toBe(0);
    expect([await departed(gA), await departed(gB)]).toEqual([true, true]);
    // Final state: exactly the two grants ended. (That a stamp is written at most once is the grant guard's own rule,
    // pinned in the grant guard's tests; this asserts the outcome, not a write count.)
    const stamps = await db.$queryRaw<{ n: bigint }[]>(Prisma.sql`
      SELECT count(*) AS n FROM grants WHERE agent_id = ${child.id} AND holder_departed_at IS NOT NULL`);
    expect(Number(stamps[0]!.n)).toBe(2);
  }, 60_000);

  it('a cross-install blocked by a held App lock fails within its bound, naming the install (#4354 BLIND delta F1)', async () => {
    const { p1 } = await crossedWorld();
    // FOR UPDATE on the App conflicts with the insert's FOR KEY SHARE, standing in for a lock a parked removal could hold.
    let releaseHold!: () => void;
    const hold = new Promise<void>((r) => { releaseHold = r; });
    let held!: () => void;
    const isHeld = new Promise<void>((r) => { held = r; });
    const holder = db.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM apps WHERE id = ${w.app2Id} FOR UPDATE`);
      held();
      await hold;
    }, { timeout: 30_000 });
    // The holder's rejection is observed at once, and lock readiness races the holder ending, so a setup failure
    // (no connection, the FOR UPDATE failing) surfaces here and cleanup still runs (#4354 BLIND delta2 F1).
    const holderEnded = holder.then(
      () => { throw new Error('the lock holder ended before it held the App lock'); },
      (e: unknown) => { throw new Error(`the lock holder failed before it held the App lock: ${String((e as Error)?.message ?? e)}`, { cause: e }); },
    );
    holderEnded.catch(() => {});
    let bodyFailed = false;
    try {
      await Promise.race([isHeld, holderEnded]);
      const started = Date.now();
      // Postgres's own lock-timeout cancel (not Prisma's 30 s transaction timeout), well inside that timeout.
      await expect(boundedInstall(w.app2Id, p1.id, 'P1 into App B'))
        .rejects.toThrow(/^cross-install P1 into App B did not land within lock_timeout 5s: .*lock timeout/s);
      expect(Date.now() - started).toBeLessThan(20_000);
    } catch (e) {
      bodyFailed = true;
      throw e;
    } finally {
      releaseHold();
      // A holder failure AFTER it held the lock (during the install check, or while ending) still fails the pin; when the
      // body already failed, its own error stands (#4354 BLIND delta3 F1).
      const holderError = await holder.then(() => undefined, (e: unknown) => e ?? new Error('holder rejected'));
      if (holderError !== undefined && !bodyFailed) {
        throw new Error(`the lock holder failed after it held the App lock: ${String((holderError as Error)?.message ?? holderError)}`, { cause: holderError });
      }
    }
  }, 60_000);

  it('a cross-install that fails for another reason is named neutrally and keeps its cause (#4354 BLIND delta3 F2)', async () => {
    const { p1 } = await crossedWorld(); // P1 is already installed in App A: a second install is a unique violation
    const err = await boundedInstall(w.appId, p1.id, 'P1 into App A').then(() => undefined, (e: unknown) => e as Error);
    expect(err?.message).toMatch(/^cross-install P1 into App A failed: /);
    expect(err?.message).not.toMatch(/lock_timeout/);
    expect((err as Error & { cause?: unknown })?.cause).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  }, 60_000);

  it('control: a single removal through the same seam (no crossing) succeeds and ends the grant its edge witnessed', async () => {
    const { p1, gA, gB } = await crossedWorld();
    removeAgentImportHooks.betweenFenceReads = async () => {};
    await expect(remove(p1, owner1)).resolves.toBe(true);
    expect([await departed(gA), await departed(gB)]).toEqual([true, false]);
  }, 60_000);
});
