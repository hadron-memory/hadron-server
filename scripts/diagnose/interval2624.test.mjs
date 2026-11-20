// #2624: the sampling interval is one validated setting. The preload records the interval it actually uses in its
// config record, and the runner derives the freshness slack (two sampling periods) from that recorded value instead
// of a fixed 2000 ms. Synthetic only: a stub server script under the real preload, and the real validator.
//
// Gate (Xanthos, CHECKED T1): the PR picks "unify" or "explicitly validate" and says which (this one validates
// explicitly); the effective interval appears in config output; the slack derives from it; and a non-default
// interval is pinned with a stale/abort control. The runner-level controls are in runner4448.test.mjs.
import { test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const validator = join(here, 'validate-samples.mjs');
const withDir = (fn) => { const dir = mkdtempSync(join(tmpdir(), 'diag-2624-')); try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); } };

test('sampleIntervalMs: unset is the 1000 ms default; 100..10000 integers are taken; anything else is invalid', async () => {
  const { sampleIntervalMs } = await import('./sampler.mjs');
  expect(sampleIntervalMs(undefined)).toBe(1000);
  expect(sampleIntervalMs('')).toBe(1000);
  expect(sampleIntervalMs('250')).toBe(250);
  expect(sampleIntervalMs('0250')).toBe(250);
  expect(sampleIntervalMs('100')).toBe(100);
  expect(sampleIntervalMs('10000')).toBe(10000);
  for (const bad of ['99', '10001', '0', '-5', '1.5', 'abc', '1e3', ' 500', '0x100']) expect(sampleIntervalMs(bad), bad).toBeNull();
});

/** Run the real preload over a stub "server" (a file named index.ts that stays alive `aliveMs`), return the record rows. */
const preloadRows = (dir, sampleMs, aliveMs = 1300) => {
  const srv = join(dir, 'srv'); mkdirSync(srv);
  writeFileSync(join(srv, 'index.ts'), `setTimeout(() => {}, ${aliveMs});\n`);
  const out = join(dir, 'samples.jsonl');
  const env = { ...process.env, DIAG_SAMPLES_PATH: out, DIAG_SNAPSHOT_DIR: '' };
  if (sampleMs === undefined) delete env.DIAG_SAMPLE_MS; else env.DIAG_SAMPLE_MS = sampleMs;
  const r = spawnSync(process.execPath, ['--import', join(here, 'preload.mjs'), join(srv, 'index.ts')], { env, encoding: 'utf8', timeout: 20_000 });
  expect(r.status, r.stderr).toBe(0);
  return readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
};

test('the config record carries the effective interval, and the sampler runs at it', () => withDir((dir) => {
  const rows = preloadRows(dir, '250');
  expect(rows[0]).toMatchObject({ kind: 'config', sampleMs: 250 });
  // 1300 ms alive at 250 ms: several samples, where the 1000 ms default would give one.
  expect(rows.filter((r) => r.kind === 'sample').length).toBeGreaterThanOrEqual(3);
}));

test('unset records the 1000 ms default', () => withDir((dir) => {
  expect(preloadRows(dir, undefined, 300)[0]).toMatchObject({ kind: 'config', sampleMs: 1000 });
}));

test('an invalid container value records the default it falls back to, never a NaN (1 ms) timer', () => withDir((dir) => {
  const rows = preloadRows(dir, 'abc', 600);
  expect(rows[0]).toMatchObject({ kind: 'config', sampleMs: 1000 });
  expect(rows.filter((r) => r.kind === 'sample').length).toBeLessThanOrEqual(1);
}));

// ── the runner side: the slack derives from the recorded interval ──────────────────────────────────────────

const interval = (text) => spawnSync(process.execPath, [validator, '--interval'], { input: text, encoding: 'utf8' });

test('validate-samples --interval prints the recorded interval of a valid config record', () => {
  const r = interval('{"kind":"config","sampleMs":2500}\n{"kind":"sample","at":1}\n');
  expect(r.status, r.stderr).toBe(0);
  expect(r.stdout).toBe('2500\n');
});

test('validate-samples --interval refuses a missing, unsupported or malformed recorded interval', () => {
  for (const text of [
    '{"kind":"sample","at":1}\n',
    '{"kind":"config"}\n',
    '{"kind":"config","sampleMs":50}\n',
    '{"kind":"config","sampleMs":20000}\n',
    '{"kind":"config","sampleMs":"1000"}\n',
    '{"kind":"config","sampleMs":1000.5}\n',
    'not json\n',
    '',
  ]) {
    const r = interval(text);
    expect(r.status, text).toBe(5);
    expect(r.stdout, text).toBe('');
    expect(r.stderr, text).toBe('diagnosis samples carry no supported sampling interval\n');
  }
});

test('effective_sample_ms reads the container record and freshness_slack_ms is two periods of it', () => withDir((dir) => {
  const sh = (body) => spawnSync('bash', ['-c', `set -euo pipefail; . '${join(here, 'cleanup.sh')}'; ${body}`], { cwd: dir, encoding: 'utf8' });
  const ok = sh(`app_exec() { printf '{"kind":"config","sampleMs":2500}\\n{"kind":"sample","at":1}\\n'; }; ms=$(effective_sample_ms); echo "$ms $(freshness_slack_ms "$ms")"`);
  expect(ok.status, ok.stderr).toBe(0);
  expect(ok.stdout).toBe('2500 5000\n');
  const bad = sh(`app_exec() { printf '{"kind":"sample","at":1}\\n'; }; effective_sample_ms`);
  expect(bad.status).not.toBe(0);
}));
