// #2627: the load driver runs as a CLI however Node is pointed at it, an import never runs it (or throws), and the
// runner accepts a load only on a positive load record. Synthetic only: the idle workload with duration 0 makes no
// request, and the base URL is a closed loopback port.
//
// Gate (Xanthos, CHECKED T1): the entry check is robust to --preserve-symlinks-main and to a missing or nonexistent
// argv[1], without the CLI ever succeeding silently; pins for default, symlink/spaced path, preserve-symlinks-main
// and the no-op output refusal (the last in runner4448.test.mjs, beside the runner fixture it needs).
import { test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const env = { ...process.env, HADRON_DIAG_KEY: 'synthetic-not-a-key' };
const drive = (nodeArgs, script) =>
  spawnSync(process.execPath, [...nodeArgs, script, 'http://127.0.0.1:1', 'idle', '0'], { env, encoding: 'utf8', timeout: 20_000 });
const withLink = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'diag-2627-'));
  try { const linked = join(dir, 'spaced link'); symlinkSync(here, linked, 'dir'); return fn(linked); }
  finally { rmSync(dir, { recursive: true, force: true }); }
};
/** The driver ran: exit 0 and exactly one load record on stdout. */
const ranOnce = (r) => {
  expect(r.status, r.stderr).toBe(0);
  const lines = r.stdout.trim().split('\n');
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0])).toMatchObject({ kind: 'load', workload: 'idle', ok: 0, other: 0 });
};

test('default invocation runs the driver', () => ranOnce(drive([], join(here, 'load.mjs'))));

test('through a spaced directory symlink it runs the driver', () => withLink((linked) => ranOnce(drive([], join(linked, 'load.mjs')))));

test('under --preserve-symlinks-main through a symlink it still runs the driver (it printed nothing before)', () =>
  withLink((linked) => ranOnce(drive(['--preserve-symlinks-main'], join(linked, 'load.mjs')))));

test('under --preserve-symlinks with --preserve-symlinks-main it still runs the driver', () =>
  withLink((linked) => ranOnce(drive(['--preserve-symlinks', '--preserve-symlinks-main'], join(linked, 'load.mjs')))));

/** Import load.mjs from a module whose argv[1] is `argv1` (or absent), printing a marker after the import. */
const importWith = (argv1) => spawnSync(process.execPath, [
  '--input-type=module', '-e',
  `await import(${JSON.stringify(pathToFileURL(join(here, 'load.mjs')).href)}); console.log('imported');`,
  ...(argv1 === undefined ? [] : [argv1]),
], { env, encoding: 'utf8', timeout: 20_000 });

test('an import with no argv[1] neither runs the driver nor throws', () => {
  const r = importWith(undefined);
  expect(r.status, r.stderr).toBe(0);
  expect(r.stdout).toBe('imported\n');
});

test('an import whose argv[1] does not exist neither runs the driver nor throws', () => {
  for (const argv1 of ['/nonexistent/diag-2627/load.mjs', '{"kind":"load"}']) {
    const r = importWith(argv1);
    expect(r.status, `${argv1}: ${r.stderr}`).toBe(0);
    expect(r.stdout).toBe('imported\n');
  }
});

test('an import whose argv[1] is another existing file does not run the driver', () => {
  const r = importWith(join(here, 'sampler.mjs'));
  expect(r.status, r.stderr).toBe(0);
  expect(r.stdout).toBe('imported\n');
});

// ── the positive record the runner requires ─────────────────────────────────────────────────────────────────

test('loadRecordOk accepts exactly one valid load record for the requested workload', async () => {
  const { loadRecordOk } = await import('./load.mjs');
  const rec = (over = {}) => JSON.stringify({ kind: 'load', workload: 'held', cap: 100, startAt: 1, endAt: 2, probe: 'not exercised',
    ok: 101, capRefused: 0, other: 0, closeOk: 0, closeFailed: 0, missingSession: 0, ...over });
  expect(loadRecordOk(rec(), 'held')).toBe(true);
  expect(loadRecordOk(rec({ workload: 'idle', ok: 0 }), 'idle')).toBe(true);
  for (const [why, text, workload] of [
    ['empty', '', 'held'],
    ['not JSON', 'counts: 101', 'held'],
    ['another kind', rec({ kind: 'sample' }), 'held'],
    ['another workload', rec(), 'churn'],
    ['an unknown workload', rec({ workload: 'nope' }), 'nope'],
    ['a missing count', JSON.stringify({ kind: 'load', workload: 'held', startAt: 1, endAt: 2, ok: 101 }), 'held'],
    ['a non-integer count', rec({ other: '0' }), 'held'],
    ['a negative count', rec({ capRefused: -1 }), 'held'],
    ['no start/end', rec({ startAt: undefined }), 'held'],
    ['a failed workload (no session opened)', rec({ ok: 0 }), 'held'],
    ['two lines', `${rec()}\n${rec()}`, 'held'],
    ['an array', '[1]', 'held'],
    ['null', 'null', 'held'],
  ]) expect(loadRecordOk(text, workload), why).toBe(false);
});
