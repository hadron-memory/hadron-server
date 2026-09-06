/**
 * #1114 / #1120 review — the liveness derivation's own unit surface.
 *
 * `recentlyTouchedFilter` is the half a reviewer is most likely to "simplify":
 * it looks like a duplicate of `isSessionLive` and is deliberately WIDER. If it
 * ever narrows to match, a live session gets excluded before the exact
 * predicate is asked, and a busy worker reads as free — the failure direction
 * that matters, and one no test of `isSessionLive` alone would catch.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  isSessionLive,
  idleWindowMsFor,
  recentlyTouchedFilter,
  OPEN_SESSION_SCAN_CAP,
  DEFAULT_SESSION_IDLE_WINDOW_MS,
} from './sessionActivity.js';

const HOUR = 60 * 60 * 1000;
const NOW = new Date('2026-09-01T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

afterEach(() => {
  delete process.env.SESSION_IDLE_WINDOW_MS;
  for (const t of ['DEVELOPER', 'CHATBOT', 'AUTOMATION', 'EDGE']) {
    delete process.env[`SESSION_IDLE_WINDOW_${t}_MS`];
  }
});

describe('idle window configuration', () => {
  it('defaults to 24h for every type; per-type beats the fleet default', () => {
    expect(idleWindowMsFor('DEVELOPER')).toBe(DEFAULT_SESSION_IDLE_WINDOW_MS);
    process.env.SESSION_IDLE_WINDOW_MS = String(2 * HOUR);
    expect(idleWindowMsFor('DEVELOPER')).toBe(2 * HOUR);
    process.env.SESSION_IDLE_WINDOW_DEVELOPER_MS = String(5 * HOUR);
    expect(idleWindowMsFor('DEVELOPER')).toBe(5 * HOUR);
    expect(idleWindowMsFor('CHATBOT')).toBe(2 * HOUR);
  });

  it('ignores a malformed override rather than treating everything as idle', () => {
    process.env.SESSION_IDLE_WINDOW_MS = 'soon';
    expect(idleWindowMsFor('DEVELOPER')).toBe(DEFAULT_SESSION_IDLE_WINDOW_MS);
  });
});

describe('isSessionLive', () => {
  const base = { type: 'DEVELOPER' as const, startedAt: ago(48 * HOUR) };

  it('an ENDED session is never live, however recently it was driven', () => {
    expect(isSessionLive({ ...base, updatedAt: NOW, endedAt: NOW }, null, NOW)).toBe(false);
  });

  it('an open session driven inside the window is live', () => {
    expect(isSessionLive({ ...base, updatedAt: ago(HOUR) }, null, NOW)).toBe(true);
  });

  it('an open session outside the window is not live — but is not ended either', () => {
    expect(isSessionLive({ ...base, updatedAt: ago(48 * HOUR) }, null, NOW)).toBe(false);
  });

  it('a usage event alone is enough', () => {
    expect(isSessionLive({ ...base, updatedAt: ago(48 * HOUR) }, ago(HOUR), NOW)).toBe(true);
  });

  it('ignores updatedAt on an auto-expired row (the reaper stamped it)', () => {
    const reaped = { ...base, updatedAt: NOW, autoExpiredAt: NOW, endedAt: NOW };
    expect(isSessionLive(reaped, null, NOW)).toBe(false);
  });
});

describe('recentlyTouchedFilter is TYPE-AWARE, so a cap can only drop live rows', () => {
  type Arm = { type: string; OR: { startedAt?: { gte: Date }; updatedAt?: { gte: Date }; events?: unknown }[] };
  const arms = (now: Date) => (recentlyTouchedFilter(now) as unknown as { OR: Arm[] }).OR;

  it('gives each type its OWN cutoff, not one shared widest window', () => {
    // The regression this pins (#1120 review, Codex P2): with a single widest
    // cutoff, rows STALE for their own type are admitted, fill a
    // `startedAt DESC` cap, and push out an older row that is genuinely live
    // under a longer window. The binder then permits a takeover while the
    // uncapped roster SQL still says taken.
    process.env.SESSION_IDLE_WINDOW_MS = String(1 * HOUR);
    process.env.SESSION_IDLE_WINDOW_EDGE_MS = String(100 * HOUR);

    const byType = new Map(arms(NOW).map((a) => [a.type, a]));
    const cutoffOf = (t: string) =>
      NOW.getTime() - byType.get(t)!.OR[0].startedAt!.gte.getTime();

    expect(cutoffOf('DEVELOPER')).toBe(1 * HOUR);
    expect(cutoffOf('EDGE')).toBe(100 * HOUR);
    // The tell for the old behaviour: every type sharing one number.
    expect(cutoffOf('DEVELOPER')).not.toBe(cutoffOf('EDGE'));
  });

  it('covers every session type, so none falls outside the filter entirely', () => {
    const types = arms(NOW).map((a) => a.type).sort();
    expect(types).toEqual(['AUTOMATION', 'CHATBOT', 'DEVELOPER', 'EDGE']);
  });

  it('each arm admits all three heartbeat inputs, including usage events', () => {
    for (const arm of arms(NOW)) {
      const keys = arm.OR.flatMap((o) =>
        Object.entries(o).filter(([, v]) => v !== undefined).map(([k]) => k),
      ).sort();
      // Dropping the events arm would miss a session driven entirely through
      // surfaces that write provenance rather than touching the row (#1081).
      expect(keys, `${arm.type} arm`).toEqual(['events', 'startedAt', 'updatedAt']);
    }
  });

  it('agrees with isSessionLive on the boundary rows the cap then orders', () => {
    // Filter and predicate must now select the SAME set — that agreement is
    // what makes capping safe, because everything admitted is genuinely a
    // candidate and the cap can only choose between live rows.
    process.env.SESSION_IDLE_WINDOW_DEVELOPER_MS = String(2 * HOUR);
    const inside = { type: 'DEVELOPER' as const, startedAt: ago(1 * HOUR) };
    const outside = { type: 'DEVELOPER' as const, startedAt: ago(3 * HOUR) };
    expect(isSessionLive(inside, null, NOW)).toBe(true);
    expect(isSessionLive(outside, null, NOW)).toBe(false);

    const devArm = arms(NOW).find((a) => a.type === 'DEVELOPER')!;
    const cutoff = devArm.OR[0].startedAt!.gte;
    expect(inside.startedAt.getTime()).toBeGreaterThanOrEqual(cutoff.getTime());
    expect(outside.startedAt.getTime()).toBeLessThan(cutoff.getTime());
  });

  it('the scan cap is a backstop, not the primary bound', () => {
    expect(OPEN_SESSION_SCAN_CAP).toBeGreaterThan(0);
  });
});

describe('every open-session scan pairs the filter with the cap (#1120 review)', () => {
  /**
   * Three call sites now derive liveness from open rows, and each must bound
   * that scan the SAME way: filter first, cap only as a backstop.
   *
   * This is a source-level assertion because the failure is silent and
   * behavioural tests cannot reach it — it needs more than
   * OPEN_SESSION_SCAN_CAP open sessions on one worker to show up, and by then
   * the symptom is one surface saying `free` while two say `taken`.
   *
   * It caught a real regression: the first fix for the MCP read took the cap
   * WITHOUT the filter, in the same commit whose message argued that a cap
   * alone is the wrong fix. Knowing a rule and reaching for it are separate
   * skills, so this reaches for it mechanically.
   */
  it('no scan takes the cap without the filter', async () => {
    const { readFileSync } = await import('node:fs');
    const files = [
      '../mcp/server.ts',
      '../api/graphql/schema/resolvers.mutation.session.ts',
    ];
    for (const rel of files) {
      const src = readFileSync(new URL(rel, import.meta.url), 'utf8');
      const caps = src.split('OPEN_SESSION_SCAN_CAP').length - 1;
      // One import mention plus one use per scan; every use must sit in a
      // query that also names the filter.
      if (caps === 0) continue;
      const filters = src.split('recentlyTouchedFilter').length - 1;
      expect(filters, `${rel}: uses the cap but not the filter`).toBeGreaterThan(0);

      // Tighter: each `take: OPEN_SESSION_SCAN_CAP` must have a
      // recentlyTouchedFilter within the same findMany call.
      for (const idx of [...src.matchAll(/take: OPEN_SESSION_SCAN_CAP/g)].map((m) => m.index!)) {
        const callStart = src.lastIndexOf('findMany({', idx);
        expect(callStart, `${rel}: cap outside a findMany`).toBeGreaterThan(-1);
        expect(
          src.slice(callStart, idx),
          `${rel}: a scan caps without filtering first`,
        ).toContain('recentlyTouchedFilter');
      }
    }
  });
});
