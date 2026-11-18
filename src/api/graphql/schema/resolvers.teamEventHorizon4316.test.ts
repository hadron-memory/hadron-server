/**
 * #4316 (follow-up to #4195/#4098), items 1 and 2, red first:
 * 1. A forward read that comes back short while committed events of the App are held back at or above
 *    the horizon logs one `team_events.horizon_lag` line (App id, count, oldest age in ms) — at most
 *    once per App per minute per process — and changes nothing about the page it returns.
 * 2. The `after` cursor is validated in one statement and its key is passed into the forward statement,
 *    so a cursor row deleted between the two statements still continues from its key (cor:api:120:05:
 *    a cursor survives the deletion of the row it continues from).
 * This file sets its own test timeout (30 s) instead of importing one as a side effect (#4316 item 3).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { teamEventHorizonSettled } from './resolvers.agentTask.js';
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
    const pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    let open = false;
    try {
      await pg.query('BEGIN');
      open = true;
      await pg.query('SELECT pg_current_xact_id()'); // assigns this connection's xid, holding xmin
      const held = await event(Date.now() - 60_000); // committed, 60 s old, at or above the held horizon
      expect(lagLines(log)).toEqual([]); // nothing logged yet: no read has happened
      // #4372 fold (the vacuous-assertion P2s): the newest-first read comes FIRST — before any forward read
      // of this App — and its silence is asserted after the probe has settled, so the once-per-minute limit
      // cannot be the reason nothing appears. Dropping the !newestFirst guard makes this red on its own.
      await resolvers.Query.agentTeamEvents({}, { appRef: appId, limit: 10, newestFirst: true }, context());
      await teamEventHorizonSettled();
      expect(lagLines(log)).toEqual([]); // a newest-first read is not a forward read: no line
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
    } finally {
      if (open) await pg.query('ROLLBACK');
      await pg.end();
    }
  });

  it('the page sibling logs too (its read is the same forward read), on its App, when it comes back short', async () => {
    await event(T);
    await settle();
    const pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
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
    } finally {
      if (open) await pg.query('ROLLBACK');
      await pg.end();
    }
  });

  it('a held-back event younger than the 30 s floor stays silent (#4372 fold: the age gate is pinned)', async () => {
    await event(T);
    await settle();
    const pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
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
      const del = new Client({ connectionString: process.env.DATABASE_URL });
      await del.connect();
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
