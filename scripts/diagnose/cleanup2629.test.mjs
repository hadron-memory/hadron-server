// #2629: the publication and cleanup guards left unpinned by #2623 (Cooper's QA delta survivors).
// Real cleanup.sh / run.sh down(), synthetic boundary adapters only: no stack, container or real worktree.
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./cleanup.sh', import.meta.url));
const validator = fileURLToPath(new URL('./validate-samples.mjs', import.meta.url));
const sh = (body, dir) => spawnSync('bash', ['-c', `set -euo pipefail; . '${script}'; ${body}`], { encoding: 'utf8', cwd: dir });
const scratch = prefix => mkdtempSync(join(tmpdir(), prefix));

test('finish_samples replaces a destination symlink to a directory, never writing into its target', () => {
  const dir = scratch('diag-2629-fin-');
  try {
    const target = join(dir, 'target'); mkdirSync(target); writeFileSync(join(target, 'sentinel'), 'KEEP');
    const out = join(dir, 'out'); symlinkSync(target, out);
    const r = sh(`app_exec() { printf '{"kind":"sample","at":1000}\\n'; }; finish_samples '${out}' 7 1000`, dir);
    assert.equal(r.status, 0, r.stderr);
    assert(!lstatSync(out).isSymbolicLink(), 'the destination symlink itself is replaced');
    assert.equal(readFileSync(out, 'utf8'), '{"kind":"sample","at":1000}\n{"kind":"pg_activity","connectionsAfterLoad":7}\n');
    assert.deepEqual(readdirSync(target), ['sentinel']);
    assert.equal(readFileSync(join(target, 'sentinel'), 'utf8'), 'KEEP');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Kept as its own pin (the issue's open question): truncated JSON is already rejected by JSON.parse,
// but a COMPLETE record missing only its newline parses fine. Accepting it would let finish_samples'
// `>>` append the pg_activity line onto the same line, publishing a file that is not valid JSONL.
test('a complete final record without its trailing newline is rejected, and the retry publishes valid JSONL', () => {
  const dir = scratch('diag-2629-nl-');
  try {
    const f = join(dir, 'sample'); writeFileSync(f, '{"kind":"sample","at":1000}');
    const v = spawnSync(process.execPath, [validator, f, '1000'], { encoding: 'utf8' });
    assert.notEqual(v.status, 0);
    assert.equal(v.stdout, '');
    writeFileSync(join(dir, 'count'), '0');
    const out = join(dir, 'out');
    const r = sh(`app_exec() { n=$(cat count); echo $((n+1)) > count; if [ "$n" = 0 ]; then printf '{"kind":"sample","at":1000}'; else printf '{"kind":"sample","at":1000}\\n'; fi; }; finish_samples '${out}' 3 1000`, dir);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(join(dir, 'count'), 'utf8').trim(), '2');
    assert.equal(readFileSync(out, 'utf8'), '{"kind":"sample","at":1000}\n{"kind":"pg_activity","connectionsAfterLoad":3}\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The REAL down() from run.sh, extracted; its collaborators are stubbed and record what ran.
const runShDown = () => {
  const src = readFileSync(fileURLToPath(new URL('./run.sh', import.meta.url)), 'utf8');
  return src.slice(src.indexOf('down() {'), src.indexOf('\n}\n', src.indexOf('down() {')) + 3);
};
const trapRun = ({ owned, git, body = 'true' }) => {
  const dir = scratch('diag-2629-trap-');
  try {
    const log = join(dir, 'ran');
    const stubs = `note() { echo "$1" >> '${log}'; }; preserve_samples() { note preserve; }; keep_logs_private() { note logs; }; `
      + `stack_owned() { ${owned}; }; purge_snapshots() { note purge; }; release_stack_reservation() { note release; }; git() { ${git}; }; `
      + `stage='${dir}/stage'; state='${dir}/state'; root='${dir}'; worker=w; DIAG_OUT='${dir}/o'; mkdir -p "$stage/src" "$state"; : > "$state/diagnose-owner"; `
      + `${runShDown()}\ntrap down EXIT\n${body}`;
    mkdirSync(join(dir, 'stage/src/scripts/e2e'), { recursive: true });
    writeFileSync(join(dir, 'stage/src/scripts/e2e/stack.sh'), `#!/bin/sh\necho stackdown >> '${log}'\n`);
    chmodSync(join(dir, 'stage/src/scripts/e2e/stack.sh'), 0o755);
    const r = sh(stubs, dir);
    return { ...r, ran: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [], stageLeft: existsSync(join(dir, 'stage')) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
};

test('run.sh EXIT trap: a successful run whose stack ownership is lost exits 5 without capture or teardown', () => {
  const r = trapRun({ owned: 'return 1', git: 'return 0' });
  assert.equal(r.status, 5);
  assert.match(r.stderr, /stack ownership unverified; refusing capture\/teardown; inspect private state: /);
  assert.deepEqual(r.ran, ['release']);
});

test('run.sh EXIT trap: a failed worktree remove fails an otherwise clean run, and cleanup still finishes', () => {
  const r = trapRun({ owned: 'return 0', git: 'if [ "$3 $4" = "worktree remove" ]; then note wtremove; return 1; fi' });
  assert.equal(r.status, 5);
  assert.deepEqual(r.ran, ['purge', 'stackdown', 'wtremove', 'release']);
  assert.equal(r.stageLeft, false);
  // The control: the same teardown with a working worktree remove exits 0.
  assert.equal(trapRun({ owned: 'return 0', git: 'return 0' }).status, 0);
});
