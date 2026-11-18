import {realpathSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import { assertSecretFree } from './sampler.mjs';
// Load driver for #2589. One principal (HADRON_DIAG_KEY from the env, never printed).
// Workloads: churn (W1/W2: initialize with no Mcp-Session-Id, never closed), closed (C1: DELETE after),
// idle (C2), held (C3: N sessions held open). Output is counts only.
// #4448: the held workload also probes request latency on a held session (tools/list round trips),
// and the load line carries startAt/endAt epoch ms so the runner can align sample windows per session.
const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'diag', version: '1' } } };

// `cap` is the server's per-principal session cap; held opens cap + 1 so it always probes eviction.
export function parseWorkload(name, cap = 25) {
  const w = { churn: { perMin: 40, close: false }, closed: { perMin: 40, close: true }, idle: { perMin: 0, close: false }, held: { perMin: 0, close: false, hold: cap + 1 } }[name];
  if (!w) throw new Error(`unknown workload: ${name}`);
  return w;
}

async function initialize(base, key, fetchImpl) {
  const res = await fetchImpl(`${base}/mcp`, { method: 'POST', body: JSON.stringify(INIT),
    headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', authorization: `Bearer ${key}` } });
  await res.text();
  return { status: res.status, sid: res.headers.get('mcp-session-id') };
}

export async function run({ base, key, workload, durationMs, signal, cap = 25, fetchImpl = fetch, probeN = 0, now = Date.now }) {
  const w = parseWorkload(workload, cap);
  const counts = { ok: 0, capRefused: 0, other: 0, closeOk: 0, closeFailed: 0, missingSession: 0 };
  const note = ({status, sid}) => { if (status === 200) { counts.ok++; if (!sid) { counts.missingSession++; if (w.close) counts.closeFailed++; } } else if (status === 429) counts.capRefused++; else counts.other++; };
  const startAt = now();
  const end = startAt + durationMs;
  // The probe rides the most recently initialized session: with cap+1 opened, the first one is the eviction victim.
  let probeSid = null;
  if (w.hold) for (let i = 0; i < w.hold; i++) { const r = await initialize(base, key, fetchImpl); note(r); if (r.status === 200 && r.sid) probeSid = r.sid; }
  let probe = 'not exercised';
  if (w.hold && probeN > 0 && probeSid && !signal?.aborted) probe = await probeHeldSession({ base, key, sid: probeSid, n: probeN, fetchImpl, now });
  while (w.perMin && Date.now() < end && !signal?.aborted) {
    const { status, sid } = await initialize(base, key, fetchImpl);
    note({status, sid});
    if (w.close && sid) {
      // A close that did not happen leaves the session open, which would invalidate the closed-vs-churn comparison.
      const r = await fetchImpl(`${base}/mcp`, { method: 'DELETE', headers: { authorization: `Bearer ${key}`, 'mcp-session-id': sid } }).catch(() => null);
      await r?.text();
      if (r && r.status >= 200 && r.status < 300) counts.closeOk++; else counts.closeFailed++;
    }
    await new Promise((r) => setTimeout(r, 60_000 / w.perMin));
  }
  if (!w.perMin) await new Promise((r) => setTimeout(r, Math.max(0, end - Date.now())));
  return { counts, probe, startAt, endAt: now() };
}

// #4448: a simple request on a held session, timed. tools/list needs the initialized notification first
// (the same open() sequence the server's own MCP tests use); latencies are wall-clock round trips.
export async function probeHeldSession({ base, key, sid, n = 50, fetchImpl = fetch, now = Date.now }) {
  const post = (body) => fetchImpl(`${base}/mcp`, { method: 'POST', body: JSON.stringify(body),
    headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', authorization: `Bearer ${key}`, 'mcp-session-id': sid } });
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }).then((r) => r.text()).catch(() => {});
  const latencies = [];
  let errors = 0;
  for (let i = 0; i < n; i++) {
    const t0 = now();
    try {
      const res = await post({ jsonrpc: '2.0', id: 2 + i, method: 'tools/list', params: {} });
      await res.text();
      if (res.status === 200) latencies.push(now() - t0); else errors++;
    } catch { errors++; }
  }
  const p = latencyPercentiles(latencies);
  return { method: 'tools/list', ...(p ?? { requests: 0 }), errors };
}

// Nearest-rank percentiles over round-trip latencies; requests is the successful count.
export function latencyPercentiles(samples) {
  if (!samples.length) return null;
  const s = [...samples].sort((a, b) => a - b);
  const at = (p) => s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
  return { requests: s.length, minMs: s[0], p50Ms: at(50), p95Ms: at(95), p99Ms: at(99), maxMs: s[s.length - 1] };
}

// A refused request is data, not evidence that a workload ran successfully.
export function workloadValid(workload, c) {
  return c.other === 0 && c.missingSession === 0 && c.closeFailed === 0
    && (workload === 'idle' || c.ok > 0)
    && (workload !== 'closed' || (c.capRefused === 0 && c.closeOk === c.ok));
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [base, workload, durS] = process.argv.slice(2);
  const key = process.env.HADRON_DIAG_KEY;
  if (!key) { console.error('HADRON_DIAG_KEY is required'); process.exit(2); }
  const { counts, probe, startAt, endAt } = await run({ base, key, workload, durationMs: Number(durS) * 1000,
    cap: Number(process.env.DIAG_SESSION_CAP) || 25, probeN: Number(process.env.DIAG_PROBE_N) || 0 });
  // The session id never reaches the output; the line is counts, latencies and epoch ms only.
  const line = { kind: 'load', workload, cap: Number(process.env.DIAG_SESSION_CAP) || 25, startAt, endAt, probe, ...counts };
  const text = JSON.stringify(line);
  assertSecretFree(text);
  console.log(text);
  if (!workloadValid(workload, counts)) { console.error('workload failed acceptance; diagnosis is invalid'); process.exit(5); }
}
