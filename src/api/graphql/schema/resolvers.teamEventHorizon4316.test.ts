/**
 * #4316 (follow-up to #4195/#4098), items 1 and 2, red first:
 * 1. A forward read that comes back short while committed events of the App are held back at or above
 *    the horizon logs one `team_events.horizon_lag` line (App id, count, oldest age in ms) — at most
 *    once per App per minute per process — and changes nothing about the page it returns.
 * 2. The `after` cursor is validated in one statement and its key is passed into the forward statement,
 *    so a cursor row deleted between the two statements still continues from its key (cor:api:120:05:
 *    a cursor survives the deletion of the row it continues from).
 * This file sets its own test timeout (30 s) instead of importing one as a side effect (#4316 item 3).
 * #4372 fold 2: every raw-pg fixture goes through openPg() — a leaked BEGIN pins the CLUSTER-wide xmin
 * (see openPg), so the file force-closes its fixtures in afterEach and lets the server reap wedged ones.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { readFileSync } from 'node:fs';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { logStalledHorizon, readTeamEvents, teamEventHorizonSettled } from './resolvers.agentTask.js';
import { settleTeamEventHorizon, useTeamEventHorizonTimeout } from '../../../test/teamEventHorizon.js';

useTeamEventHorizonTimeout(); // this file's two-connection pins wait on the horizon

const T = Date.UTC(2026, 10, 1);
let appId: string, userId: string;
const context = (over: Partial<Context> = {}): Context => ({ db, userId, roles: ['READER'], ...over });
const event = (at: number, app = appId) => db.agentTeamEvent.create({ data: { appId: app, type: 'task.created', createdAt: new Date(at) } });
const settle = () => settleTeamEventHorizon(db);

/** One `team_events.horizon_lag` line per console.log spy call, parsed; other lines are dropped. */
const lagLines = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('team_events.horizon_lag')).map((l) => JSON.parse(l) as Record<string, unknown>);

/**
 * #4408 item 4: the probe's own fault line, same shape of helper. A silence assertion that reads only
 * `lagLines` cannot tell "the probe ran and found nothing" from "the probe errored" — the two lines are
 * distinct events, and quiet must mean quiet on both.
 */
const probeErrorLines = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('team_events.horizon_probe_error')).map((l) => JSON.parse(l) as Record<string, unknown>);

/**
 * #4372 fold 2 (Peter #114889): every raw-pg fixture this file opens, so a timed-out or hung test cannot leak
 * one as 'idle in transaction'. xmin is CLUSTER-WIDE on the shared test Postgres, so one leaked BEGIN blocks
 * every horizon-settling run on the host, not just this file (observed twice: review-4372 and wt4372, both
 * wedged mid-test with the fixture's BEGIN still open). Two nets: afterEach force-ends whatever a test failed
 * to close (its own `finally` stays the primary close), and each connection sets
 * idle_in_transaction_session_timeout so the SERVER reaps a backend whose process never runs again.
 */
const pgFixtures: Client[] = [];
const openPg = async (): Promise<Client> => {
  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  await pg.query("SET idle_in_transaction_session_timeout = '30s'");
  // Baylor P3: a server-side reap (the timeout above) makes the client emit 'error'; with no listener that
  // is an uncaught exception that fails an UNRELATED test. The listener makes the reap visible to the net
  // (end/destroy) instead of to the process.
  pg.on('error', () => {});
  pgFixtures.push(pg);
  return pg;
};
/** Runs after the net has closed the fixtures, inside afterEach: a holder the net failed to release fails
 * the test here (a query on a closed client rejects), so the net is itself pinned (#4372 fold 2, Peter #114929). */
