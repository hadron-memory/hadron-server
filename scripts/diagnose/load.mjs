import {realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
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
  // ok = sessions actually opened: a 200 without a session id is missingSession, not ok (#4453 N2)
  const note = ({status, sid}) => { if (status === 200) { if (sid) counts.ok++; else { counts.missingSession++; if (w.close) counts.closeFailed++; } } else if (status === 429) counts.capRefused++; else counts.other++; };
  const startAt = now();
  const end = startAt + durationMs;
  // The probe rides the most recently initialized session. The server's cap rule evicts the principal's
  // least-recently-ACTIVE transport with nothing in flight (server.ts, #2261), so the first-opened,
  // never-used session is the victim — the newest is the safe probe target.
  let probeSid = null;
  if (w.hold) for (let i = 0; i < w.hold; i++) { const r = await initialize(base, key, fetchImpl); note(r); if (r.status === 200 && r.sid) probeSid = r.sid; }
  let probe = 'not exercised';
  if (w.hold && probeN > 0 && probeSid && !signal?.aborted) probe = await probeHeldSession({ base, key, sid: probeSid, n: probeN, fetchImpl, now });
  while (w.perMin && now() < end && !signal?.aborted) {
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
  if (!w.perMin) await new Promise((r) => setTimeout(r, Math.max(0, end - now())));
  return { counts, probe, startAt, endAt: now() };
}

// #4448: a simple request on a held session, timed. tools/list needs the initialized notification first
// (the same open() sequence the server's own MCP tests use); latencies are wall-clock round trips.
// #4453 BLIND review: a 200 can still carry a JSON-RPC error object — in a JSON body or an SSE data
// line. That is a failed request, not a slow one, so it counts under errors, never as a latency.
// #4453 N7: a 200 with neither a result nor an error is not a sample either.
function jsonRpcResult(text) {
  const bodies = [];
  try { bodies.push(JSON.parse(text)); } catch { /* SSE or non-JSON */ }
  for (const m of String(text).matchAll(/data:\s*(\{.*\})/g)) { try { bodies.push(JSON.parse(m[1])); } catch { /* partial line */ } }
  return bodies.some((b) => b && typeof b === 'object' && b.error === undefined && b.result !== undefined);
}

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
      const body = await res.text();
      if (res.status === 200 && jsonRpcResult(body)) latencies.push(now() - t0); else errors++;
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

/**
 * #2627: whether this module is the process's main script. Both sides are resolved to real paths, so a symlinked or
 * spaced path, and --preserve-symlinks-main (which leaves import.meta.url on the link), all compare equal. An import
 * whose argv[1] is missing, nonexistent or another file is not main, and never throws. A CLI run that this check
 * misses prints no record, and run.sh refuses a run without a positive load record (loadRecordOk), so it can never
 * pass silently.
 */
export function isMainModule(metaUrl, argv1) {
  if (!argv1) return false;
  try { return realpathSync(fileURLToPath(metaUrl)) === realpathSync(argv1); } catch { return false; }
}

const COUNT_KEYS = ['ok', 'capRefused', 'other', 'closeOk', 'closeFailed', 'missingSession'];
/**
 * #2627: positive evidence that the driver ran the requested workload. `text` is the generator's whole stdout and
 * must be exactly one load record: kind 'load', this workload, every count a non-negative integer, numeric startAt
 * and endAt, and counts that pass workloadValid. Anything else, including empty or no-op output, is not a load.
 */
export function loadRecordOk(text, workload) {
  const lines = String(text).trim().split('\n');
  if (lines.length !== 1) return false;
  let r;
  try { r = JSON.parse(lines[0]); } catch { return false; }
  if (!r || typeof r !== 'object' || Array.isArray(r) || r.kind !== 'load' || r.workload !== workload) return false;
  try { parseWorkload(workload); } catch { return false; }
  if (!COUNT_KEYS.every((k) => Number.isInteger(r[k]) && r[k] >= 0)) return false;
  if (!Number.isFinite(r.startAt) || !Number.isFinite(r.endAt)) return false;
  return workloadValid(workload, r);
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const [base, workload, durS] = process.argv.slice(2);
  const key = process.env.HADRON_DIAG_KEY;
  if (!key) { console.error('HADRON_DIAG_KEY is required'); process.exit(2); }
  // 25 mirrors the server default (src/mcp/transportBounds.ts DEFAULT_MAX_SESSIONS_PER_PRINCIPAL)
  // and compose.patch's ${DIAG_SESSION_CAP:-25}; scripts/ is standalone, so the constant cannot be
  // imported — computed once for run() and the line (#4453 BLIND review).
  const cap = Number(process.env.DIAG_SESSION_CAP) || 25;
  const { counts, probe, startAt, endAt } = await run({ base, key, workload, durationMs: Number(durS) * 1000,
    cap, probeN: Number(process.env.DIAG_PROBE_N) || 0 });
  // The session id never reaches the output; the line is counts, latencies and epoch ms only.
  const line = { kind: 'load', workload, cap, startAt, endAt, probe, ...counts };
  const text = JSON.stringify(line);
  assertSecretFree(text);
  console.log(text);
  if (!workloadValid(workload, counts)) { console.error('workload failed acceptance; diagnosis is invalid'); process.exit(5); }
}
