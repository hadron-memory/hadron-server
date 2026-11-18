// #4448: the per-session reduction over a samples file plus its load line. Pure synthetic data —
// no server, stack or private anything is touched. Pins the window maths, the held-count basis
// and the not-sampled conventions (anything unobserved is 'not sampled', never zero).
import { test, expect } from 'vitest';
import { perSessionLine } from './persession.mjs';
import { NOT_SAMPLED, assertSecretFree } from './sampler.mjs';

// Samples at t=0,1,2 before the load (baseline rss 300 median), then a loaded window in the last
// 30 s before endAt, then an idle tail after endAt that must NOT count toward the loaded median.
const s = (at, over = {}) => ({ kind: 'sample', at, rss: 100, ...over });
const samples = [
  s(1_000, { rss: 200 }), s(2_000, { rss: 300 }), s(3_000, { rss: 400 }), // baseline window: median 300
  s(70_000, { rss: 500 }), s(80_000, { rss: 700 }), s(90_000, { rss: 900 }), // loaded window: median 700
  s(95_000, { rss: 10_000 }), // after endAt: idle tail, excluded
];
const load = { kind: 'load', workload: 'held', cap: 100, ok: 101, startAt: 5_000, endAt: 90_000 };

test('divides the loaded-minus-baseline RSS delta by the held count (the cap)', () => {
  const line = perSessionLine({ samples, load });
  expect(line.kind).toBe('perSession');
  expect(line.workload).toBe('held');
  expect(line.held).toBe(100);
  expect(line.okOpens).toBe(101);
  expect(line.baselineRssBytes).toBe(300);
  expect(line.loadedRssBytes).toBe(700);
  expect(line.rssPerSessionBytes).toBe(4); // (700 - 300) / 100
  expect(line.peakRssDuringLoadBytes).toBe(900); // max inside the load window, not the median
  expect(line.basis).toContain('perSession=(loaded-baseline)/min(ok,cap)');
});

test('the baseline is the settled last 60 s before startAt, not the boot-flushed tail (the first 100-run inverted its sign)', () => {
  // 15 boot-phase samples at startAt-5 min with rss 455 MB, 15 settled samples at startAt-30 s with rss 397 MB.
  const boot = Array.from({ length: 15 }, (_, i) => s(5_000 - 300_000 + i * 1_000, { rss: 455_000 }));
  const settled = Array.from({ length: 15 }, (_, i) => s(5_000 - 30_000 + i * 1_000, { rss: 397_000 }));
  const line = perSessionLine({ samples: [...boot, ...settled, s(80_000, { rss: 411_000 })], load });
  expect(line.baselineRssBytes).toBe(397_000);
  expect(line.rssPerSessionBytes).toBe(140); // (411000 - 397000) / 100 — positive, as measured
});

test('with fewer than 10 settled samples the baseline falls back to every pre-load sample', () => {
  const few = [s(5_000 - 30_000, { rss: 397_000 }), s(5_000 - 20_000, { rss: 399_000 }), s(5_000 - 10_000, { rss: 401_000 })];
  const boot = Array.from({ length: 9 }, (_, i) => s(5_000 - 300_000 + i * 1_000, { rss: 455_000 }));
  const line = perSessionLine({ samples: [...boot, ...few, s(80_000, { rss: 500_000 })], load });
  // Median of all 12 pre-load samples — the boot tail leaks in (9 of 12 at 455k). That leak is why
  // run.sh defaults DIAG_SETTLE_S=60: a real run always has ≥10 settled samples and never falls back.
  expect(line.baselineRssBytes).toBe(455_000);
});

test('the loaded window is the last 30 s at or before endAt; the baseline strictly before startAt', () => {
  // Boundaries on purpose: 5_000 is NOT baseline (not < startAt) and 60_000 is NOT loaded (not > endAt-30s).
  const line = perSessionLine({ samples: [s(4_999, { rss: 1 }), s(5_000, { rss: 9 }), s(60_000, { rss: 7 }), s(60_001, { rss: 8 })],
    load: { workload: 'held', cap: 10, startAt: 5_000, endAt: 90_000 } });
  expect(line.baselineRssBytes).toBe(1);
  expect(line.loadedRssBytes).toBe(8);
});

