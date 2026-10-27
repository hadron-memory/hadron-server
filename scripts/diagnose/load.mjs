import {realpathSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
// Load driver for #2589. One principal (HADRON_DIAG_KEY from the env, never printed).
// Workloads: churn (W1/W2: initialize with no Mcp-Session-Id, never closed), closed (C1: DELETE after),
// idle (C2), held (C3: N sessions held open). Output is counts only.
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

export async function run({ base, key, workload, durationMs, signal, cap = 25, fetchImpl = fetch }) {
  const w = parseWorkload(workload, cap);
  const counts = { ok: 0, capRefused: 0, other: 0, closeOk: 0, closeFailed: 0, missingSession: 0 };
  const note = ({status, sid}) => { if (status === 200) { counts.ok++; if (!sid) { counts.missingSession++; if (w.close) counts.closeFailed++; } } else if (status === 429) counts.capRefused++; else counts.other++; };
  const end = Date.now() + durationMs;
  if (w.hold) for (let i = 0; i < w.hold; i++) note(await initialize(base, key, fetchImpl));
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
  return counts;
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
  const counts = await run({ base, key, workload, durationMs: Number(durS) * 1000, cap: Number(process.env.DIAG_SESSION_CAP) || 25 });
  console.log(JSON.stringify({ kind: 'load', workload, ...counts }));
  if (!workloadValid(workload, counts)) { console.error('workload failed acceptance; diagnosis is invalid'); process.exit(5); }
}
