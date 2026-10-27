// Loaded into the real server process via NODE_OPTIONS=--import (#2589). Samples counts and sizes only.
import v8 from 'node:v8';
import { appendFileSync } from 'node:fs';
import { reduceTransportState, sampleProcess, shouldAbort, assertSecretFree } from './sampler.mjs';

if (/index\.ts$/.test(process.argv[1] ?? '') || process.argv.includes('src/index.ts')) {
  const out = process.env.DIAG_SAMPLES_PATH ?? '/tmp/diagnose-samples.jsonl';
  const started = Date.now();
  const line = (o) => { const t = JSON.stringify(o); assertSecretFree(t); appendFileSync(out, t + '\n'); };
  line({ kind: 'config', node: process.version, heapSizeLimit: v8.getHeapStatistics().heap_size_limit,
    nodeOptions: process.env.NODE_OPTIONS ?? null, exposeGc: typeof globalThis.gc === 'function',
    poolLimit: process.env.DB_POOL_CONNECTION_LIMIT || null, poolTimeoutS: process.env.DB_POOL_TIMEOUT_SECONDS || null,
    sessionCap: process.env.MCP_MAX_SESSIONS_PER_PRINCIPAL || null });
  let seam = null;
  const timer = setInterval(async () => {
    const t = Date.now() - started;
    const proc = sampleProcess();
    // tsx is not registered yet at preload time, so resolve the registry seam lazily.
    if (!seam) seam = await import('../../../src/mcp/server.ts').then((m) => m.mcpTransportStateForTests, () => null);
    line({ kind: 'sample', t, ...proc, mcp: seam ? reduceTransportState(seam()) : 'not sampled' });
    const why = shouldAbort({ rss: proc.rss, elapsedMs: t });
    if (why) { line({ kind: 'abort', why, t }); process.exit(3); }
  }, Number(process.env.DIAG_SAMPLE_MS ?? 5000));
  timer.unref();
}