test('heap/external/arrayBuffers deltas use the same two windows', () => {
  const line = perSessionLine({ samples: [
    s(1_000, { rss: 100, heapUsed: 50, external: 10, arrayBuffers: 5 }),
    s(80_000, { rss: 200, heapUsed: 90, external: 30, arrayBuffers: 20 }),
  ], load: { workload: 'held', cap: 10, startAt: 5_000, endAt: 90_000 } });
  expect(line.heapUsedDeltaBytes).toBe(40);
  expect(line.externalDeltaBytes).toBe(20);
  expect(line.arrayBuffersDeltaBytes).toBe(15);
});

test('event-loop p50/p99 are the maxima over the loaded window only', () => {
  const line = perSessionLine({ samples: [
    s(1_000, { eventLoop: { p50Ms: 999, p99Ms: 9999 } }), // baseline: excluded from loop maxima
    s(70_000, { eventLoop: { p50Ms: 3, p99Ms: 40 } }),
    s(80_000, { eventLoop: { p50Ms: 5, p99Ms: 60 } }),
    s(95_000, { eventLoop: { p50Ms: 888, p99Ms: 8888 } }), // idle tail: excluded
  ], load: { workload: 'held', cap: 10, startAt: 5_000, endAt: 90_000 } });
  expect(line.eventLoopLoadedWindowMs).toEqual({ p50MaxMs: 5, p99MaxMs: 60 });
});

test('sessionsMax is the max observed held-session count; the string not-sampled marker is skipped', () => {
  const line = perSessionLine({ samples: [
    s(1_000, { mcp: { sessions: 0 } }),
    s(70_000, { mcp: { sessions: 100 } }),
    s(80_000, { mcp: NOT_SAMPLED }),
    s(85_000, { mcp: { sessions: 99 } }),
  ], load: { workload: 'held', cap: 100, startAt: 5_000, endAt: 90_000 } });
  expect(line.sessionsMax).toBe(100);
});

test('poolTimeouts is the LAST sample\'s cumulative counters; poolWaiters stays not-sampled', () => {
  const line = perSessionLine({ samples: [
    s(1_000, { timeouts: { P2024: 1, P2028: 0 } }),
    s(80_000, { timeouts: { P2024: 2, P2028: 3 } }),
  ], load: { workload: 'held', cap: 10, startAt: 5_000, endAt: 90_000 } });
  expect(line.poolTimeouts).toEqual({ P2024: 2, P2028: 3 });
  expect(line.poolWaiters).toBe(NOT_SAMPLED); // no $metrics exposure; ruled not sampled in #4448's gate fold-in
});

test('anything unobserved degrades to not-sampled or null, never a phantom zero or NaN', () => {
  const line = perSessionLine({ samples: [s(1_000), s(80_000)], load: { workload: 'held', cap: 10, startAt: 5_000, endAt: 90_000 } });
  expect(line.rssPerSessionBytes).toBe(0); // an OBSERVED zero delta is a real zero; only absence degrades below
  const bare = perSessionLine({ samples: [s(1_000, { rss: undefined }), s(80_000, { rss: undefined })],
    load: { workload: 'held', cap: 10, startAt: 5_000, endAt: 90_000 } });
  expect(bare.baselineRssBytes).toBeNull();
  expect(bare.loadedRssBytes).toBeNull();
  expect(bare.rssPerSessionBytes).toBe(NOT_SAMPLED);
  expect(bare.heapUsedDeltaBytes).toBeNull();
  expect(bare.eventLoopLoadedWindowMs).toBe(NOT_SAMPLED);
  expect(bare.sessionsMax).toBeNull();
  expect(bare.poolTimeouts).toBe(NOT_SAMPLED);
  expect(JSON.stringify(bare)).not.toContain('NaN');
});

test('an empty or absent load line yields held=null without throwing', () => {
  expect(perSessionLine({ samples: [s(1_000)], load: null }).held).toBeNull();
  expect(perSessionLine({ samples: [], load }).held).toBe(100);
  expect(perSessionLine({ samples: [], load: null }).rssPerSessionBytes).toBe(NOT_SAMPLED);
});

// #4453 BLIND P2: a load window shorter than 30 s must not reach back before startAt for its median.
test('the loaded window is floored at startAt, so a short load cannot mix baseline samples in', () => {
  // startAt=100_000, endAt=105_000 (a 5 s load). The old window (endAt-30s = 75_000) swallowed all
  // 20 settled samples too, and their majority dragged the "loaded" median down to the baseline —
  // a per-session delta of ~0 from a run that really loaded memory.
  const settledSamples = Array.from({ length: 20 }, (_, i) => s(80_000 + i * 1_000, { rss: 300 })); // settled, pre-load
  const loadedSamples = Array.from({ length: 5 }, (_, i) => s(101_000 + i * 1_000, { rss: 700 })); // inside the load window
  const line = perSessionLine({ samples: [...settledSamples, ...loadedSamples],
    load: { workload: 'held', cap: 10, ok: 11, startAt: 100_000, endAt: 105_000 } });
  expect(line.baselineRssBytes).toBe(300);
  expect(line.loadedRssBytes).toBe(700);
  expect(line.rssPerSessionBytes).toBe(40); // (700 - 300) / 10
});

