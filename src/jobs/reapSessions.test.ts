/**
 * runSessionReaper (#930) — the janitor `Session.expiresAt` and
 * `Session.autoExpiredAt` always claimed existed. Two rules: hard expiry
 * (`expiresAt` in the past) and inactivity (no heartbeat inside the type's
 * idle window, where a heartbeat is `startedAt` / `updatedAt` / the latest
 * attributed `UsageEvent`). Reaping stamps BOTH `endedAt` and
 * `autoExpiredAt`, so "active" stays `endedAt IS NULL` everywhere.
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
  idleWindowMsFor,
  DEFAULT_SESSION_IDLE_WINDOW_MS,
  type SessionReaperLoop,
} from './reapSessions.js';

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
    data: { id: generateId(), type: 'write', sessionId, createdAt },
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

describe('idle window configuration', () => {
  it('defaults to 24h for every type, per-type override beats the fleet default', () => {
    expect(idleWindowMsFor('DEVELOPER')).toBe(DEFAULT_SESSION_IDLE_WINDOW_MS);
    process.env.SESSION_IDLE_WINDOW_MS = String(2 * HOUR);
    expect(idleWindowMsFor('DEVELOPER')).toBe(2 * HOUR);
    expect(idleWindowMsFor('CHATBOT')).toBe(2 * HOUR);
    process.env.SESSION_IDLE_WINDOW_CHATBOT_MS = String(HOUR);
    expect(idleWindowMsFor('CHATBOT')).toBe(HOUR);
    expect(idleWindowMsFor('DEVELOPER')).toBe(2 * HOUR);
  });

  it('ignores a malformed override rather than reaping everything or nothing', () => {
    process.env.SESSION_IDLE_WINDOW_MS = 'twenty minutes';
    expect(idleWindowMsFor('DEVELOPER')).toBe(DEFAULT_SESSION_IDLE_WINDOW_MS);
    process.env.SESSION_IDLE_WINDOW_MS = '-1';
    expect(idleWindowMsFor('DEVELOPER')).toBe(DEFAULT_SESSION_IDLE_WINDOW_MS);
  });
});

describe('rule 1 — hard expiry', () => {
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
    await seedSession({ startedAt: ago(72 * HOUR) });

    const first = await runSessionReaper(db, now);
    const second = await runSessionReaper(db, now);

    expect(first.expired + first.idle).toBe(2);
    expect(second.expired + second.idle).toBe(0);
  });

  it('ignores soft-deleted sessions', async () => {
    const s = await seedSession({ expiresAt: ago(HOUR), deletedAt: ago(HOUR) });

    const outcome = await runSessionReaper(db, now);

    expect(outcome.expired).toBe(0);
    expect((await reload(s.id)).endedAt).toBeNull();
  });
});

describe('rule 2 — inactivity', () => {
  it('ends a session whose last activity predates its idle window', async () => {
    const s = await seedSession({ startedAt: ago(30 * HOUR) });

    const outcome = await runSessionReaper(db, now);

    expect(outcome.idle).toBe(1);
    const reaped = await reload(s.id);
    expect(reaped.endedAt).toEqual(now);
    expect(reaped.autoExpiredAt).toEqual(now);
  });

  it('spares a session started long ago but touched recently (updateSession heartbeat)', async () => {
    const s = await seedSession({ startedAt: ago(30 * HOUR), updatedAt: ago(HOUR) });

    const outcome = await runSessionReaper(db, now);

    expect(outcome.idle).toBe(0);
    expect((await reload(s.id)).endedAt).toBeNull();
  });

  it('spares a session whose own columns are stale but which has recent usage', async () => {
    const s = await seedSession({ startedAt: ago(30 * HOUR) });
    await seedUsage(s.id, ago(20 * 60 * 1000));

    const outcome = await runSessionReaper(db, now);

    // Never even a candidate: the heartbeat check is IN the query, so a busy
    // session cannot occupy a slot in the batch (PR-933 Codex P2).
    expect(outcome.examined).toBe(0);
    expect(outcome.idle).toBe(0);
    expect((await reload(s.id)).endedAt).toBeNull();
  });

  it('does not end a session that comes back to life between selection and claim', async () => {
    // The claim re-applies the full selecting predicate, so a heartbeat that
    // lands mid-sweep spares the row instead of losing the race (PR-933).
    const s = await seedSession({ startedAt: ago(30 * HOUR) });
    let raced = false;
    const spy = db.session.findMany.bind(db.session);
    const patched = async (...args: Parameters<typeof spy>) => {
      const result = await spy(...args);
      // Fire once, right after the query that selected this session as a
      // candidate — i.e. in the window between selection and the claim.
      if (!raced && Array.isArray(result) && result.some((r) => r.id === s.id)) {
        raced = true;
        await seedUsage(s.id, ago(60_000)); // the driver is still working
      }
      return result;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db.session as any).findMany = patched;
    try {
      const outcome = await runSessionReaper(db, now);
      expect(outcome.examined).toBe(1);
      expect(outcome.idle).toBe(0);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (db.session as any).findMany = spy;
    }
    const after = await reload(s.id);
    expect(after.endedAt).toBeNull();
    expect(after.autoExpiredAt).toBeNull();
  });

  it('reaps when the latest attributed usage is itself outside the window', async () => {
    const s = await seedSession({ startedAt: ago(72 * HOUR) });
    await seedUsage(s.id, ago(70 * HOUR));
    await seedUsage(s.id, ago(48 * HOUR));

    const outcome = await runSessionReaper(db, now);

    expect(outcome.idle).toBe(1);
    expect((await reload(s.id)).autoExpiredAt).toEqual(now);
  });

  it('never applies the idle window to a session that carries a hard expiry', async () => {
    // A CHATBOT session with a long App timeout: rule 1 owns it, and an
    // idle window must not end it early.
    const s = await seedSession({
      type: 'CHATBOT',
      startedAt: ago(72 * HOUR),
      expiresAt: new Date(now.getTime() + HOUR),
    });

    const outcome = await runSessionReaper(db, now);

    expect(outcome.idle).toBe(0);
    expect((await reload(s.id)).endedAt).toBeNull();
  });

  it('honors the per-type window — a short CHATBOT window leaves DEVELOPER alone', async () => {
    process.env.SESSION_IDLE_WINDOW_CHATBOT_MS = String(HOUR);
    const chat = await seedSession({ type: 'CHATBOT', startedAt: ago(3 * HOUR) });
    const dev = await seedSession({ type: 'DEVELOPER', startedAt: ago(3 * HOUR) });

    const outcome = await runSessionReaper(db, now);

    expect(outcome.idle).toBe(1);
    expect((await reload(chat.id)).autoExpiredAt).toEqual(now);
    expect((await reload(dev.id)).endedAt).toBeNull();
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
    await seedSession({ startedAt: new Date(Date.now() - 30 * HOUR) });

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
    await seedSession({ startedAt: new Date(Date.now() - 30 * HOUR) });

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
    const s = await seedSession({ startedAt: new Date(Date.now() - 30 * HOUR) });

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
