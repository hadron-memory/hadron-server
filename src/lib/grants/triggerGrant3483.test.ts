/**
 * #3483: the database's USE arm of the grant guard, the spend helper and the admission helpers, pinned directly (the door pins
 * are resolvers.scheduleGrant3483.test.ts). Each guard here has a mutant that turns one of these red.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { runAsActor } from '../requestActor.js';
import { dbNowPlus, dropTestActions } from './grantFixtures3668.js';
import { seedTriggerWorld, sessionOf, triggerGrant, useCount, useEvents, workerOf, type TriggerWorld } from './triggerGrantFixtures3483.js';
import {
  admitWorkerTrigger, findAdmittingGrant, HOST_LAUNCHED_MAY_SPEND_SINGLE_USE, sessionMayUseGrant, spendTriggerGrant,
  workerBoundActor, workerTriggerGrantEnforced,
} from './triggerGrant.js';

const exec = (sql: string, ...p: unknown[]) => db.$executeRawUnsafe(sql, ...p);
const NOW = "(clock_timestamp() AT TIME ZONE 'UTC')";

let w: TriggerWorld;
beforeEach(async () => { await cleanDb(db); w = await seedTriggerWorld(); });
afterEach(() => { vi.unstubAllEnvs(); });
afterAll(async () => { await cleanDb(db); await dropTestActions(); });

describe('the guard\'s USE arm: use_count moves by +1 on a live row, and nothing else moves with it', () => {
  it('admits +1 on a live grant, up to its count', async () => {
    const g = await triggerGrant(w, { over: { max_uses: 2 } });
    await exec('UPDATE grants SET use_count = use_count + 1 WHERE id = $1', g);
    await exec('UPDATE grants SET use_count = use_count + 1, updated_at = ' + NOW + ' WHERE id = $1', g);
    expect(await useCount(g)).toBe(2);
    await expect(exec('UPDATE grants SET use_count = use_count + 1 WHERE id = $1', g)).rejects.toThrow(/a use adds one/);
  });

  it('refuses +2, -1 and a reset', async () => {
    const g = await triggerGrant(w, { over: { max_uses: null } });
    await expect(exec('UPDATE grants SET use_count = use_count + 2 WHERE id = $1', g)).rejects.toThrow(/a use adds one/);
    await exec('UPDATE grants SET use_count = use_count + 1 WHERE id = $1', g);
    await expect(exec('UPDATE grants SET use_count = use_count - 1 WHERE id = $1', g)).rejects.toThrow(/a use adds one/);
    await expect(exec('UPDATE grants SET use_count = 0 WHERE id = $1', g)).rejects.toThrow(/a use adds one/);
  });

  it('refuses a use of a pending, revoked, expired, not-yet-started or departed grant, or one whose App is deleted', async () => {
    const cases: Array<() => Promise<string>> = [
      () => triggerGrant(w, { activate: false }),
      async () => { const g = await triggerGrant(w); await exec(`UPDATE grants SET revoked_at = ${NOW}, revoked_by = $2 WHERE id = $1`, g, w.userId); return g; },
      async () => { const g = await triggerGrant(w, { over: { expires_at: dbNowPlus('1 second') } }); await new Promise((r) => setTimeout(r, 1500)); return g; },
      () => triggerGrant(w, { over: { starts_at: dbNowPlus('1 hour') } }),
      async () => {
        const k = await workerOf(w); const g = await triggerGrant(w, { holder: { kind: 'worker', id: k } });
        await db.worker.update({ where: { id: k }, data: { retiredAt: new Date() } });
        await exec(`UPDATE grants SET holder_departed_at = ${NOW} WHERE id = $1`, g); return g;
      },
      async () => { const g = await triggerGrant(w); await db.app.update({ where: { id: w.appId }, data: { deletedAt: new Date() } }); return g; },
    ];
    for (const make of cases) {
      const g = await make();
      await expect(exec('UPDATE grants SET use_count = use_count + 1 WHERE id = $1', g)).rejects.toThrow(/append-only/);
    }
  });

  it('refuses a use that moves anything else (here a revoke in the same update)', async () => {
    const g = await triggerGrant(w);
    await expect(exec(`UPDATE grants SET use_count = use_count + 1, revoked_at = ${NOW}, revoked_by = $2 WHERE id = $1`, g, w.userId)).rejects.toThrow(/a use adds one/);
    expect(await useCount(g)).toBe(0);
  });
});

describe('spendTriggerGrant', () => {
  it('charges one use and writes one USE event naming the worker, session and App', async () => {
    const g = await triggerGrant(w, { over: { max_uses: null } });
    await db.$transaction((tx) => spendTriggerGrant(tx, g, { appId: w.appId, workerId: w.workerId, sessionId: w.sessionId }));
    expect(await useCount(g)).toBe(1);
    expect(await useEvents(g)).toEqual([expect.objectContaining({ workerId: w.workerId, sessionId: w.sessionId, appId: w.appId, actorUserId: null })]);
  });

  it('refuses, and writes nothing, when the row is no longer live (spent) or names another App', async () => {
    const g = await triggerGrant(w);
    await exec('UPDATE grants SET use_count = 1 WHERE id = $1', g);
    await expect(db.$transaction((tx) => spendTriggerGrant(tx, g, { appId: w.appId, workerId: w.workerId, sessionId: null })))
      .rejects.toMatchObject({ extensions: { code: 'TRIGGER_GRANT_REQUIRED' } });
    const h = await triggerGrant(w);
    await expect(db.$transaction((tx) => spendTriggerGrant(tx, h, { appId: w.app2Id, workerId: w.workerId, sessionId: null })))
      .rejects.toMatchObject({ extensions: { code: 'TRIGGER_GRANT_REQUIRED' } });
    expect(await useEvents(g)).toHaveLength(0);
    expect(await useEvents(h)).toHaveLength(0);
  });
});

describe('findAdmittingGrant: lock, then judge', () => {
  const actor = { workerId: '', sessionId: null, hostLaunched: false };

  it('a holder that ends without changing the grant row (the worker retired, the grant not yet stamped) admits nothing', async () => {
    const k = await workerOf(w);
    await triggerGrant(w, { holder: { kind: 'worker', id: k } });
    await db.worker.update({ where: { id: k }, data: { retiredAt: new Date() } });
    expect(await db.$transaction((tx) => findAdmittingGrant(tx, { appId: w.appId, action: 'schedule.create', entryNodeId: w.entryNodeId, actor: { ...actor, workerId: k }, lock: true }))).toBeNull();
  });

  it('a spent capped grant, though ordered first, does not hide a live repeating one', async () => {
    const capped = await triggerGrant(w, { over: { max_uses: 1 } });
    await exec('UPDATE grants SET use_count = 1 WHERE id = $1', capped);
    const repeating = await triggerGrant(w, { over: { max_uses: null } });
    expect(await db.$transaction((tx) => findAdmittingGrant(tx, { appId: w.appId, action: 'schedule.create', entryNodeId: w.entryNodeId, actor: { ...actor, workerId: w.workerId }, lock: true }))).toBe(repeating);
  });

  it('an agent-held grant admits nothing once the agent is uninstalled from the App', async () => {
    await triggerGrant(w, { holder: { kind: 'agent', id: w.agentId } });
    await db.appAgent.delete({ where: { appId_agentId: { appId: w.appId, agentId: w.agentId } } });
    expect(await findAdmittingGrant(db, { appId: w.appId, action: 'schedule.create', entryNodeId: w.entryNodeId, actor: { ...actor, workerId: w.workerId }, lock: false })).toBeNull();
  });

  it('a revoke that commits while the spender waits on the grant row lock is seen: the spend refuses and charges nothing', async () => {
    vi.stubEnv('WORKER_TRIGGER_GRANT_ENFORCED', 'true');
    const g = await triggerGrant(w);
    const blocker = new Client({ connectionString: process.env.DATABASE_URL });
    await blocker.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM grants WHERE id = $1 FOR UPDATE', [g]);
      const spend = runAsActor({ workerId: w.workerId, agentId: w.agentId }, () =>
        db.$transaction((tx) => admitWorkerTrigger(tx, w.workerCtx as never, { appId: w.appId, action: 'schedule.create', entryNodeId: w.entryNodeId })));
      const settled = spend.then(() => 'admitted', (e: { extensions?: { code?: string } }) => e.extensions?.code ?? String(e));
      await new Promise((r) => setTimeout(r, 300));
      await blocker.query(`UPDATE grants SET revoked_at = ${NOW}, revoked_by = $2 WHERE id = $1`, [g, w.userId]);
      await blocker.query('COMMIT');
      expect(await settled).toBe('TRIGGER_GRANT_REQUIRED');
    } finally {
      await blocker.end();
    }
    expect(await useCount(g)).toBe(0);
    expect(await useEvents(g)).toHaveLength(0);
  });
});

describe('the switch, the worker test and the open host-launch question', () => {
  it('only the exact value true turns enforcement on', () => {
    expect(workerTriggerGrantEnforced({ WORKER_TRIGGER_GRANT_ENFORCED: 'true' })).toBe(true);
    for (const v of [undefined, '', '1', 'TRUE', 'True', 'yes', 'on', 'true ', ' true']) {
      expect(workerTriggerGrantEnforced(v === undefined ? {} : { WORKER_TRIGGER_GRANT_ENFORCED: v })).toBe(false);
    }
  });

  it('admitWorkerTrigger reads nothing while off: no lock, no spend, even for a worker', async () => {
    const g = await triggerGrant(w);
    await runAsActor({ workerId: w.workerId, agentId: w.agentId }, () =>
      db.$transaction((tx) => admitWorkerTrigger(tx, w.workerCtx as never, { appId: w.appId, action: 'schedule.create', entryNodeId: null })));
    expect(await useCount(g)).toBe(0);
  });

  it('the worker test: a person is not worker-bound; a session naming a worker, a bound actor and a refused binding are', async () => {
    expect(await workerBoundActor({ db, sessionId: undefined } as never)).toBeNull();
    expect(await workerBoundActor({ db, sessionId: w.sessionId } as never)).toMatchObject({ workerId: w.workerId, sessionId: w.sessionId, hostLaunched: false });
    expect(await runAsActor({ workerId: w.workerId, agentId: w.agentId }, () => workerBoundActor({ db } as never))).toMatchObject({ workerId: w.workerId });
    expect(await workerBoundActor({ db, sessionBindingRefused: true } as never)).toMatchObject({ workerId: null });
    const launched = await sessionOf(w, w.workerId, w.agentId, true);
    expect(await workerBoundActor({ db, sessionId: launched } as never)).toMatchObject({ hostLaunched: true });
  });

  it('Q17 lives in one predicate, and both readings are pinned (built as no)', () => {
    expect(HOST_LAUNCHED_MAY_SPEND_SINGLE_USE).toBe(false);
    expect(sessionMayUseGrant(1, true)).toBe(false);
    expect(sessionMayUseGrant(null, true)).toBe(true);
    expect(sessionMayUseGrant(1, false)).toBe(true);
    expect(sessionMayUseGrant(1, true, true)).toBe(true);
  });
});
