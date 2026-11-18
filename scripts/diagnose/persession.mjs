// #4448 runner-side per-session reductions over a produced samples file plus its load line.
// Numbers only: no session ids, principals, tokens or URLs ever reach the output.
// Absence convention (#4453 BLIND review): null = the window was known but that series is absent
// from it; 'not sampled' = unobservable or not applicable. Neither is ever zero.
import { NOT_SAMPLED } from './sampler.mjs';

const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null); // nearest-rank: upper-middle for even n
const maxOf = (xs) => (xs.length ? xs.reduce((a, b) => (b > a ? b : a), -Infinity) : null); // reduce, not spread: no stack ceiling at large sample counts

// samples: parsed `kind:"sample"` lines ({t, at, rss, heapUsed, heapTotal, external, arrayBuffers,
// eventLoop, timeouts, mcp}). load: the parsed load line ({workload, cap, ok, startAt, endAt}).
// Baseline = median RSS over the last 60 s before the load started — the run.sh settle period — so a
// boot-flushed early tail cannot set the baseline (the first #4448 run had 8 boot samples at +45 MB
// over settled, which inverted the delta's sign). With fewer than 10 settled samples it falls back to
// every pre-load sample AND SAYS SO in baselineBasis: 10 assumes the sampler's default 1 s interval
// (preload.mjs DIAG_SAMPLE_MS), and a longer interval makes the fallback the norm — that must be
// visible, not silent. Loaded = median RSS over the last 30 s of the load window (sessions still
// held: the driver keeps them open until endAt, and the server holds them past it), floored at
// startAt so a load window shorter than 30 s cannot mix pre-load samples into the loaded median.
// perSession divides that delta by the held count and exists ONLY for workload 'held' — churn,
// closed and idle never hold a full cap, so a number there would read as a measurement while being
// arithmetic. The held count is min(ok, cap): the server holds at most cap (the cap+1-th open evicts,
// server.ts #2261) and never more than actually opened. Peak RSS inside the load window rides along:
// a median can miss a transient (sweep-time allocation, the open burst).
export function perSessionLine({ samples, load }) {
  const cap = Number.isSafeInteger(load?.cap) && load.cap > 0 ? load.cap : null;
  const okOpens = Number.isSafeInteger(load?.ok) && load.ok >= 0 ? load.ok : null;
  const heldCount = load?.workload === 'held' && (okOpens !== null || cap !== null)
    ? Math.min(okOpens ?? cap, cap ?? okOpens) : null;
  const held = heldCount !== null && heldCount > 0 ? heldCount : null;
  // A missing or corrupt load line must degrade to empty windows, never throw: every output then
  // reads as not sampled / null, which is the truth (no load window is known).
  const startAt = Number.isFinite(load?.startAt) ? load.startAt : -Infinity;
  const endAt = Number.isFinite(load?.endAt) ? load.endAt : Infinity;
  const finite = samples.filter((s) => Number.isFinite(s.at));
  const settled = finite.filter((s) => s.at >= startAt - 60_000 && s.at < startAt);
  const usedSettled = settled.length >= 10;
  const pre = usedSettled ? settled : finite.filter((s) => s.at < startAt);
  const loadedWindow = finite.filter((s) => s.at > Math.max(startAt, endAt - 30_000) && s.at <= endAt);
  const med = (xs, f) => median(xs.map((s) => s[f]).filter(Number.isFinite));
  const baselineRss = med(pre, 'rss');
  const loadedRss = med(loadedWindow, 'rss');
  const inLoad = finite.filter((s) => s.at >= startAt && s.at <= endAt && Number.isFinite(s.rss));
  const peakRss = inLoad.length ? maxOf(inLoad.map((s) => s.rss)) : null;
  const last = samples.length ? samples[samples.length - 1] : null;
  const sessions = samples.map((s) => (s.mcp && s.mcp !== NOT_SAMPLED && Number.isFinite(s.mcp.sessions) ? s.mcp.sessions : null)).filter((x) => x !== null);
  const loop = (field) => loadedWindow.map((s) => (s.eventLoop && s.eventLoop !== NOT_SAMPLED && Number.isFinite(s.eventLoop[field]) ? s.eventLoop[field] : null)).filter((x) => x !== null);
  const delta = (from, to) => (Number.isFinite(from) && Number.isFinite(to) ? to - from : null);
  return {
    kind: 'perSession',
    workload: load?.workload ?? null,
    held,
    okOpens,
    baselineBasis: usedSettled ? 'settled-last-60s' : 'fallback-all-pre-load',
    baselineSamples: pre.length,
    baselineRssBytes: baselineRss,
    loadedRssBytes: loadedRss,
    peakRssDuringLoadBytes: peakRss,
    rssPerSessionBytes: held && Number.isFinite(baselineRss) && Number.isFinite(loadedRss) ? Math.round((loadedRss - baselineRss) / held) : NOT_SAMPLED,
    heapUsedDeltaBytes: delta(med(pre, 'heapUsed'), med(loadedWindow, 'heapUsed')),
    externalDeltaBytes: delta(med(pre, 'external'), med(loadedWindow, 'external')),
    arrayBuffersDeltaBytes: delta(med(pre, 'arrayBuffers'), med(loadedWindow, 'arrayBuffers')),
    sessionsMax: maxOf(sessions),
    eventLoopLoadedWindowMs: loop('p50Ms').length ? { p50MaxMs: maxOf(loop('p50Ms')), p99MaxMs: maxOf(loop('p99Ms')) } : NOT_SAMPLED,
    // Cumulative counters in the sampler: the last sample's value IS the run total.
    poolTimeouts: last?.timeouts ?? NOT_SAMPLED,
    poolWaiters: NOT_SAMPLED, // no $metrics exposure; ruled "not sampled" in #4448's gate fold-in
    basis: 'nearest-rank medians (upper-middle for even n); baseline=last 60s pre-load (fallback all pre-load — see baselineBasis); loaded=last 30s of the load window floored at startAt; perSession=(loaded-baseline)/min(ok,cap) for workload held only; peak=max rss inside the load window',
  };
}
