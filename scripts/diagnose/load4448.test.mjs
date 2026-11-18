// #4448: the held-session latency probe and the load line's new fields. Real load.mjs against a
// local HTTP server (the safety2619 pattern); no server, stack or private anything is touched.
import { test, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { latencyPercentiles, parseWorkload, probeHeldSession, run } from './load.mjs';
import { assertSecretFree } from './sampler.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sid = 'synthetic-held-session';

test('held opens cap + 1 at the measurement caps (#4448: 100 and the 1000 ceiling)', () => {
  expect(parseWorkload('held', 100).hold).toBe(101);
  expect(parseWorkload('held', 1000).hold).toBe(1001);
});

test('latency percentiles are nearest-rank over successful round trips', () => {
  expect(latencyPercentiles([])).toBeNull();
  const one = latencyPercentiles([7]);
  expect(one).toEqual({ requests: 1, minMs: 7, p50Ms: 7, p95Ms: 7, p99Ms: 7, maxMs: 7 });
  const p = latencyPercentiles(Array.from({ length: 100 }, (_, i) => i + 1));
  expect(p).toEqual({ requests: 100, minMs: 1, p50Ms: 50, p95Ms: 95, p99Ms: 99, maxMs: 100 });
});

const res = (status, body = '{}') => ({ status, headers: { get: () => null }, text: async () => body });

test('probe times tools/list round trips and counts non-200s as errors', async () => {
  const seen = [];
  const fetchImpl = async (_u, init) => {
    const body = JSON.parse(init.body);
    seen.push(body.method);
    return body.method === 'tools/list' && body.id === 4 ? res(500) : res(200);
  };
  const clock = { t: 100, now: () => (clock.t += 10) }; // each round trip measures exactly 10
  const probe = await probeHeldSession({ base: 'http://x', key: 'synthetic-key', sid, n: 4, fetchImpl, now: clock.now });
  // The initialized notification precedes the timed requests (the server's own open() sequence).
  expect(seen[0]).toBe('notifications/initialized');
  expect(seen.slice(1)).toEqual(['tools/list', 'tools/list', 'tools/list', 'tools/list']);
  expect(probe).toEqual({ method: 'tools/list', requests: 3, minMs: 10, p50Ms: 10, p95Ms: 10, p99Ms: 10, maxMs: 10, errors: 1 });
  // Counts and latencies only: neither the session id nor the key can appear in the output.
  const text = JSON.stringify(probe);
  expect(text).not.toContain(sid);
  expect(text).not.toContain('synthetic-key');
  expect(() => assertSecretFree(text)).not.toThrow();
});

test('probe on a transport failure reports errors, never a phantom latency', async () => {
  const fetchImpl = async () => { throw new Error('synthetic transport failure'); };
  const probe = await probeHeldSession({ base: 'http://x', key: 'k', sid, n: 2, fetchImpl, now: Date.now });
  expect(probe).toEqual({ method: 'tools/list', requests: 0, errors: 2 });
});

// #4453 BLIND P3: a 200 carrying a JSON-RPC error object — in a JSON body or an SSE data line — is a
// failed request, not a slow one.
test('a JSON-RPC error inside a 200 counts as an error, never as a latency', async () => {
  const clock = { t: 100, now: () => (clock.t += 10) };
  const jsonErr = res(200, '{"jsonrpc":"2.0","id":2,"error":{"code":-32601,"message":"synthetic"}}');
  const sseErr = res(200, 'event: message\ndata: {"jsonrpc":"2.0","id":3,"error":{"code":-32601}}\n\n');
  const sseOk = res(200, 'data: {"jsonrpc":"2.0","id":4,"result":{"tools":[]}}\n\n');
  const replies = [jsonErr, sseErr, sseOk];
  const fetchImpl = async (_u, init) => (JSON.parse(init.body).method === 'tools/list' ? replies.shift() : res(202));
  const probe = await probeHeldSession({ base: 'http://x', key: 'k', sid, n: 3, fetchImpl, now: clock.now });
  expect(probe.requests).toBe(1);   // only the SSE success line timed
  expect(probe.errors).toBe(2);
  expect(probe.minMs).toBe(10);
});

test('run() probes only the held workload and only when asked', async () => {
  const fetchImpl = async (_u, init) => (JSON.parse(init.body).method === 'initialize'
    ? { status: 200, headers: { get: () => sid }, text: async () => '' }
    : res(200));
  // A fake monotonic clock: a wall-clock step (NTP) on the shared host must not be able to fail this.
  const clock = { t: 1_000, now: () => (clock.t += 1) };
  const held = await run({ base: 'http://x', key: 'k', workload: 'held', durationMs: 5, cap: 2, probeN: 3, fetchImpl, now: clock.now });
  expect(held.counts.ok).toBe(3); // cap + 1
  expect(held.probe.requests).toBe(3);
  expect(held.probe.errors).toBe(0);
  expect(Number.isFinite(held.startAt)).toBe(true);
  expect(held.endAt).toBeGreaterThanOrEqual(held.startAt + 5);
  const quiet = await run({ base: 'http://x', key: 'k', workload: 'held', durationMs: 5, cap: 2, fetchImpl, now: clock.now });
  expect(quiet.probe).toBe('not exercised');
});

test('held CLI emits a secret-free load line with the probe and window fields', async () => {
  const server = createServer((q, r) => {
    let body = '';
    q.on('data', (c) => (body += c));
    q.on('end', () => {
      const method = JSON.parse(body || '{}').method;
      if (method === 'initialize') r.writeHead(200, { 'mcp-session-id': sid, 'content-type': 'application/json' });
      else if (method === 'tools/list') r.writeHead(200, { 'content-type': 'text/event-stream' });
      else r.writeHead(202);
      r.end(method === 'tools/list' ? 'data: {"jsonrpc":"2.0","result":{"tools":[]}}\n\n' : '{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const out = await new Promise((resolve, reject) => {
      const p = spawn(process.execPath, [join(here, 'load.mjs'), `http://127.0.0.1:${server.address().port}`, 'held', '0.05'],
        { env: { ...process.env, HADRON_DIAG_KEY: 'synthetic-key', DIAG_SESSION_CAP: '2', DIAG_PROBE_N: '3' } });
      let stdout = '';
      p.stdout.on('data', (b) => (stdout += b));
      p.on('error', reject);
      p.on('close', (code) => resolve({ code, stdout }));
    });
    expect(out.code).toBe(0);
    const line = JSON.parse(out.stdout);
    expect(line).toMatchObject({ kind: 'load', workload: 'held', cap: 2, ok: 3 });
    expect(line.probe.requests).toBe(3);
    expect(line.probe.errors).toBe(0);
    expect(out.stdout).not.toContain(sid);
    expect(() => assertSecretFree(out.stdout)).not.toThrow();
  } finally {
    await new Promise((r) => server.close(r));
  }
});
