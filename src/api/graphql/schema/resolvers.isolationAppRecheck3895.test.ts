/**
 * #3895 / hrn:node:hadronmemory.com:specs:cor:agt:080:29: the deprecated clear door rechecks the locked target's
 * App. This is coverage of the retained no-op, not an App-move API or a claim that isolation can be enabled.
 * The fixture moves a minimally referenced Worker using ordinary SQL, with all production constraints enabled.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
const M = resolvers.Mutation as any;
let appId: string, destinationId: string, workerId: string, holderId: string;
const context = (): Context => ({ db, userId: holderId, roles: ['READER'] });

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'Recheck', urn: 'isolation3895.test' } });
  const holder = await db.user.create({ data: { handle: 'isolation3895-holder' } });
  holderId = holder.id;
  const agent = await db.agent.create({ data: { organizationId: org.id, name: 'Engineer', urn: `${org.urn}:engineer` } });
  const apps = await Promise.all(['source', 'destination'].map(name => db.app.create({
    data: { organizationId: org.id, name, urn: `${org.urn}:${name}` },
  })));
  [appId, destinationId] = apps.map(app => app.id);
  for (const app of apps) {
    await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
    await db.appMember.create({ data: { appId: app.id, userId: holderId, role: 'member' } });
  }
  const worker = await db.worker.create({ data: {
    appId, agentId: agent.id, name: 'Target', slug: 'target', signature: '', trailer: '', heldByUserId: holderId,
  } });
  workerId = worker.id;
  await db.workerWakeSettings.create({ data: {
    workerId, mentions: 'OFF', pausedUntil: new Date('2099-01-01T00:00:00Z'),
  } });
});

/** Capture the rows the deprecated door must leave untouched, including both Apps' event streams. */
async function storedState() {
  return {
    settings: await db.workerWakeSettings.findUniqueOrThrow({ where: { workerId } }),
    events: await db.agentTeamEvent.findMany({ where: { appId: { in: [appId, destinationId] } }, orderBy: { id: 'asc' } }),
  };
}

/** Hold only the target worker row; observe the real clear's FOR SHARE waiter before changing and releasing it. */
async function clearAcrossWorkerLock(move: boolean) {
  const blocker = new Client({ connectionString: process.env.DATABASE_URL });
  await blocker.connect();
  let pending: Promise<{ value?: any; error?: any }> | undefined;
  try {
    await blocker.query('BEGIN');
    const { rows: [{ pid }] } = await blocker.query('SELECT pg_backend_pid() AS pid');
    await blocker.query('SELECT id FROM workers WHERE id = $1 FOR UPDATE', [workerId]);
    let settled = false;
    const outcome: Promise<{ value?: any; error?: any }> = M.clearWorkerIsolation({}, { workerRef: workerId }, context())
      .then((value: unknown) => ({ value }), (error: unknown) => ({ error }))
      .finally(() => { settled = true; });
    pending = outcome;
    const deadline = Date.now() + 5000;
    let observed = false;
    while (!settled && Date.now() < deadline) {
      const [{ n }] = await db.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*) AS n FROM pg_stat_activity
        WHERE datname = current_database() AND ${pid}::int = ANY(pg_blocking_pids(pid))
          AND query ILIKE '%FROM workers%' AND query ILIKE '%FOR SHARE%'`;
      if (Number(n) > 0) { observed = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(observed, 'clear must wait on THIS transaction at the target worker FOR SHARE').toBe(true);
    expect(settled, 'the fresh worker read must happen after the lock is released').toBe(false);
    if (move) {
      // No disabled trigger, dropped FK, or mocked read: exercise the database's ordinary App-id update.
      const changed = await blocker.query('UPDATE workers SET app_id = $1 WHERE id = $2 RETURNING app_id', [destinationId, workerId]);
      expect(changed.rows).toEqual([{ app_id: destinationId }]);
    }
    await blocker.query('COMMIT');
    return await outcome;
  } finally {
    await blocker.query('ROLLBACK');
    await blocker.end();
    // Drain the real call even when a barrier assertion fails, before test-database teardown.
    if (pending) await pending;
  }
}

describe('#3895 deprecated clear locked worker App-id recheck', () => {
  it('unchanged App: the observed waiter returns the authorized no-op and writes nothing', async () => {
    const before = await storedState();
    const result = await clearAcrossWorkerLock(false);
    expect(result.error).toBeUndefined();
    expect(result.value).toMatchObject({ workerId, mentions: 'OFF', pausedUntil: new Date('2099-01-01T00:00:00Z') });
    expect((await db.worker.findUniqueOrThrow({ where: { id: workerId } })).appId).toBe(appId);
    expect(await storedState()).toEqual(before);
  }, 20000);

  it('App moved behind the observed lock: conceals the target and writes no settings or event', async () => {
    const before = await storedState();
    const result = await clearAcrossWorkerLock(true);
    // With only `w.appId !== fresh.id` removed this is an admitted no-op, not a timeout or a different refusal.
    expect(result.error, 'the locked App-id recheck must refuse the moved worker').toMatchObject({
      message: 'Worker not found.', extensions: { code: 'WORKER_NOT_FOUND', ref: workerId },
    });
    expect(result.value).toBeUndefined();
    expect((await db.worker.findUniqueOrThrow({ where: { id: workerId } })).appId).toBe(destinationId);
    expect(await storedState()).toEqual(before);
  }, 20000);
});
