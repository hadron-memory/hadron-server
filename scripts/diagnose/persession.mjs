// #4448 runner-side per-session reductions over a produced samples file plus its load line.
// Numbers only: no session ids, principals, tokens or URLs ever reach the output.
import { NOT_SAMPLED } from './sampler.mjs';

const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
const maxOf = (xs) => (xs.length ? Math.max(...xs) : null);

// samples: parsed `kind:"sample"` lines ({t, at, rss, heapUsed, heapTotal, external, arrayBuffers,
// eventLoop, timeouts, mcp}). load: the parsed load line ({workload, cap, ok, startAt, endAt}).
// Baseline = median RSS over the last 60 s before the load started — the run.sh settle period — so a
// boot-flushed early tail cannot set the baseline (the first #4448 run had 8 boot samples at +45 MB
// over settled, which inverted the delta's sign); with fewer than 10 samples there it falls back to
// every pre-load sample. Loaded = median RSS over the last 30 s of the load window (sessions still
// held: the driver keeps them open until endAt, and the server holds them past it). perSession
// divides that delta by the held count (the cap; the cap+1-th open evicts). Peak RSS inside the
// load window rides along: a median can miss a transient (sweep-time allocation, the open burst).
export function perSessionLine({ samples, load }) {
  const held = Number.isSafeInteger(load?.cap) && load.cap > 0 ? load.cap : null;
  // A missing or corrupt load line must degrade to empty windows, never throw: every output then
  // reads as not sampled / null, which is the truth (no load window is known).
  const startAt = Number.isFinite(load?.startAt) ? load.startAt : -Infinity;
  const endAt = Number.isFinite(load?.endAt) ? load.endAt : Infinity;
  const finite = samples.filter((s) => Number.isFinite(s.at));
  const settled = finite.filter((s) => s.at >= startAt - 60_000 && s.at < startAt);
  const pre = settled.length >= 10 ? settled : finite.filter((s) => s.at < startAt);
  const loadedWindow = finite.filter((s) => s.at > endAt - 30_000 && s.at <= endAt);
  const med = (xs, f) => median(xs.map((s) => s[f]).filter(Number.isFinite));
  const baselineRss = med(pre, 'rss');
  const loadedRss = med(loadedWindow, 'rss');
  const inLoad = finite.filter((s) => s.at >= startAt && s.at <= endAt && Number.isFinite(s.rss));
  const peakRss = inLoad.length ? Math.max(...inLoad.map((s) => s.rss)) : null;
  const last = samples.length ? samples[samples.length - 1] : null;
  const sessions = samples.map((s) => (s.mcp && s.mcp !== NOT_SAMPLED && Number.isFinite(s.mcp.sessions) ? s.mcp.sessions : null)).filter((x) => x !== null);
  const loop = (field) => loadedWindow.map((s) => (s.eventLoop && s.eventLoop !== NOT_SAMPLED && Number.isFinite(s.eventLoop[field]) ? s.eventLoop[field] : null)).filter((x) => x !== null);
  const delta = (from, to) => (Number.isFinite(from) && Number.isFinite(to) ? to - from : null);
  return {
    kind: 'perSession',
    workload: load?.workload ?? null,
    held,
    okOpens: load?.ok ?? null,
    baselineRssBytes: baselineRss,
    loadedRssBytes: loadedRss,
    peakRssDuringLoadBytes: peakRss,
    rssPerSessionBytes: held && Number.isFinite(baselineRss) && Number.isFinite(loadedRss) ? Math.round((loadedRss - baselineRss) / held) : NOT_SAMPLED,
    heapUsedDeltaBytes: delta(baselineRss === null ? null : med(pre, 'heapUsed'), med(loadedWindow, 'heapUsed')),
    externalDeltaBytes: delta(baselineRss === null ? null : med(pre, 'external'), med(loadedWindow, 'external')),
    arrayBuffersDeltaBytes: delta(baselineRss === null ? null : med(pre, 'arrayBuffers'), med(loadedWindow, 'arrayBuffers')),
    sessionsMax: maxOf(sessions),
    eventLoopLoadedWindowMs: loop('p50Ms').length ? { p50MaxMs: maxOf(loop('p50Ms')), p99MaxMs: maxOf(loop('p99Ms')) } : NOT_SAMPLED,
    // Cumulative counters in the sampler: the last sample's value IS the run total.
    poolTimeouts: last?.timeouts ?? NOT_SAMPLED,
    poolWaiters: NOT_SAMPLED, // no $metrics exposure; ruled "not sampled" in #4448's gate fold-in
    basis: 'median rss, last 60s pre-load (fallback: all pre-load); 30s loaded window; perSession=(loaded-baseline)/held; peak=max rss inside load window',
  };
}
