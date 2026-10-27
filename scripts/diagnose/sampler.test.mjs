import assert from 'node:assert/strict';
import { test } from 'vitest';
import { reduceTransportState, sampleProcess, NOT_SAMPLED, assertSecretFree, shouldAbort } from './sampler.mjs';

test('registry state is reduced to counts, no ids survive', () => {
  const out = reduceTransportState({
    sessionIds: ['sid-1', 'sid-2'],
    entries: { 'sid-1': { inFlight: 0, lastActivityAt: 1, principalKey: 'user:u1' }, 'sid-2': { inFlight: 2, lastActivityAt: 2, principalKey: 'user:u1' } },
    reservations: 1,
    sweepTimerRunning: true,
    sideMapKeys: { activeApp: ['sid-1'], workerSessions: [], sharedConnections: ['sid-1', 'sid-2'], actorsSeen: [] },
  });
  assert.deepEqual(out, { sessions: 2, inFlight: 2, principals: 1, reservations: 1, sweepTimerRunning: true,
    sideMaps: { activeApp: 1, workerSessions: 0, sharedConnections: 2, actorsSeen: 0 } });
  const text = JSON.stringify(out);
  assert(!text.includes('sid-') && !text.includes('u1'));
});

test('unreachable fields are recorded as not sampled, never zero', () => {
  const s = sampleProcess({ memoryUsage: () => ({ rss: 10, heapUsed: 5, heapTotal: 8, external: 2, arrayBuffers: 1 }) });
  assert.equal(s.poolWaiters, NOT_SAMPLED);
  assert.equal(s.rss, 10);
});

test('abort fires at rss ceiling or wall clock', () => {
  assert.equal(shouldAbort({ rss: 5 * 1024 ** 3, elapsedMs: 1 }), 'rss');
  assert.equal(shouldAbort({ rss: 1, elapsedMs: 20 * 60_000 }), 'time');
  assert.equal(shouldAbort({ rss: 1, elapsedMs: 1 }), null);
});

test('output containing a secret shape is refused', () => {
  assert.throws(() => assertSecretFree('postgresql://u:pw@host/db'));
  assert.throws(() => assertSecretFree('hdr_user_abcdef'));
  assert.throws(() => assertSecretFree('Bearer abc.def'));
  assert.doesNotThrow(() => assertSecretFree('{"sessions":25}'));
});

import { parseWorkload } from './load.mjs';
test('workload table matches the plan', () => {
  assert.deepEqual(parseWorkload('churn'), { perMin: 40, close: false });
  assert.equal(parseWorkload('closed').close, true);
  assert.equal(parseWorkload('held').hold, 26); // cap (25) + 1: the registry must stay at 25
  assert.throws(() => parseWorkload('bogus'));
});

import { run } from './load.mjs';
const resp = (status, headers = {}) => ({ status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, text: async () => '' });

test('held probes cap + 1 for any configured cap', () => {
  assert.equal(parseWorkload('held', 5).hold, 6);
  assert.equal(parseWorkload('held', 100).hold, 101);
});

test('closed workload counts failed DELETEs separately from successful closes', async () => {
  const fetchImpl = async (_u, init) => (init?.method === 'DELETE' ? resp(500) : resp(200, { 'mcp-session-id': 'sid-x' }));
  const ctl = new AbortController();
  const p = run({ base: 'http://x', key: 'k', workload: 'closed', durationMs: 50, signal: ctl.signal, fetchImpl });
  setTimeout(() => ctl.abort(), 20);
  const c = await p;
  assert.equal(c.ok, 1);
  assert.equal(c.closeFailed, 1);
  assert.equal(c.closeOk, 0);
});

test('closed workload counts a 2xx DELETE as a successful close', async () => {
  const fetchImpl = async (_u, init) => (init?.method === 'DELETE' ? resp(200) : resp(200, { 'mcp-session-id': 'sid-x' }));
  const ctl = new AbortController();
  const p = run({ base: 'http://x', key: 'k', workload: 'closed', durationMs: 50, signal: ctl.signal, fetchImpl });
  setTimeout(() => ctl.abort(), 20);
  const c = await p;
  assert.equal(c.closeOk, 1);
  assert.equal(c.closeFailed, 0);
});

import { safeNodeOptions, countTimeouts } from './sampler.mjs';
test('NODE_OPTIONS is reduced to allowlisted numeric/boolean flags; URLs and paths never survive', () => {
  const raw = '--import https://SYNTHETIC_PRIVATE_HOST_SENTINEL.example/private --max-old-space-size=4096 --require /srv/private/x.js --expose-gc';
  assert.deepEqual(safeNodeOptions(raw), ['--max-old-space-size=4096', '--expose-gc']);
  assert(!JSON.stringify(safeNodeOptions(raw)).includes('SENTINEL'));
  assert.deepEqual(safeNodeOptions(undefined), []);
});
test('pool timeout codes are counted, the text is not kept', () => {
  assert.deepEqual(countTimeouts('x P2024 y P2028 z P2024'), { P2024: 2, P2028: 1 });
  assert.deepEqual(countTimeouts('nothing here'), { P2024: 0, P2028: 0 });
});
