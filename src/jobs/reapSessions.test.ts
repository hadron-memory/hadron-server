/**
 * runSessionReaper — ONE rule since #1114: hard expiry (`expiresAt` in the
 * past), a promise made at session start. Reaping stamps BOTH `endedAt` and
 * `autoExpiredAt`, so "active" stays `endedAt IS NULL` everywhere.
 *
 * The inactivity rule was REMOVED, and the second suite below is the guard on
 * that: every case that used to end a session now asserts it survives. Those
 * inversions are the point of the change rather than a side effect —
 * "silence is not evidence of abandonment" is only true if nothing acts on
 * silence, and a sweep that used to is the thing most likely to grow the
 * behaviour back.
 *
 * The scheduling test at the bottom is deliberate: the asset janitor
 * shipped with no scheduler at all (#888), so proving the loop fires is
 * part of this deliverable, not a nicety.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import type { SessionType } from '../generated/prisma/index.js';
import {
  runSessionReaper,
  startSessionReaperLoop,
  type SessionReaperLoop,
} from './reapSessions.js';
import { idleWindowMsFor } from '../lib/sessionActivity.js';

const HOUR = 60 * 60 * 1000;
const now = new Date('2026-08-11T12:00:00.000Z');
const ago = (ms: number) => new Date(now.getTime() - ms);

/** Insert a session with explicit lifecycle timestamps. */
async function seedSession(over: {
  type?: SessionType;
  startedAt?: Date;
  updatedAt?: Date | null;
  expiresAt?: Date | null;
  endedAt?: Date | null;
  deletedAt?: Date | null;
}) {
  return db.session.create({
    data: {
      id: generateId(),
      type: over.type ?? 'DEVELOPER',
      startedAt: over.startedAt ?? ago(48 * HOUR),
      updatedAt: over.updatedAt ?? null,
      expiresAt: over.expiresAt ?? null,
      endedAt: over.endedAt ?? null,
      deletedAt: over.deletedAt ?? null,
    },
  });
}

/** Attribute a usage event to a session at a given instant. */
async function seedUsage(sessionId: string, createdAt: Date) {
  return db.usageEvent.create({
    data: { countsAsActivity: true, id: generateId(), type: 'write', sessionId, createdAt },
  });
}

const reload = (id: string) => db.session.findUniqueOrThrow({ where: { id } });

beforeEach(async () => {
  await cleanDb(db);
  delete process.env.SESSION_IDLE_WINDOW_MS;
  for (const t of ['DEVELOPER', 'CHATBOT', 'AUTOMATION', 'EDGE']) {
    delete process.env[`SESSION_IDLE_WINDOW_${t}_MS`];
  }
});

describe('hard expiry — the one rule that survives (#1114)', () => {
  it('ends a session past expiresAt, stamping endedAt and autoExpiredAt together', async () => {
    const s = await seedSession({ startedAt: ago(HOUR), expiresAt: ago(10 * 60 * 1000) });

    const outcome = await runSessionReaper(db, now);

    expect(outcome.expired).toBe(1);
    const reaped = await reload(s.id);
    expect(reaped.endedAt).toEqual(now);
    expect(reaped.autoExpiredAt).toEqual(now);
  });

  it('leaves a session whose expiresAt is still in the future', async () => {
    const s = await seedSession({ startedAt: ago(HOUR), expiresAt: new Date(now.getTime() + HOUR) });

    const outcome = await runSessionReaper(db, now);

    expect(outcome.expired).toBe(0);
    expect((await reload(s.id)).endedAt).toBeNull();
  });

  it('does not relabel an explicitly ended session as auto-expired', async () => {
    const endedAt = ago(2 * HOUR);
    const s = await seedSession({ startedAt: ago(6 * HOUR), expiresAt: ago(3 * HOUR), endedAt });

    await runSessionReaper(db, now);

    const after = await reload(s.id);
    expect(after.endedAt).toEqual(endedAt);
    expect(after.autoExpiredAt).toBeNull();
  });

  it('is idempotent — a second sweep reaps nothing', async () => {
    await seedSession({ expiresAt: ago(HOUR) });
    // The second session is idle but has no hard expiry: since #1114 it is
    // not a candidate at all, so the first sweep reaps exactly one.
    await seedSession({ startedAt: ago(72 * HOUR) });

    const first = await runSessionReaper(db, now);
    const second = await runSessionReaper(db, now);

    expect(first.expired).toBe(1);
    expect(second.expired).toBe(0);
  });

  it('ignores soft-deleted sessions', async () => {
    const s = await seedSession({ expiresAt: ago(HOUR), deletedAt: ago(HOUR) });

    const outcome = await runSessionReaper(db, now);

    expect(outcome.expired).toBe(0);
    expect((await reload(s.id)).endedAt).toBeNull();
  });
});

