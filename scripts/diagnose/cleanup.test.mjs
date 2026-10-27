import assert from 'node:assert/strict';
import { test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, statSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./cleanup.sh', import.meta.url));
const sh = (body, dir) => spawnSync('bash', ['-c', `set -e; . '${script}'; ${body}`], { encoding: 'utf8', cwd: dir });

test('samples survive a failed run and the original exit status is kept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'diag-cleanup-'));
  try {
    const out = join(dir, 'samples.jsonl');
    // app_exec stands in for `docker compose exec`: the container still holds samples after the driver failed.
    const r = sh(`app_exec() { printf '{"kind":"sample","rss":1}\\n'; }; trap 'preserve_samples "${out}"' EXIT; false`, dir);
    assert.notEqual(r.status, 0);
    assert.equal(readFileSync(out, 'utf8'), '{"kind":"sample","rss":1}\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an unreachable container neither fails the cleanup nor leaves a partial file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'diag-cleanup-'));
  try {
    const out = join(dir, 'samples.jsonl');
    const r = sh(`app_exec() { return 1; }; preserve_samples "${out}"; echo ok`, dir);
    assert.equal(r.status, 0);
    assert(!existsSync(out) && !existsSync(`${out}.partial`));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('without app_exec (stack never came up) cleanup is a no-op', () => {
  const dir = mkdtempSync(join(tmpdir(), 'diag-cleanup-'));
  try {
    const r = sh(`preserve_samples "${join(dir, 's.jsonl')}"; echo ok`, dir);
    assert.equal(r.status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an existing stack name is refused and the cleanup trap never runs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'diag-own-'));
  try {
    const state = join(dir, 'state'); mkdirSync(state);
    // Mirrors run.sh order: refuse first, only then install the trap that would tear down.
    const r = sh(`refuse_existing_stack '${state}' hadron-e2e-x || exit 2; trap 'echo TEARDOWN-RAN' EXIT`, dir);
    assert.equal(r.status, 2);
    assert(!r.stdout.includes('TEARDOWN-RAN'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('a fresh name is accepted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'diag-own-'));
  try { assert.equal(sh(`refuse_existing_stack '${join(dir, 'none')}' hadron-e2e-zz-not-real`, dir).status, 0); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});
test('raw failure logs stay in a private file; stderr carries only a fixed line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'diag-logs-'));
  try {
    const dest = join(dir, 'x.private.log');
    const r = sh(`keep_logs_private '${dest}' bash -c "echo PRIVATE_SENTINEL_VALUE https://internal.example/x"`, dir);
    assert(!r.stderr.includes('PRIVATE_SENTINEL_VALUE') && !r.stderr.includes('https://'));
    assert.match(r.stderr, /failure logs kept privately \(\d+ lines\)/);
    assert(readFileSync(dest, 'utf8').includes('PRIVATE_SENTINEL_VALUE'));
    assert.equal(statSync(dest).mode & 0o077, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