// #4453 BLIND P2: per-session arithmetic is a measurement only for the held workload.
test('a non-held workload gets no per-session division — the number would read as a measurement', () => {
  const churnLoad = { workload: 'churn', cap: 100, ok: 101, startAt: 5_000, endAt: 90_000 };
  const line = perSessionLine({ samples: [s(1_000, { rss: 300 }), s(80_000, { rss: 700 })], load: churnLoad });
  expect(line.held).toBeNull();
  expect(line.rssPerSessionBytes).toBe(NOT_SAMPLED);
  expect(line.basis).toContain('workload held only');
  // The windowed medians are still real observations and stay.
  expect(line.baselineRssBytes).toBe(300);
  expect(line.loadedRssBytes).toBe(700);
});

// #4453 BLIND P2: the divisor is min(ok, cap) — the server holds at most cap and no more than opened.
test('held with ok < cap divides by the sessions that actually opened', () => {
  const line = perSessionLine({ samples: [s(1_000, { rss: 300 }), s(80_000, { rss: 500 })],
    load: { workload: 'held', cap: 100, ok: 40, startAt: 5_000, endAt: 90_000 } });
  expect(line.held).toBe(40);
  expect(line.rssPerSessionBytes).toBe(5); // (500 - 300) / 40
  // ok=0 (nothing opened) is no basis for a division at all.
  const none = perSessionLine({ samples: [s(1_000, { rss: 300 }), s(80_000, { rss: 500 })],
    load: { workload: 'held', cap: 100, ok: 0, startAt: 5_000, endAt: 90_000 } });
  expect(none.held).toBeNull();
  expect(none.rssPerSessionBytes).toBe(NOT_SAMPLED);
});

// #4453 BLIND P2: which baseline path ran must be visible — the fallback leaks the boot tail, and a
// long DIAG_SAMPLE_MS can make it the norm instead of the exception.
test('baselineBasis records which baseline path was taken, with its sample count', () => {
  const settled = Array.from({ length: 15 }, (_, i) => s(5_000 - 30_000 + i * 1_000, { rss: 397_000 }));
  const good = perSessionLine({ samples: [...settled, s(80_000, { rss: 411_000 })], load });
  expect(good.baselineBasis).toBe('settled-last-60s');
  expect(good.baselineSamples).toBe(15);
  const few = [s(5_000 - 30_000, { rss: 397_000 }), s(5_000 - 20_000, { rss: 399_000 }), s(5_000 - 10_000, { rss: 401_000 })];
  const boot = Array.from({ length: 9 }, (_, i) => s(5_000 - 300_000 + i * 1_000, { rss: 455_000 }));
  const bad = perSessionLine({ samples: [...boot, ...few, s(80_000, { rss: 500_000 })], load });
  expect(bad.baselineBasis).toBe('fallback-all-pre-load');
  expect(bad.baselineSamples).toBe(12);
});

// #4453 BLIND P3: ok is validated exactly like cap — a corrupt count degrades to null, never to a divisor.
test('a non-integer ok degrades to null and the divisor falls back to the cap', () => {
  const line = perSessionLine({ samples: [s(1_000, { rss: 300 }), s(80_000, { rss: 700 })],
    load: { workload: 'held', cap: 100, ok: 'many', startAt: 5_000, endAt: 90_000 } });
  expect(line.okOpens).toBeNull();
  expect(line.held).toBe(100);
  expect(line.rssPerSessionBytes).toBe(4);
});

test('the emitted line is secret-free', () => {
  const line = perSessionLine({ samples: [
    s(1_000, { rss: 100, mcp: { sessions: 1 }, timeouts: { P2024: 0, P2028: 0 }, eventLoop: { p50Ms: 1, p99Ms: 2 } }),
    s(80_000, { rss: 300, mcp: { sessions: 10 }, timeouts: { P2024: 1, P2028: 0 }, eventLoop: { p50Ms: 2, p99Ms: 3 } }),
  ], load });
  const text = JSON.stringify(line);
  expect(() => assertSecretFree(text)).not.toThrow();
  expect(text).not.toContain('mcp-session-id');
});