describe('inactivity is NEVER a reason to end a session (#1114)', () => {
  /**
   * Holger's ruling, and the case that decides it: "If I have my personal
   * taxes agent, I use it once a year." Every test here seeds a session the
   * OLD inactivity rule would have ended, and asserts it is still open.
   *
   * Asserting `autoExpiredAt` stays null alongside `endedAt` is deliberate:
   * the old rule stamped both together, so a partial regression that ended
   * sessions without labelling them would slip past an `endedAt`-only check.
   */
  const stillOpen = async (id: string) => {
    const row = await reload(id);
    expect(row.endedAt).toBeNull();
    expect(row.autoExpiredAt).toBeNull();
  };

  it('spares a session whose last activity is far outside any idle window', async () => {
    const s = await seedSession({ startedAt: ago(72 * HOUR), updatedAt: ago(72 * HOUR) });
    const outcome = await runSessionReaper(db, now);
    expect(outcome.expired).toBe(0);
    await stillOpen(s.id);
  });

  it('spares a session idle for a YEAR — the taxes-agent case, stated literally', async () => {
    const year = 365 * 24 * HOUR;
    const s = await seedSession({ startedAt: ago(year), updatedAt: ago(year) });
    await runSessionReaper(db, now);
    await stillOpen(s.id);
  });

  it('spares it for every session type, not just DEVELOPER', async () => {
    const types: SessionType[] = ['DEVELOPER', 'CHATBOT', 'AUTOMATION', 'EDGE'];
    const ids: string[] = [];
    for (const type of types) {
      ids.push((await seedSession({ type, startedAt: ago(72 * HOUR), updatedAt: ago(72 * HOUR) })).id);
    }
    await runSessionReaper(db, now);
    for (const id of ids) await stillOpen(id);
  });

  it('spares it even with the idle window configured to something tiny', async () => {
    // The window survives as a DISPLAY setting. If it still reached the
    // reaper, a one-second window would end everything — which is exactly how
    // this rule would grow back unnoticed.
    process.env.SESSION_IDLE_WINDOW_MS = '1000';
    process.env.SESSION_IDLE_WINDOW_DEVELOPER_MS = '1000';
    const s = await seedSession({ startedAt: ago(72 * HOUR), updatedAt: ago(72 * HOUR) });
    const outcome = await runSessionReaper(db, now);
    expect(outcome.expired).toBe(0);
    await stillOpen(s.id);
  });

  it('spares a session with no usage events at all', async () => {
    const s = await seedSession({ startedAt: ago(90 * HOUR), updatedAt: null });
    await runSessionReaper(db, now);
    await stillOpen(s.id);
  });

  it('still ends an idle session that ALSO carries a past hard expiry', async () => {
    // The two are independent: dropping inactivity must not weaken a promise
    // made at session start, which is the one ending that was never an
    // inference.
    const s = await seedSession({
      startedAt: ago(72 * HOUR),
      updatedAt: ago(72 * HOUR),
      expiresAt: ago(1 * HOUR),
    });
    const outcome = await runSessionReaper(db, now);
    expect(outcome.expired).toBe(1);
    const row = await reload(s.id);
    expect(row.endedAt).not.toBeNull();
    expect(row.autoExpiredAt).not.toBeNull();
  });
});

