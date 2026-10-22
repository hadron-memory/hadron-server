import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
/**
 * #2170 (S6c) — two-connection race pins for stop signals (CHECKED 6305283912, on the attach 6304925436). Test-only.
 *
 * Every pin runs two real connections against the App's stop fence (src/lib/stopSignals/state.ts):
 *
 * 1. the FIRST side is held at a barrier right after it takes the fence (`heldAtFence` intercepts that lock call on
 *    its own transaction and waits there, so it still holds the fence);
 * 2. the SECOND side is started, and the test proves it is BLOCKED BEHIND THE FIRST ON THIS APP'S STOP FENCE before
 *    releasing it: some backend waits (`pg_locks`, `granted = false`) on exactly the fence's key, and the first side's
 *    backend (its pid captured at the barrier) is among `pg_blocking_pids` of that waiter (Xan #2172 LOCAL P2). An
 *    unrelated advisory waiter never satisfies it (the decoy pin); a sleep is never the evidence;
 * 3. both commit, and the committed task / coverage / end / notice state is asserted.
 *
 * Each schedule runs in both winner orders. A barrier the first side never reaches fails the pin (it is how a writer
 * that dropped its fence shows), and a deadlock is a failure, never a winner. Notices follow the fitted effective-level
 * semantics (Vera, #2166 6302988619): a same-level overlap is silent.
 *
 * Cast as in stopSignals2022.test.ts: Ada heads Liam and Dan; orca1 lists Ada and Dan; Kit is outside every team; Max
 * manages the App; Mia holds the workers. Private per-worker test database only; no production signal, no host.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { APP_KEY_PREFIX, hashAppKey } from '../../middleware/auth.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { registerHost } from '../agentTasks/hosts.js';
import { sweepExpiredStopSignals } from './sweep.js';
import { setS6NoticesAvailableForTest } from './delivery.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));
vi.mock('../bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const M = resolvers.Mutation as any;
const ctx = (userId?: string, over: Partial<Context> = {}): Context => ({ db, userId, roles: ['READER'], ...over }) as Context;

let org: { id: string; urn: string };
let app: { id: string };
let agentId: string;
let max: { id: string };
let mia: { id: string };
let ada: { id: string };
let liam: { id: string };
let dan: { id: string };
let kit: { id: string };
let orca1: { id: string };

const keyCtx = (k: { id: string }, over: Partial<Context> = {}): Context =>
  ({ db, appId: app.id, appKeyId: k.id, organizationId: org.id, roles: [], ...over }) as Context;

beforeEach(async () => {
  await cleanDb(db);
  process.env.DISABLE_TASK_MATCHER = 'true'; // no event-driven matching interleaving with the schedules
  // #2173 (R95): setting a signal is refused until the notice lane is in effect; these pins exercise the lane as on.
  setS6NoticesAvailableForTest(true);
  const n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { name: 'Race', urn: `race2170-${n}.example` }, select: { id: true, urn: true } });
  const u = (k: number, name: string) =>
    db.user.create({ data: { githubId: k * 1_000_000 + n, githubUsername: `r70-${name}-${n}`, roles: ['READER'] }, select: { id: true } });
  max = await u(81, 'max');
  mia = await u(82, 'mia');
  await db.orgMember.create({ data: { organizationId: org.id, userId: max.id, role: 'ADMIN' } });
  agentId = (await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(max.id))).id;
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` }, select: { id: true } });
  await db.appMember.create({ data: { appId: app.id, userId: mia.id, role: 'member' } });
  const w = (name: string, extra: Record<string, unknown> = {}) =>
    db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name, slug: name.toLowerCase(), role: 'engineer', heldByUserId: mia.id, heldAt: new Date(), ...extra }, select: { id: true } });
  ada = await w('Ada');
  liam = await w('Liam', { reportsToWorkerId: ada.id });
  dan = await w('Dan', { reportsToWorkerId: ada.id });
  kit = await w('Kit');
  const raw = `${APP_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  orca1 = await db.appKey.create({ data: { id: generateId(), appId: app.id, keyHash: hashAppKey(raw), keyPreview: raw.slice(-4), label: 'orca1' }, select: { id: true } });
  await M.grantAppKeyScope({}, { id: orca1.id, scope: 'host:operate', hostId: 'orca1' }, ctx(max.id));
  await M.registerHost({}, { input: { appRef: app.id, label: 'Orca 1', pollIntervalSeconds: 600, workers: [{ worker: ada.id, family: 'claude' }, { worker: dan.id, family: 'claude' }] } }, keyCtx(orca1));
});

afterEach(() => setS6NoticesAvailableForTest(false));

// ── The barrier ───────────────────────────────────────────────────────────

const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} not reached within ${ms} ms`)), ms))]);

/**
 * A client whose transactions stop right AFTER they take the App's stop fence in `mode` (the first such call), and wait
 * there, holding it, until `release()`. `reached` resolves at that moment and rejects after 5 s if it never comes.
 */
