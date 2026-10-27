// Loaded into the real server process via NODE_OPTIONS=--import (#2589). Samples counts and sizes only.
import v8 from 'node:v8';
import { appendFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { reduceTransportState, sampleProcess, shouldAbort, assertSecretFree, safeNodeOptions, countTimeouts, snapshotLabel } from './sampler.mjs';

if (/index\.ts$/.test(process.argv[1] ?? '') || process.argv.includes('src/index.ts')) {
  const out = process.env.DIAG_SAMPLES_PATH ?? '/tmp/diagnose-samples.jsonl';
  const started = Date.now();
  const line = (o) => { const t = JSON.stringify(o); assertSecretFree(t); appendFileSync(out, t + '\n'); };

  // Pool timeout occurrences: count the Prisma codes in what the process logs, keep none of the text.
  const timeouts = { P2024: 0, P2028: 0 };
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream);
    stream.write = (chunk, ...rest) => {
      const c = countTimeouts(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      timeouts.P2024 += c.P2024; timeouts.P2028 += c.P2028;
      return write(chunk, ...rest);
    };
  }
  const RES_MS = 10; // the histogram records the timer interval too; subtract it so a quiet loop reads about 0
  const loop = monitorEventLoopDelay({ resolution: RES_MS });
  loop.enable();

  line({ kind: 'config', node: process.version, heapSizeLimit: v8.getHeapStatistics().heap_size_limit,
    nodeFlags: safeNodeOptions(process.env.NODE_OPTIONS), preloadActive: true,
    exposeGc: typeof globalThis.gc === 'function',
    poolLimit: process.env.DB_POOL_CONNECTION_LIMIT || null, poolTimeoutS: process.env.DB_POOL_TIMEOUT_SECONDS || null,
    sessionCap: process.env.MCP_MAX_SESSIONS_PER_PRINCIPAL || null });

  // #2598: the runner asks for a heap snapshot by creating <dir>/snap-<label>.trigger. The file stays on this stack host;
  // only the runner-side reduction (counts and sizes) is ever published, and the runner deletes the files at teardown.
  const snapDir = process.env.DIAG_SNAPSHOT_DIR;
  const takeSnapshots = () => {
    if (!snapDir) return;
    for (const name of readdirSync(snapDir)) {
      const label = snapshotLabel(name);
      if (!label) continue;
      rmSync(`${snapDir}/${name}`, { force: true });
      const gc = typeof globalThis.gc === 'function' ? (globalThis.gc(), true) : 'not available';
      const file = `${snapDir}/${label}.heapsnapshot`;
      v8.writeHeapSnapshot(file);
      line({ kind: 'snapshot', label, gc, bytes: statSync(file).size });
    }
  };

  let seam = null;
  const timer = setInterval(async () => {
    const t = Date.now() - started;
    try { takeSnapshots(); } catch { line({ kind: 'snapshot', failed: true }); }
    const proc = sampleProcess();
    // tsx is not registered yet at preload time, so resolve the registry seam lazily.
    if (!seam) seam = await import('../../../src/mcp/server.ts').then((m) => m.mcpTransportStateForTests, () => null);
    const eventLoop = loop.count > 0 ? { p50Ms: Math.max(0, loop.percentile(50) / 1e6 - RES_MS), p99Ms: Math.max(0, loop.percentile(99) / 1e6 - RES_MS) } : 'not sampled';
    loop.reset();
    line({ kind: 'sample', t, ...proc, eventLoop, timeouts: { ...timeouts }, mcp: seam ? reduceTransportState(seam()) : 'not sampled' });
    const why = shouldAbort({ rss: proc.rss, elapsedMs: t });
    if (why) { line({ kind: 'abort', why, t }); process.exit(3); }
  }, Number(process.env.DIAG_SAMPLE_MS ?? 1000));
  timer.unref();
}