describe('startSessionReaperLoop', () => {
  // The exported type, not a hand-written shape: a local `{ stop: () => void }`
  // silently kept compiling after stop() became async (#1091), so the drain
  // could have been dropped without tsc noticing here.
  let loop: SessionReaperLoop | null = null;

  afterEach(async () => {
    await loop?.stop();
    loop = null;
  });

  it('stop() resolves only once an in-flight sweep has finished (#1091)', async () => {
    // The flake this closes is a DEADLOCK IN AN UNRELATED FILE. Clearing the
    // timer stops the loop STARTING work; a sweep already in flight kept
    // writing from a floating promise nobody held. In the suite that lands in
    // whatever file runs next on the same worker DB — its `cleanDb` begins
    // deleting while this sweep is still updating sessions, and Postgres
    // reports `40P01` against a file that never touched the reaper.
    //
    // The sweep is made SLOW deliberately. A first draft simply stopped the
    // loop and looked for a late write, and it passed WITHOUT the fix: the
    // real sweep finishes in a millisecond, so there was no in-flight work to
    // leak and the assertion could never fail. A guard whose failing input
    // cannot be constructed proves nothing — so this holds the sweep open and
    // asserts the property directly: stop() must not resolve first.
    // A HARD-EXPIRED session, not an idle one: since #1114 inactivity is not a
    // candidate at all, so an idle seed would leave the sweep nothing to do and
    // these loop tests would pass while observing nothing.
    await seedSession({ expiresAt: new Date(Date.now() - HOUR) });

    const HOLD_MS = 200;
    let sweepFinished = false;
    let stopResolvedAt = 0;
    // Delay the sweep's FIRST query, so a sweep is provably in flight when
    // stop() is called. Only `session.findMany` is intercepted; everything
    // else passes through to the real client.
    const slowDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== 'session') return Reflect.get(target, prop, receiver);
        const session = Reflect.get(target, prop, receiver) as typeof db.session;
        return new Proxy(session, {
          get(sTarget, sProp, sReceiver) {
            const orig = Reflect.get(sTarget, sProp, sReceiver);
            if (sProp !== 'findMany' || typeof orig !== 'function') return orig;
            return async (...args: unknown[]) => {
              await new Promise((r) => setTimeout(r, HOLD_MS));
              return (orig as (...a: unknown[]) => Promise<unknown>).apply(sTarget, args);
            };
          },
        });
      },
    }) as typeof db;

    loop = startSessionReaperLoop(slowDb, 10_000, 1);
    // Let the timer fire so a sweep is in flight and blocked in the slow query.
    await new Promise((r) => setTimeout(r, 30));

    const started = Date.now();
    const stopping = loop.stop().then(() => {
      stopResolvedAt = Date.now();
    });
    // Mark when the sweep's own work completes, independently of stop().
    void new Promise((r) => setTimeout(r, HOLD_MS)).then(() => {
      sweepFinished = true;
    });

    await stopping;
    loop = null;

    // stop() waited for the sweep rather than returning while it was still
    // writing. Without the drain it resolves in ~0ms and this is false.
    expect(sweepFinished).toBe(true);
    expect(stopResolvedAt - started).toBeGreaterThanOrEqual(HOLD_MS / 2);
  });

  it('stop() still drains when the sweep outlasts the interval (#1108 review)', async () => {
    // @codex P2 on the first version of the drain. When a sweep runs longer
    // than `intervalMs`, the next tick calls run(), which returns IMMEDIATELY
    // on the inFlight guard — and the naive `running = run().finally(...)`
    // then replaced the real sweep's promise with that resolved one and nulled
    // it, so stop() awaited nothing and resolved while the sweep was still
    // writing. The drain recreated the very race it was added to close.
    //
    // Interval deliberately SHORTER than the sweep, which is the case the
    // first test could not reach.
    // A HARD-EXPIRED session, not an idle one: since #1114 inactivity is not a
    // candidate at all, so an idle seed would leave the sweep nothing to do and
    // these loop tests would pass while observing nothing.
    await seedSession({ expiresAt: new Date(Date.now() - HOUR) });

    const HOLD_MS = 300;
    const INTERVAL_MS = 40;
    let sweepFinished = false;
    const slowDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== 'session') return Reflect.get(target, prop, receiver);
        const session = Reflect.get(target, prop, receiver) as typeof db.session;
        return new Proxy(session, {
          get(sTarget, sProp, sReceiver) {
            const orig = Reflect.get(sTarget, sProp, sReceiver);
            if (sProp !== 'findMany' || typeof orig !== 'function') return orig;
            return async (...args: unknown[]) => {
              await new Promise((r) => setTimeout(r, HOLD_MS));
              const out = await (orig as (...a: unknown[]) => Promise<unknown>).apply(sTarget, args);
              sweepFinished = true;
              return out;
            };
          },
        });
      },
    }) as typeof db;

    loop = startSessionReaperLoop(slowDb, INTERVAL_MS, 1);
    // Long enough that several ticks have been SKIPPED by the inFlight guard
    // while the first sweep is still blocked.
    await new Promise((r) => setTimeout(r, INTERVAL_MS * 3));
    expect(sweepFinished).toBe(false); // the sweep really is still in flight

    await loop.stop();
    loop = null;

    expect(sweepFinished).toBe(true);
  });

  it('fires on its own schedule (the #888 no-scheduler lesson)', async () => {
    // Idle by real "now", not the fixture instant — the loop calls
    // runSessionReaper with no `now` argument, which is the production path.
    const s = await seedSession({ expiresAt: new Date(Date.now() - HOUR) });

    loop = startSessionReaperLoop(db, 10_000, 5);

    const deadline = Date.now() + 5_000;
    let ended: Date | null = null;
    while (Date.now() < deadline && ended === null) {
      await new Promise((r) => setTimeout(r, 25));
      ended = (await reload(s.id)).endedAt;
    }
    expect(ended).not.toBeNull();
    expect((await reload(s.id)).autoExpiredAt).not.toBeNull();
  });
});
