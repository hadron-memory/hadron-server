// Load driver for #2589. One principal (HADRON_DIAG_KEY from the env, never printed).
// Workloads: churn (W1/W2: initialize with no Mcp-Session-Id, never closed), closed (C1: DELETE after),
// idle (C2), held (C3: N sessions held open). Output is counts only.
const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'diag', version: '1' } } };

export function parseWorkload(name) {
  const w = { churn: { perMin: 40, close: false }, closed: { perMin: 40, close: true }, idle: { perMin: 0, close: false }, held: { perMin: 0, close: false, hold: 26 } }[name];
  if (!w) throw new Error(`unknown workload: ${name}`);
  return w;
}

async function initialize(base, key) {
  const res = await fetch(`${base}/mcp`, { method: 'POST', body: JSON.stringify(INIT),
    headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', authorization: `Bearer ${key}` } });
  await res.text();
  return { status: res.status, sid: res.headers.get('mcp-session-id') };
}

export async function run({ base, key, workload, durationMs, signal }) {
  const w = parseWorkload(workload);
  const counts = { ok: 0, capRefused: 0, other: 0 };
  const note = (s) => { if (s === 200) counts.ok++; else if (s === 429) counts.capRefused++; else counts.other++; };
  const end = Date.now() + durationMs;
  if (w.hold) for (let i = 0; i < w.hold; i++) note((await initialize(base, key)).status);
  while (w.perMin && Date.now() < end && !signal?.aborted) {
    const { status, sid } = await initialize(base, key);
    note(status);
    if (w.close && sid) await fetch(`${base}/mcp`, { method: 'DELETE', headers: { authorization: `Bearer ${key}`, 'mcp-session-id': sid } }).then((r) => r.text());
    await new Promise((r) => setTimeout(r, 60_000 / w.perMin));
  }
  if (!w.perMin) await new Promise((r) => setTimeout(r, Math.max(0, end - Date.now())));
  return counts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [base, workload, durS] = process.argv.slice(2);
  const key = process.env.HADRON_DIAG_KEY;
  if (!key) { console.error('HADRON_DIAG_KEY is required'); process.exit(2); }
  const counts = await run({ base, key, workload, durationMs: Number(durS) * 1000 });
  console.log(JSON.stringify({ kind: 'load', workload, ...counts }));
}
