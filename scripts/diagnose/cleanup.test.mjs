import assert from 'node:assert/strict';
import { test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, statSync, readFileSync, existsSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
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
test('a pre-existing permissive log destination is replaced by a private file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'diag-logs-'));
  try {
    const dest = join(dir, 'x.private.log');
    writeFileSync(dest, 'old\n', { mode: 0o644 }); chmodSync(dest, 0o644);
    sh(`keep_logs_private '${dest}' bash -c "echo PRIVATE_SENTINEL_VALUE"`, dir);
    assert.equal(statSync(dest).mode & 0o077, 0);
    assert(readFileSync(dest, 'utf8').includes('PRIVATE_SENTINEL_VALUE'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('a failed sample read fails the success path and leaves no stale or pg_activity-only artifact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'diag-fin-'));
  try {
    const out = join(dir, 's.jsonl');
    const r = sh(`app_exec() { return 1; }; finish_samples '${out}' 2`, dir);
    assert.notEqual(r.status, 0);
    assert(!existsSync(out));
    const empty = sh(`app_exec() { :; }; finish_samples '${out}' 2`, dir);
    assert.notEqual(empty.status, 0); assert(!existsSync(out));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('the success path appends the pg_activity control line after the samples', () => {
  const dir = mkdtempSync(join(tmpdir(), 'diag-fin-'));
  try {
    const out = join(dir, 's.jsonl');
    const r = sh(`app_exec() { printf '{"kind":"sample"}\\n'; }; finish_samples '${out}' 7`, dir);
    assert.equal(r.status, 0);
    assert.equal(readFileSync(out, 'utf8'), '{"kind":"sample"}\n{"kind":"pg_activity","connectionsAfterLoad":7}\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('heap snapshot files are deleted at teardown and a survivor fails the purge', () => {
  const dir = mkdtempSync(join(tmpdir(), 'diag-snap-'));
  try {
    writeFileSync(join(dir, 'start.heapsnapshot'), 'x'); writeFileSync(join(dir, 'keep.jsonl'), 'y');
    const ok = sh(`SNAP_DIR='${dir}'; app_exec() { "$@"; }; purge_snapshots`, dir);
    assert.equal(ok.status, 0);
    assert(!existsSync(join(dir, 'start.heapsnapshot')) && existsSync(join(dir, 'keep.jsonl')));
    writeFileSync(join(dir, 'end.heapsnapshot'), 'x');
    // rm that silently does nothing: the purge must notice the file is still there.
    const bad = sh(`SNAP_DIR='${dir}'; app_exec() { case "$3" in rm*) return 0;; *) "$@";; esac; }; purge_snapshots`, dir);
    assert.notEqual(bad.status, 0);
    // an exec that fails outright is not "no files": the purge fails closed.
    const dead = sh(`SNAP_DIR='${dir}'; app_exec() { return 1; }; purge_snapshots`, dir);
    assert.notEqual(dead.status, 0);
    // a failing verification listing after a successful rm also fails.
    const blind = sh(`SNAP_DIR='${dir}'; app_exec() { case "$3" in find*) return 1;; *) "$@";; esac; }; purge_snapshots`, dir);
    assert.notEqual(blind.status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