function heldAtFence(mode: 'exclusive' | 'shared') {
  let reach!: (pid: number) => void;
  let release!: () => void;
  const atBarrier = new Promise<number>((r) => { reach = r; });
  const go = new Promise<void>((r) => { release = r; });
  let fired = false;
  const wrapTx = (tx: any) => new Proxy(tx, {
    get(target, key) {
      if (key === '$executeRaw') {
        return async (...args: any[]) => {
          const out = await target.$executeRaw(...args);
          const sql = Array.isArray(args[0]) ? (args[0] as string[]).join('?') : String(args[0]);
          const shared = sql.includes('pg_advisory_xact_lock_shared');
          if (!fired && args[1] === `stop-signals:${app.id}` && (mode === 'shared') === shared) {
            fired = true;
            // The backend that now holds the fence: what the second side must be shown waiting behind.
            const [{ pid }] = await target.$queryRaw`SELECT pg_backend_pid() AS pid` as { pid: number }[];
            reach(pid);
            await go;
          }
          return out;
        };
      }
      const v = target[key];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  const client = new Proxy(db, {
    get(target, prop) {
      if (prop === '$transaction') return (fn: any, opts: any) => (target as any).$transaction((tx: any) => fn(wrapTx(tx)), opts);
      const v = (target as any)[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as typeof db;
  return { client, reached: withTimeout(atBarrier, 5000, 'the barrier'), release };
}

/**
 * Resolves once some backend of THIS database waits on THIS App's stop fence (the single-bigint advisory key
 * `hashtext('stop-signals:<appId>')`, as `lockStopFence` takes it) and `holderPid` is among the backends blocking it.
 * Rejects after `ms`. An advisory waiter on any other key, or one not blocked by `holderPid`, never satisfies it.
 */
async function blockedBehind(holderPid: number, appId: string, ms = 5000): Promise<void> {
  for (let t = 0; t < ms; t += 50) {
    const [{ n }] = await db.$queryRaw<{ n: number }[]>`
      WITH k AS (SELECT hashtext(${'stop-signals:' + appId})::bigint AS key)
      SELECT count(*)::int AS n FROM pg_locks l, k
      WHERE l.locktype = 'advisory' AND NOT l.granted AND l.objsubid = 1
        AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND l.classid::bigint = ((k.key >> 32) & 4294967295) AND l.objid::bigint = (k.key & 4294967295)
        AND ${holderPid}::int = ANY (pg_blocking_pids(l.pid))`;
    if (n > 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`no backend was seen waiting behind pid ${holderPid} on the stop fence of App ${appId}`);
}

/**
 * Run `first` held at its fence, then `second`, which must block on it; release; both settle. A refusal or a deadlock on
 * either side is returned as an error, never swallowed. `order` is only a label.
 */
async function race<A, B>(first: (c: typeof db) => Promise<A>, second: () => Promise<B>, firstMode: 'exclusive' | 'shared') {
  const h = heldAtFence(firstMode);
  const one = first(h.client).then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));
  let two: Promise<{ ok: true; v: B } | { ok: false; e: unknown }> | null = null;
  try {
    const holderPid = await h.reached;
    let secondDone = false;
    two = second().then((v) => { secondDone = true; return { ok: true as const, v }; }, (e: unknown) => { secondDone = true; return { ok: false as const, e }; });
    await blockedBehind(holderPid, app.id);
    expect(secondDone, 'the second side finished while the first held the fence').toBe(false);
  } catch (e) {
    // Never leave a held transaction behind a failed assertion: release, let both sides settle, then fail (Juliet P3).
    h.release();
    await Promise.allSettled([one, ...(two ? [two] : [])]);
    throw e;
  }
  h.release();
  return { first: await one, second: await two! };
}

/**
 * Juliet #2172 P2: `sweepExpiredStopSignals` catches a per-App failure, logs it and returns [], so "the sweep recorded
 * nothing" alone would also pass a sweep that FAILED (a deadlock included). Every sweep schedule therefore also asserts
 * that no sweep failure was logged while it ran.
 */
function sweepFailureOracle() {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  return {
    failures: () => spy.mock.calls.filter((c) => String(c[0]).startsWith('[stop-signals] expiry sweep')).length,
    restore: () => spy.mockRestore(),
  };
}
const deadlocked = (r: { ok: boolean; e?: unknown }) => !r.ok && /40P01|deadlock/i.test(String((r as any).e?.message ?? r.e));

// ── State readers ─────────────────────────────────────────────────────────

async function notices(w: { id: string }): Promise<string[]> {
  const rows = await db.agentTeamEvent.findMany({ where: { appId: app.id, type: 'stop.notice', subjectWorkerId: w.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  return rows.map((r) => {
    const p = r.payload as { level: string; notice: string; interrupt: boolean };
    return `${p.level}:${p.notice}${p.interrupt ? ':interrupt' : ''}`;
  });
}
const intervals = (w: { id: string }) => db.teamStopCoverage.findMany({ where: { workerId: w.id }, orderBy: { enteredAt: 'asc' } });
const ends = () => db.agentTeamEvent.findMany({ where: { appId: app.id, type: { in: ['stop.lifted', 'stop.expired'] } }, select: { type: true } });

const setSignal = (c: Context, input: Record<string, unknown>) => M.setTeamStopSignal({}, { input: { appRef: app.id, ...input } }, c);
const liftSignal = (c: Context, id: string) => M.liftTeamStopSignal({}, { appRef: app.id, id }, c);
const moveOut = (c: Context) => M.setWorkerReportsTo({}, { workerRef: dan.id, reportsTo: null }, c);

// ── 1. setWorkerReportsTo vs a team pause being set ───────────────────────

describe('1 — moving a worker out of a team while a team pause is set (setWorkerReportsTo fence before the graph lock)', () => {
  it('the move holds the fence first: the set waits; Dan is never covered and is told nothing', async () => {
    const r = await race((c) => moveOut(ctx(max.id, { db: c })), () => setSignal(ctx(max.id), { level: 'PAUSE', scope: 'TEAM', worker: 'Ada' }), 'exclusive');
    expect([r.first.ok, r.second.ok]).toEqual([true, true]);
    expect(await notices(dan)).toEqual([]);
    expect(await intervals(dan)).toEqual([]);
    expect(await notices(liam)).toEqual(['pause:stop']);
  });

  it('the set holds the fence first: the move waits; Dan is covered, then leaves with one resume, one closed interval', async () => {
    const r = await race((c) => setSignal(ctx(max.id, { db: c }), { level: 'PAUSE', scope: 'TEAM', worker: 'Ada' }), () => moveOut(ctx(max.id)), 'exclusive');
    expect(deadlocked(r.second), 'a deadlock is a failure, not a winner').toBe(false);
    expect([r.first.ok, r.second.ok]).toEqual([true, true]);
    expect(await notices(dan)).toEqual(['pause:stop', 'pause:resume']);
    const iv = await intervals(dan);
    expect(iv).toHaveLength(1);
    expect(iv[0]!.leftAt).not.toBeNull();
  });
});

// ── 2. retireWorker vs the team pause being lifted ────────────────────────

describe('2 — retiring a covered worker while its team pause is lifted (retireWorker fence + in-transaction reconcile)', () => {
  let pauseId: string;
  beforeEach(async () => { pauseId = (await setSignal(ctx(max.id), { level: 'PAUSE', scope: 'TEAM', worker: 'Ada' })).id; });
  const retire = (c: Context) => M.retireWorker({}, { workerRef: dan.id }, c);

  it('the retirement holds the fence first: the lift waits; Dan gets no resume; his interval closed once, by the retirement', async () => {
    const r = await race((c) => retire(ctx(max.id, { db: c })), () => liftSignal(ctx(max.id), pauseId), 'exclusive');
    expect([r.first.ok, r.second.ok]).toEqual([true, true]);
    expect(await notices(dan)).toEqual(['pause:stop']);
    const iv = await intervals(dan);
    expect(iv).toHaveLength(1);
    const signal = await db.teamStopSignal.findUniqueOrThrow({ where: { id: pauseId } });
    expect(iv[0]!.leftAt!.getTime()).toBeLessThan(signal.endedAt!.getTime()); // closed at the retirement, not at the lift
    expect(await notices(liam)).toEqual(['pause:stop', 'pause:resume']);
  });

  it('the lift holds the fence first: the retirement waits; Dan gets one resume, then nothing more; one closed interval', async () => {
    const r = await race((c) => liftSignal(ctx(max.id, { db: c }), pauseId), () => retire(ctx(max.id)), 'exclusive');
    expect([r.first.ok, r.second.ok]).toEqual([true, true]);
    expect(await notices(dan)).toEqual(['pause:stop', 'pause:resume']);
    const iv = await intervals(dan);
    expect(iv).toHaveLength(1);
    expect(iv[0]!.leftAt).not.toBeNull();
  });
});

// ── 3. registerHost vs a host halt being set ──────────────────────────────

describe('3 — a registration that adds a worker while a host halt is set (registerHost fence + in-transaction reconcile)', () => {
  const addLiam = (c: typeof db) => registerHost(c, {
    appId: app.id, hostId: 'orca1', label: 'Orca 1', pollIntervalSeconds: 600,
    workers: [{ workerId: ada.id, family: 'claude' }, { workerId: dan.id, family: 'claude' }, { workerId: liam.id, family: 'claude' }],
  } as never);

  it('the registration holds the fence first: the set waits; Liam is covered with one halt notice', async () => {
    const r = await race((c) => addLiam(c), () => setSignal(keyCtx(orca1), { level: 'HALT', scope: 'HOST' }), 'exclusive');
    expect([r.first.ok, r.second.ok]).toEqual([true, true]);
    expect(await notices(liam)).toEqual(['halt:stop:interrupt']);
    expect(await intervals(liam)).toHaveLength(1);
  });

  it('the set holds the fence first: the registration waits; Liam is covered when it commits, with one halt notice', async () => {
    const r = await race((c) => setSignal(keyCtx(orca1, { db: c }), { level: 'HALT', scope: 'HOST' }), () => addLiam(db), 'exclusive');
    expect([r.first.ok, r.second.ok]).toEqual([true, true]);
    expect(await notices(liam)).toEqual(['halt:stop:interrupt']);
    expect(await intervals(liam)).toHaveLength(1);
    expect(await notices(dan)).toEqual(['halt:stop:interrupt']);
  });
});

// ── 4. manual assignment vs a pause being set ─────────────────────────────

describe('4 — assigning a task to Dan by hand while a pause on Dan is set (inTaskWriteTx shared fence + TASK_STOPPED)', () => {
  let taskId: string;
  beforeEach(async () => { taskId = (await db.agentTask.create({ data: { appId: app.id, title: 'Hand', ownerUserId: max.id }, select: { id: true } })).id; });
  const assign = (c: Context) => M.assignAgentTask({}, { taskId, assignee: { worker: 'Dan' } }, c);
  const assignee = async () => (await db.agentTask.findUniqueOrThrow({ where: { id: taskId } })).assigneeWorkerId;

  it('the assignment holds the fence first: the set waits; the task is Dan\'s and the pause is live', async () => {
    const r = await race((c) => assign(ctx(max.id, { db: c })), () => setSignal(ctx(max.id), { level: 'PAUSE', scope: 'WORKER', worker: 'Dan' }), 'shared');
    expect([r.first.ok, r.second.ok]).toEqual([true, true]);
    expect(await assignee()).toBe(dan.id);
    expect(await db.teamStopSignal.count({ where: { appId: app.id, endedAt: null } })).toBe(1);
  });

  it('the set holds the fence first: the assignment waits, then is refused TASK_STOPPED; never both', async () => {
    const r = await race((c) => setSignal(ctx(max.id, { db: c }), { level: 'PAUSE', scope: 'WORKER', worker: 'Dan' }), () => assign(ctx(max.id)), 'exclusive');
    expect(r.first.ok).toBe(true);
    expect(r.second.ok).toBe(false);
    expect((r.second as any).e?.extensions?.code).toBe('TASK_STOPPED');
    expect(await assignee()).toBeNull();
  });
});

// ── 5. lift vs the expiry sweep ───────────────────────────────────────────

describe('5 — a lift against the expiry sweep (one end, one resume)', () => {
  let signal: { id: string; until: Date };
  beforeEach(async () => {
    const until = new Date(Date.now() + 3000);
    const s = await setSignal(ctx(max.id), { level: 'PAUSE', scope: 'WORKER', worker: 'Kit', until });
    signal = { id: s.id, until };
  });
  const sweepAfterUntil = (c: typeof db) => sweepExpiredStopSignals(c, new Date(signal.until.getTime() + 1));
  let oracle: ReturnType<typeof sweepFailureOracle>;
  beforeEach(() => { oracle = sweepFailureOracle(); });
  afterEach(() => {
    const n = oracle.failures();
    oracle.restore();
    expect(n, 'a sweep failed (logged and swallowed) while the schedule ran').toBe(0);
  });

  it('the lift holds the fence first: the sweep waits and records nothing; lifted once, one resume', async () => {
    const r = await race((c) => liftSignal(ctx(max.id, { db: c }), signal.id), () => sweepAfterUntil(db), 'exclusive');
    expect([r.first.ok, r.second.ok]).toEqual([true, true]);
    expect((r.first as any).v.changed).toBe(true);
    expect((r.second as any).v).toEqual([]);
    expect(await ends()).toEqual([{ type: 'stop.lifted' }]);
    expect(await notices(kit)).toEqual(['pause:stop', 'pause:resume']);
  });

  it('the sweep holds the fence first: the lift waits and changes nothing; expired once, one resume', async () => {
    const r = await race((c) => sweepAfterUntil(c), () => liftSignal(ctx(max.id), signal.id), 'exclusive');
    expect([r.first.ok, r.second.ok]).toEqual([true, true]);
    expect((r.first as any).v).toEqual([signal.id]);
    expect((r.second as any).v.changed).toBe(false);
    expect(await ends()).toEqual([{ type: 'stop.expired' }]);
    expect(await notices(kit)).toEqual(['pause:stop', 'pause:resume']);
  });
});

// ── 6. two sweeps ─────────────────────────────────────────────────────────

describe('6 — two expiry sweeps of one App (the sweep takes the fence exclusive)', () => {
  it('the second waits; one stop.expired and one resume per worker, whichever sweep wins', async () => {
    const oracle = sweepFailureOracle();
    const until = new Date(Date.now() + 1000);
    const s = await setSignal(ctx(max.id), { level: 'PAUSE', scope: 'TEAM', worker: 'Ada', until });
    const later = new Date(until.getTime() + 1);
    const r = await race((c) => sweepExpiredStopSignals(c, later), () => sweepExpiredStopSignals(db, later), 'exclusive');
    expect([r.first.ok, r.second.ok]).toEqual([true, true]);
    expect([...(r.first as any).v, ...(r.second as any).v]).toEqual([s.id]);
    expect(await ends()).toEqual([{ type: 'stop.expired' }]);
    for (const w of [ada, liam, dan]) expect(await notices(w)).toEqual(['pause:stop', 'pause:resume']);
    const n = oracle.failures();
    oracle.restore();
    expect(n, 'a sweep failed (logged and swallowed) while the schedule ran').toBe(0);
  });

  it('the oracle itself: an injected sweep failure returns [] AND is caught by it', async () => {
    const until = new Date(Date.now() + 500);
    await setSignal(ctx(max.id), { level: 'PAUSE', scope: 'WORKER', worker: 'Kit', until });
    const oracle = sweepFailureOracle();
    const failing = new Proxy(db, {
      get(target, prop) {
        if (prop === '$transaction') return async () => { throw new Error('injected sweep failure'); };
        const v = (target as any)[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as typeof db;
    const out = await sweepExpiredStopSignals(failing, new Date(until.getTime() + 1));
    const n = oracle.failures();
    oracle.restore();
    expect(out).toEqual([]); // indistinguishable from "nothing to record" by its result alone
    expect(n).toBe(1);
  });
});

// ── The evidence itself ───────────────────────────────────────────────────

describe('the barrier evidence (Xan #2172 LOCAL P2)', () => {
  it('a decoy: an unrelated advisory waiter, and a waiter not blocked by the holder, never satisfy it', async () => {
    let releaseHolder!: () => void;
    const held = new Promise<void>((r) => { releaseHolder = r; });
    let pidOf!: (n: number) => void;
    const holderPid = new Promise<number>((r) => { pidOf = r; });
    // A holder of an UNRELATED advisory key, and a waiter on it.
    const holder = db.$transaction(async (tx) => {
      const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'decoy:' + app.id}))`;
      pidOf(pid);
      await held;
    }, { timeout: 10_000 });
    const pid = await holderPid;
    const waiter = db.$transaction(async (tx) => { await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'decoy:' + app.id}))`; }, { timeout: 10_000 });
    try {
      await expect(blockedBehind(pid, app.id, 600)).rejects.toThrow(/no backend was seen waiting/);
      // The stop fence itself, held by another backend: still not "behind `pid`".
      const fence = heldAtFence('exclusive');
      const setting = M.setTeamStopSignal({}, { input: { appRef: app.id, level: 'PAUSE', scope: 'WORKER', worker: 'Kit' } }, ctx(max.id, { db: fence.client }));
      let second: Promise<unknown> | null = null;
      try {
        const fencePid = await fence.reached;
        second = M.setTeamStopSignal({}, { input: { appRef: app.id, level: 'PAUSE', scope: 'WORKER', worker: 'Kit' } }, ctx(max.id));
        await expect(blockedBehind(pid, app.id, 600)).rejects.toThrow(/no backend was seen waiting/);
        await blockedBehind(fencePid, app.id); // the positive control
      } finally {
        // Settle the fence's two sides whatever happened (Juliet P3).
        fence.release();
        await Promise.allSettled([setting, ...(second ? [second] : [])]);
      }
      await expect(setting).resolves.toBeTruthy();
      await expect(second!).resolves.toBeTruthy();
    } finally {
      releaseHolder();
      await holder;
      await waiter;
    }
  });
});