let afterNet: (() => Promise<void>) | null = null;
afterEach(async () => {
  while (pgFixtures.length) {
    const pg = pgFixtures.pop()!;
    // end() when the client answers (the ordinary case); destroy the socket when it is wedged, so a stuck
    // client can never keep the vitest process alive — the process-level hang observed on this host.
    // (`connection.stream` is a pg-internal field — tolerated deliberately: it is the load-bearing half of
    // the net, and it type-checks; a pg upgrade that drops it fails HERE loudly, not silently. Baylor P3.)
    let giveUp: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([pg.end().catch(() => {}), new Promise<void>((r) => { giveUp = setTimeout(r, 1_000); })]);
    clearTimeout(giveUp);
    pg.connection?.stream?.destroy();
  }
  // Baylor P3: reset BEFORE awaiting — a rejecting net must not re-run in the next test's afterEach.
  const net = afterNet;
  afterNet = null;
  await net?.();
});

beforeEach(async () => {
  await cleanDb(db);
  userId = (await db.user.create({ data: { email: `${generateId()}@horizon4316.test` } })).id;
  appId = (await db.app.create({ data: { ownerUserId: userId, name: 'Horizon', urn: `${generateId().toLowerCase()}:h4316` } })).id;
});

describe('#4316 item 1: a stalled horizon becomes visible on one log line', () => {
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { log = vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { log.mockRestore(); });

  it('a short forward read logs team_events.horizon_lag once, with the App, the count and the oldest age; the page is unchanged', async () => {
    const served = await event(T); // below the horizon: written before the hold opens
    await settle();
    const pg = await openPg();
    let open = false;
    try {
      await pg.query('BEGIN');
      open = true;
      await pg.query('SELECT pg_current_xact_id()'); // assigns this connection's xid, holding xmin
      const held = await event(Date.now() - 60_000); // committed, 60 s old, at or above the held horizon
      expect(lagLines(log)).toEqual([]); // nothing logged yet: no read has happened
      expect(probeErrorLines(log)).toEqual([]); // #4408 item 4: and no fault either
      // #4372 fold (the vacuous-assertion P2s): the newest-first read comes FIRST — before any forward read
      // of this App — and its silence is asserted after the probe has settled, so the once-per-minute limit
      // cannot be the reason nothing appears. Dropping the !newestFirst guard makes this red on its own.
      await resolvers.Query.agentTeamEvents({}, { appRef: appId, limit: 10, newestFirst: true }, context());
      await teamEventHorizonSettled();
      expect(lagLines(log)).toEqual([]); // a newest-first read is not a forward read: no line
      expect(probeErrorLines(log)).toEqual([]); // #4408 item 4
      const rows = await resolvers.Query.agentTeamEvents({}, { appRef: appId, limit: 10 }, context());
      await teamEventHorizonSettled(); // the probe is fire-and-forget: settle before reading the spy
      // The log changes nothing: the page is exactly the below-horizon row, byte-identical in shape.
      expect(rows).toEqual([{ ...await db.agentTeamEvent.findUniqueOrThrow({ where: { id: served.id } }), taskHandle: null }]);
      const lines = lagLines(log);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ event: 'team_events.horizon_lag', appId, heldBack: 1 });
      expect(lines[0].oldestAgeMs).toBeGreaterThan(30_000);
      expect(lines[0].oldestAgeMs).toBeLessThan(300_000);
      // The line carries the App id, the count and the age — never any event content.
      expect(Object.keys(lines[0]).sort()).toEqual(['appId', 'at', 'event', 'heldBack', 'oldestAgeMs']);
      void held;
      // A second read of the same App within the minute neither checks nor logs anything (once per App per
      // minute per process — the stamp is on the check, so the second poll does not even run the query).
      expect(await resolvers.Query.agentTeamEvents({}, { appRef: appId, limit: 10 }, context())).toEqual(rows);
      await teamEventHorizonSettled();
      expect(lagLines(log)).toHaveLength(1);
      expect(probeErrorLines(log)).toEqual([]); // #4408 item 4: the probe that logged succeeded, not faulted
      await pg.query('ROLLBACK');
      open = false;
      await settle();
      // #4372 fold: the after-the-hold silence is asserted on a FRESH App (never checked, never logged), so
      // the rate limit is not the reason nothing appears — a check that ignored the horizon filter would
      // still see this App's old below-horizon event and log.
      const afterApp = (await db.app.create({ data: { ownerUserId: userId, name: 'After', urn: `${generateId().toLowerCase()}:a4316` } })).id;
      await db.agentTeamEvent.create({ data: { appId: afterApp, type: 'task.created', createdAt: new Date(T) } });
      await settle();
      await resolvers.Query.agentTeamEvents({}, { appRef: afterApp, limit: 10 }, context());
      await teamEventHorizonSettled();
      expect(lagLines(log)).toHaveLength(1); // nothing held back any more: a short read logs nothing
      expect(probeErrorLines(log)).toEqual([]); // #4408 item 4: and never a fault line
    } finally {
      if (open) await pg.query('ROLLBACK');
      await pg.end();
    }
  });

  it('the page sibling logs too (its read is the same forward read), on its App, when it comes back short', async () => {
    await event(T);
    await settle();
    const pg = await openPg();
    let open = false;
    try {
      await pg.query('BEGIN');
      open = true;
      await pg.query('SELECT pg_current_xact_id()');
      await event(Date.now() - 60_000);
      const page = await resolvers.Query.agentTeamEventsPage({}, { appRef: appId, limit: 10 }, context());
      await teamEventHorizonSettled();
      expect(page.hasMore).toBe(false);
      expect(page.events).toHaveLength(1);
      expect(lagLines(log)).toHaveLength(1);
      expect(lagLines(log)[0]).toMatchObject({ event: 'team_events.horizon_lag', appId, heldBack: 1 });
      expect(probeErrorLines(log)).toEqual([]); // #4408 item 4
    } finally {
      if (open) await pg.query('ROLLBACK');
      await pg.end();
    }
  });

  it('a held-back event younger than the 30 s floor stays silent (#4372 fold: the age gate is pinned)', async () => {
    await event(T);
    await settle();
    const pg = await openPg();
    let open = false;
    try {
      await pg.query('BEGIN');
      open = true;
      await pg.query('SELECT pg_current_xact_id()');
      await event(Date.now() - 5_000); // committed and held back, but younger than HORIZON_LAG_MIN_AGE_MS
      const rows = await resolvers.Query.agentTeamEvents({}, { appRef: appId, limit: 10 }, context());
      await teamEventHorizonSettled();
      expect(rows).toHaveLength(1); // the below-horizon row only; the young held row is not served
      expect(lagLines(log)).toEqual([]); // young lag is not yet worth a line — dropping the floor makes this red
      expect(probeErrorLines(log)).toEqual([]); // #4408 item 4: silence is silence on both lines
    } finally {
      if (open) await pg.query('ROLLBACK');
      await pg.end();
    }
  });

  it('a caught-up App runs the check once per window, not on every poll (#4372 fold: the stamp is on the check)', async () => {
    await event(T); // nothing held back: the App is healthy, so no line — but the probe still runs once
    await settle();
    let checks = 0;
    const hooked = Object.create(db) as typeof db;
    const realQueryRaw = db.$queryRaw.bind(db) as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>;
    (hooked as unknown as { $queryRaw: typeof db.$queryRaw }).$queryRaw = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      // The horizon check is the only statement naming "heldBack"; the forward read and the cursor lookup differ.
      const out = realQueryRaw(strings, ...values);
      if (strings.join('').includes('"heldBack"')) checks += 1;
      return out;
    }) as typeof db.$queryRaw;
    for (let i = 0; i < 3; i++) await resolvers.Query.agentTeamEvents({}, { appRef: appId, limit: 10 }, context({ db: hooked }));
    await teamEventHorizonSettled();
    expect(checks).toBe(1); // the first poll checks; the next two are inside the window and check nothing
    expect(lagLines(log)).toEqual([]); // and a healthy App never logs
    expect(probeErrorLines(log)).toEqual([]); // #4408 item 4
  });

  it('a slow check never delays the page it explains (#4372 fold: the probe is not awaited)', async () => {
    await event(T);
    await settle();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const hooked = Object.create(db) as typeof db;
    const realQueryRaw = db.$queryRaw.bind(db) as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>;
    (hooked as unknown as { $queryRaw: typeof db.$queryRaw }).$queryRaw = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const out = realQueryRaw(strings, ...values);
      // Only the horizon check is gated; the page's own statements pass straight through.
      return strings.join('').includes('"heldBack"') ? gate.then(() => out) : out;
    }) as typeof db.$queryRaw;
    const page = resolvers.Query.agentTeamEvents({}, { appRef: appId, limit: 10 }, context({ db: hooked }));
    // The gate stays closed while the page is awaited: the page must settle without the probe ever
    // finishing. Awaiting the probe (the pre-fold shape) leaves this await unresolved behind the gate and
    // the test times out red here — no wall-clock bound, so host load cannot produce a false red or green.
    const rows = await page;
    expect(rows).toHaveLength(1);
    release();
    await teamEventHorizonSettled();
  });

  it('a failed assertion still releases its xmin holder (#4372 fold 2: the net is pinned)', async () => {
    // The two host outages (#114929) were tests that failed mid-body and never reached their own finally,
    // leaving a BEGIN open that pinned the CLUSTER-wide xmin until someone killed the process. This pin
    // fails an assertion with the holder open on purpose (caught, so the file stays green), leaves the
    // fixture unclosed exactly as an abandoned body would, and lets afterEach's net prove the release:
    // afterNet's query on the client must reject once the net has ended it.
    const pg = await openPg();
    await pg.query('BEGIN');
    await pg.query('SELECT pg_current_xact_id()'); // the xid-holding shape of every other fixture here
    let failed = false;
    try {
      expect('a body that fails here').toBe('still holds the BEGIN open'); // a real failed assertion
    } catch {
      failed = true; // the body's failure path taken; its own finally (in other tests) is bypassed on timeout
    }
    expect(failed).toBe(true);
    expect(pgFixtures).toContain(pg); // still registered: this test deliberately does not close it
    afterNet = async () => { await expect(pg.query('SELECT 1')).rejects.toThrow(); }; // the net released it
    // The body now ends with the holder OPEN — only the afterEach net can release it.
  });

  it('inside a transaction the check runs on the root pooled client, never the read transaction (#4372 fold 2)', async () => {
    // Bob's P2 / Peter #114870: under `withReadableApp`'s App-key arm the whole read runs inside
    // `inKeyReadTx`'s transaction, where `c.db` is the TRANSACTION client. An un-awaited probe on it
    // outlives the resolver's return: the transaction commits under the query, Prisma rejects it P2028
    // ("Transaction already closed") and the probe's own catch swallows that — a silent no-op in exactly
    // the incident's error class. This pin drives the shared read through a REAL interactive transaction —
    // the same shape the key arm serves it in — with the read's own client the transaction client and the
    // probe's client the ROOT pooled one, so the seam is pinned directly: with the probe on `c.db` (the
    // pre-fold-2 shape) the "heldBack" statement is issued on the transaction client, the root client
    // never sees it, and this goes red however the race with the commit lands.
    await event(T); // below the horizon: written before the hold opens
    await settle();
    const pg = await openPg();
    let open = false;
    let rootChecks = 0;
    // A true stand-in for the root client — NOT Object.create(db): the extended client is a proxy-family
    // object whose prototype CAPTURES property writes, so an Object.create(db) "hook" lands on the SHARED
    // client itself and every consumer (root, transaction client, resolver context) sees it — verified in
    // isolation; that leak is exactly what makes client identity un-pinnable through the shared client.
    // A fresh object exposing only the seam logStalledHorizon uses ($queryRaw) isolates the probe's
    // client by construction: under the pre-fold-2 shape the probe would run on `c.db` (the transaction
    // client) and this object would never see the statement.
    const realQueryRaw = db.$queryRaw.bind(db) as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>;
    const probeDb = {
      $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
        // The horizon check is the only statement naming "heldBack"; it is counted only when THIS object runs it.
        if (strings.join('').includes('"heldBack"')) rootChecks += 1;
        return realQueryRaw(strings, ...values);
      },
    } as unknown as Context['db'];
    let rows: Awaited<ReturnType<typeof readTeamEvents>> = [];
    try {
      await pg.query('BEGIN');
      open = true;
      await pg.query('SELECT pg_current_xact_id()'); // assigns this connection's xid, holding xmin
      await event(Date.now() - 60_000); // committed, 60 s old, held back at the horizon
      // The read's own statements run on the transaction client (as under the key arm); the probe is
      // handed the ROOT client beside them — exactly what the resolver threads through as probeDb.
      await db.$transaction(async (tx) => {
        rows = await readTeamEvents({ db: tx } as unknown as Context, { id: appId }, { appRef: appId, limit: 10 } as never, 10, probeDb);
      });
      await teamEventHorizonSettled();
      expect(rows).toHaveLength(1); // the below-horizon row only: the page is unchanged
      expect(rootChecks).toBe(1); // the check ran on the ROOT pooled client, not the read's transaction
      expect(lagLines(log)).toHaveLength(1); // and it was not swallowed: the line landed
      expect(lagLines(log)[0]).toMatchObject({ event: 'team_events.horizon_lag', appId, heldBack: 1 });
      expect(probeErrorLines(log)).toEqual([]); // #4408 item 4: the root-client check succeeded, not faulted
    } finally {
      if (open) await pg.query('ROLLBACK');
      await pg.end();
    }
  });

  it('both resolver call sites thread the ROOT pooled client to the probe (#4372 fold 3)', () => {
    // Bob's P2 (the #4372 LOCAL delta at 9c5f46462; Baylor's and Celine's P3s agree): reverting a resolver
    // call site to `c.db` is the ORIGINAL regression and survives every runtime pin — verified by his run.
    // The wiring cannot be pinned at runtime instead: under the App-key arm the transaction client is
    // created INSIDE withReadableApp (no test-visible object), hooking the shared client infects it
    // (findings:objectcreate-db-standin-infects-client), and a behavioral key-arm pin is racy — an
    // un-awaited probe on the transaction client races the commit, and one that completes inside the
    // transaction logs the same line as one on the root client. A real key-arm read "through the resolver
    // that goes red when c.db is passed" (Peter #115033's preferred shape) is therefore NOT deterministic,
    // so the call sites are pinned at the source. This goes red the moment either call site passes anything
    // but `ctx.db`, and the length pin forces a third caller to be pinned too.
    const src = readFileSync(new URL('./resolvers.agentTask.ts', import.meta.url), 'utf8');
    const callSites = src.split('\n').filter((line) => line.includes('readTeamEvents(c, app, args'));
    expect(callSites).toHaveLength(2); // agentTeamEvents and its Page sibling
    for (const call of callSites) {
      expect(call).toContain('ctx.db'); // the request's root pooled client, threaded as probeDb
      expect(call).not.toMatch(/\bc\.db\b/); // the transaction client under the key arm — the incident
    }
  });
});

