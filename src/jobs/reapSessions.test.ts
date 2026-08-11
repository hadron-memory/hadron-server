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
  let loop: { stop: () => void } | null = null;

  afterEach(() => {
    loop?.stop();
    loop = null;
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