describe('#4408: the #4372 review follow-ups (eviction, timer clear, sanitized fault line)', () => {
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { log = vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { log.mockRestore(); });

  /**
   * A stand-in root client for the direct seam, same isolation idea as the fold-2 pin below:
   * logStalledHorizon touches only $queryRaw, so a fresh object exposing exactly that surface proves
   * which client ran the statement and lets the test decide what the statement does.
   */
  const probeDbOf = (onQuery: (appId: string) => Promise<unknown>) =>
    ({ $queryRaw: ((_strings: TemplateStringsArray, ...values: unknown[]) => onQuery(String(values[0]))) }) as unknown as Context['db'];

  it('past the 1_000-App cap the throttle map evicts the oldest entry only — every other App keeps its window (#4408 item 1)', async () => {
    const checks = new Map<string, number>();
    const probeDb = probeDbOf((app) => {
      checks.set(app, (checks.get(app) ?? 0) + 1);
      return Promise.resolve([]); // no held-back rows: the probe runs, logs nothing, settles at once
    });
    // Fill PAST the cap: earlier tests in this file leave a few real stamps in the same module-level map,
    // which cannot be read or reset, so the fill overshoots by more than any of them (well under a dozen)
    // to put the assertions on known ground — the overshoot's validity bound is ~480 stale stamps.
    for (let i = 0; i < 1_020; i++) await logStalledHorizon(probeDb, `evict-app-${i}`);
    expect(checks.size).toBe(1_020); // every App checked exactly once, whatever the map held at the start
    await logStalledHorizon(probeDb, 'evict-app-new'); // a NEW App arrives while the map is at its cap
    // evict-app-0 is the least-recently-checked of the fill: main's clear-all wipes it, #4408's eviction
    // takes exactly it (any earlier-test stamps are older still and go first). Either way its window is
    // gone and it re-checks — a "fix" that just grew the cap would leave it throttled, so this stays red.
    await logStalledHorizon(probeDb, 'evict-app-0');
    expect(checks.get('evict-app-0')).toBe(2);
    // A mid-fill App keeps its window under eviction. RED on main: the clear-all wiped evict-app-500's
    // stamp when the fill crossed the cap, so it re-checked too — the burst the issue describes.
    await logStalledHorizon(probeDb, 'evict-app-500');
    expect(checks.get('evict-app-500')).toBe(1);
    expect(lagLines(log)).toEqual([]); // the stub serves no rows: nothing logs either way
    expect(probeErrorLines(log)).toEqual([]);
  });

  it('a failed probe leaves no armed 5 s statement-race timer (#4408 item 2)', async () => {
    // Only the two timer primitives are faked: Date.now stays real (the window math must not move), and the
    // probe settles through microtasks alone. Pre-#4408 the clearTimeout sat on the success path only, so a
    // probe that faulted left the unref'd timer armed — invisible to the log, visible to the fake clock.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const fault = Object.assign(new Error('statements can fail'), { name: 'PrismaClientKnownRequestError', code: 'P2028' });
      await logStalledHorizon(probeDbOf(() => Promise.reject(fault)), 'timer-error-app-4408');
      expect(vi.getTimerCount()).toBe(0); // RED pre-#4408: the race timer is still armed on the error path
      expect(probeErrorLines(log)).toHaveLength(1); // and the fault is the visible kind
    } finally {
      vi.useRealTimers();
    }
  });

  it('the 5 s race rejects into the catch and the line names the timeout by class, never by message (#4408 item 3)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const wedged = logStalledHorizon(probeDbOf(() => new Promise(() => {})), 'timer-race-app-4408'); // a statement that never returns
      await vi.advanceTimersByTimeAsync(5_000); // the race fires at its bound instead of waiting for the statement
      await wedged;
      const lines = probeErrorLines(log);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ event: 'team_events.horizon_probe_error', appId: 'timer-race-app-4408', errorName: 'HorizonProbeTimeoutError' });
      // RED pre-#4408: the line carried the message string under `error` and had no errorName at all.
      expect(Object.keys(lines[0]).sort()).toEqual(['appId', 'at', 'errorName', 'event', 'ms']); // no errorCode, never the message
    } finally {
      vi.useRealTimers();
    }
  });

  it('a probe fault line carries the error class and code, never the message (#4408 item 3)', async () => {
    const sentinelHost = 'postgresql://secret-probe-host-4408.example:5432/hadron';
    // The REAL installed shapes (@prisma/client runtime client.d.mts): PrismaClientInitializationError
    // declares `errorCode?: string` and NO `code` — P1001 (DB unreachable, the usual probe fault) rides
    // `errorCode`. PrismaClientKnownRequestError declares `code: string` (P2028 et al). The first fixture
    // below used `code` on the init shape, which is why this pin passed before Jonas's BLIND P2 on #4433.
    const initFault = Object.assign(new Error(`connect ECONNREFUSED ${sentinelHost}`), { name: 'PrismaClientInitializationError', errorCode: 'P1001' });
    await logStalledHorizon(probeDbOf(() => Promise.reject(initFault)), 'sanitize-app-4408');
    const knownFault = Object.assign(new Error('statements can fail'), { name: 'PrismaClientKnownRequestError', code: 'P2028' });
    await logStalledHorizon(probeDbOf(() => Promise.reject(knownFault)), 'sanitize-app-4408-known');
    const lines = probeErrorLines(log);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ event: 'team_events.horizon_probe_error', appId: 'sanitize-app-4408', errorName: 'PrismaClientInitializationError', errorCode: 'P1001' }); // RED at 917f732fd: the catch read only `code`
    expect(lines[1]).toMatchObject({ event: 'team_events.horizon_probe_error', appId: 'sanitize-app-4408-known', errorName: 'PrismaClientKnownRequestError', errorCode: 'P2028' });
    const serialized = JSON.stringify(lines[0]);
    expect(serialized).not.toContain(sentinelHost); // RED pre-#4408: the raw message named the DB host
    expect(serialized).not.toContain('ECONNREFUSED');
    expect(Object.keys(lines[0]).sort()).toEqual(['appId', 'at', 'errorCode', 'errorName', 'event', 'ms']);
    expect(Object.keys(lines[1]).sort()).toEqual(['appId', 'at', 'errorCode', 'errorName', 'event', 'ms']);
    // A non-Error throw names its kind and carries no code — nothing to leak, nothing to invent.
    await logStalledHorizon(probeDbOf(() => Promise.reject('boom')), 'sanitize-app-4408-string');
    const all = probeErrorLines(log);
    expect(all).toHaveLength(3);
    expect(all[2]).toMatchObject({ event: 'team_events.horizon_probe_error', appId: 'sanitize-app-4408-string', errorName: 'string' });
    expect(all[2]).not.toHaveProperty('errorCode');
    expect(JSON.stringify(all[2])).not.toContain('boom'); // RED pre-#4408: String(error) put it in the line
  });
});

describe('#4316 item 2: the validated cursor key survives the cursor row (cor:api:120:05)', () => {
  /**
   * Deletes `rowId` from agent_team_events the moment the after-cursor validation lookup has returned,
   * on the read's own db handle (a prototype-overriding stand-in, so every other property is the real
   * client). The single delete bypasses the append-only trigger in this test's own connection, as
   * production deletions only ever happen with the owning App already gone. The main-branch shape
   * (a `findFirst` validation) and the fixed shape (a raw key lookup) are both hooked, so the pin runs
   * red on main and green on the fix with the same test.
   */
  const deletingCursorRowAfterValidation = (rowId: string) => {
    const hooked = Object.create(db) as typeof db;
    let armed = true;
    const deleteOnce = async () => {
      if (!armed) return;
      armed = false;
      const del = await openPg();
      try {
        await del.query('SET session_replication_role = replica');
        await del.query('DELETE FROM agent_team_events WHERE id = $1', [rowId]);
      } finally {
        await del.end();
      }
    };
    // Bound originals, captured once: the extended client's methods must run with their own receiver,
    // never detached through the stand-in's prototype chain.
    const realFindFirst = db.agentTeamEvent.findFirst.bind(db.agentTeamEvent);
    const realQueryRaw = db.$queryRaw.bind(db) as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>;
    (hooked as unknown as { agentTeamEvent: typeof db.agentTeamEvent }).agentTeamEvent = new Proxy(db.agentTeamEvent, {
      get(model, prop) {
        if (prop === 'findFirst') {
          return async (...args: unknown[]) => {
            const out = await realFindFirst(...(args as [never]));
            await deleteOnce();
            return out;
          };
        }
        // The delegate's own receiver, never the proxy: an accessor re-read through the proxy would loop.
        return Reflect.get(model, prop, model);
      },
    });
    hooked.$queryRaw = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('');
      // The after-cursor key lookup names the table, reads one row, and carries no xmin predicate; the
      // forward statement, the lag check and the settle helper all carry pg_snapshot_xmin or other tables.
      const isValidation = sql.includes('FROM agent_team_events') && !sql.includes('pg_snapshot_xmin') && sql.includes('LIMIT 1');
      const out = realQueryRaw(strings, ...values);
      if (isValidation) return out.then(async (rows) => { await deleteOnce(); return rows; });
      return out;
    }) as typeof db.$queryRaw;
    return hooked;
  };

  it('a cursor row deleted after validation still continues from its key', async () => {
    const anchor = await event(T);
    const later = [await event(T + 1000), await event(T + 2000)];
    await settle();
    const hooked = deletingCursorRowAfterValidation(anchor.id);
    const rows = await resolvers.Query.agentTeamEvents({}, { appRef: appId, after: anchor.id, limit: 10 }, context({ db: hooked }));
    expect(rows.map((r: { id: string }) => r.id)).toEqual(later.map((e) => e.id));
    // The row really is gone — the page continued from a key, not from re-reading the row.
    expect(await db.agentTeamEvent.findFirst({ where: { id: anchor.id } })).toBeNull();
  });

  it('the page sibling continues from the deleted row\'s key too', async () => {
    const anchor = await event(T);
    const later = [await event(T + 1000), await event(T + 2000)];
    await settle();
    const hooked = deletingCursorRowAfterValidation(anchor.id);
    const page = await resolvers.Query.agentTeamEventsPage({}, { appRef: appId, after: anchor.id, limit: 10 }, context({ db: hooked }));
    expect(page.events.map((e: { id: string }) => e.id)).toEqual(later.map((e) => e.id));
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('an unknown cursor and another App\'s cursor are still refused (byte-identically)', async () => {
    const mine = await event(T);
    const otherUser = (await db.user.create({ data: { email: `${generateId()}@other4316.test` } })).id;
    const otherApp = (await db.app.create({ data: { ownerUserId: otherUser, name: 'Other', urn: `${generateId().toLowerCase()}:o4316` } })).id;
    const theirs = await db.agentTeamEvent.create({ data: { appId: otherApp, type: 'task.created', createdAt: new Date(T) } });
    await settle();
    const code = async (p: Promise<unknown>) => {
      try { await p; } catch (e) { expect(e).toBeInstanceOf(GraphQLError); return { code: (e as GraphQLError).extensions?.code as string, message: (e as Error).message }; }
      return undefined;
    };
    expect(await code(resolvers.Query.agentTeamEvents({}, { appRef: appId, after: generateId(), limit: 10 }, context())))
      .toEqual({ code: 'BAD_USER_INPUT', message: 'after is not an event of this App. Pass the id of the last event you read.' });
    expect(await code(resolvers.Query.agentTeamEvents({}, { appRef: appId, after: theirs.id, limit: 10 }, context())))
      .toEqual({ code: 'BAD_USER_INPUT', message: 'after is not an event of this App. Pass the id of the last event you read.' });
    expect(await code(resolvers.Query.agentTeamEvents({}, { appRef: appId, after: mine.id, limit: 10 }, context()))).toBeUndefined();
  });
});
