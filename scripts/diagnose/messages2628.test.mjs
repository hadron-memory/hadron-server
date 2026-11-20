// #2628: the ownership refusals say which case they are and name the path, and never advise removing anything.
// Real cleanup.sh / run.sh down(), synthetic boundary adapters only (an `incus` shell function, a scratch state dir):
// no stack, container or real worktree.
//
// The cases (gate: Xanthos, CHECKED T1): existing state, a held reservation, a foreign or unverified Incus instance, and
// missing state. A refusal on the NEXT run names the path that blocks it. Hard limits from the issue: no reclaim by PID
// or age, no advice to remove unverified foreign state, no new cleanup authority.
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./cleanup.sh', import.meta.url));
const sh = (body, dir) => spawnSync('bash', ['-c', `set -euo pipefail; . '${script}'; ${body}`], { encoding: 'utf8', cwd: dir });
const scratch = (prefix) => mkdtempSync(join(tmpdir(), prefix));
const withDir = (prefix, fn) => { const dir = scratch(prefix); try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); } };

/** No refusal may tell the operator to delete, remove or reclaim anything: the harness never grants that authority. */
const noRemovalAdvice = (text) => assert.doesNotMatch(text, /\b(rm|remov\w*|delet\w*|reclaim\w*|clean ?up)\b/i, text);

// ── the next-run refusals (refuse_existing_stack, acquire_stack_reservation) ─────────────────────────────────────

test('existing state: the refusal names the state path and says it was not created by this run', () => withDir('diag-2628-', (dir) => {
  const state = join(dir, 'state'); mkdirSync(state);
  const r = sh(`incus() { return 0; }; refuse_existing_stack '${state}' hadron-e2e-x`, dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^stack state already exists: /);
  assert(r.stderr.includes(state), r.stderr);
  assert.match(r.stderr, /not created by this run/);
  noRemovalAdvice(r.stderr);
}));

test('existing state as a dangling symlink is the same existing-state refusal, naming the path', () => withDir('diag-2628-', (dir) => {
  const state = join(dir, 'state'); symlinkSync(join(dir, 'nowhere'), state);
  const r = sh(`incus() { return 0; }; refuse_existing_stack '${state}' hadron-e2e-x`, dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^stack state already exists: /);
  assert(r.stderr.includes(state), r.stderr);
}));

test('a foreign or unverified Incus instance with no state: the refusal names the instance and the absent state path', () => withDir('diag-2628-', (dir) => {
  const state = join(dir, 'state');
  const r = sh(`incus() { printf 'other\\nhadron-e2e-x\\n'; }; refuse_existing_stack '${state}' hadron-e2e-x`, dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^Incus instance hadron-e2e-x already exists with no stack state at /);
  assert(r.stderr.includes(state), r.stderr);
  assert.match(r.stderr, /foreign or unverified instance/);
  noRemovalAdvice(r.stderr);
}));

test('a held reservation: the refusal names the reservation path and says it is never reclaimed by age or PID', () => withDir('diag-2628-', (dir) => {
  const state = join(dir, 'state');
  mkdirSync(`${state}.diagnose-lock`); writeFileSync(`${state}.diagnose-lock/owner`, 'someone-else\n');
  const r = sh(`incus() { return 0; }; acquire_stack_reservation '${state}' hadron-e2e-x`, dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^diagnosis stack already reserved: /m); // after mkdir's own line
  assert(r.stderr.includes(`${state}.diagnose-lock`), r.stderr);
  assert.match(r.stderr, /never taken over by age or PID/);
  noRemovalAdvice(r.stderr);
  // The other holder's reservation is untouched.
  assert.equal(readFileSync(`${state}.diagnose-lock/owner`, 'utf8'), 'someone-else\n');
}));

// ── the end-of-run explanation (run.sh down() when stack_owned fails) ────────────────────────────────────────────

const runShDown = () => {
  const src = readFileSync(fileURLToPath(new URL('./run.sh', import.meta.url)), 'utf8');
  return src.slice(src.indexOf('down() {'), src.indexOf('\n}\n', src.indexOf('down() {')) + 3);
};

/**
 * Run the real down() with ownership refused, in a scratch tree. `setup` shapes the state dir and token.
 * Returns stderr and what down() did; nothing it calls can touch a real stack.
 */
const downRun = (setup) => withDir('diag-2628-down-', (dir) => {
  const log = join(dir, 'ran');
  // #4607 BLIND F4: a stack.sh that logs any teardown attempt, so "no teardown" is an observation, not an absent script.
  mkdirSync(join(dir, 'stage/src/scripts/e2e'), { recursive: true });
  writeFileSync(join(dir, 'stage/src/scripts/e2e/stack.sh'), `#!/bin/sh\necho stackdown >> '${log}'\n`, { mode: 0o755 });
  const stubs = `note() { echo "$1" >> '${log}'; }; preserve_samples() { note preserve; }; keep_logs_private() { note logs; }; `
    + `purge_snapshots() { note purge; }; release_stack_reservation() { note release; }; git() { return 0; }; `
    + `incus() { note incus; return 1; }; `
    + `stage='${dir}/stage'; state='${dir}/state'; root='${dir}'; worker=w; project=hadron-e2e-w; DIAG_OUT='${dir}/o'; `
    + `DIAG_STATE="$state"; DIAG_PROJECT="$project"; DIAG_LOCK="$state.diagnose-lock"; `
    + `${setup}; `
    + `${runShDown()}\ntrap down EXIT\nfalse`;
  const r = spawnSync('bash', ['-c', `set -euo pipefail; . '${script}'; ${stubs}`], { encoding: 'utf8', cwd: dir });
  return { ...r, dir, ran: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [] };
});
/** This run's own reservation, so stack_owned gets as far as the state checks. */
const ownReservation = `DIAG_RUN_TOKEN=tok-1; mkdir "$DIAG_LOCK"; echo tok-1 > "$DIAG_LOCK/owner"`;

test('missing state: the line says only that no state is found, skips capture and teardown, and prints no inspection path', () => {
  const r = downRun(ownReservation);
  assert.notEqual(r.status, 0);
  // #4607 BLIND F2: absent now is not "never created": the line says only what is known, and skips capture and teardown.
  assert.match(r.stderr, /no stack state found at \S+, so ownership cannot be verified; capture and teardown skipped/);
  assert.match(r.stderr, /if an Incus instance named hadron-e2e-w exists, check it by hand/);
  assert.doesNotMatch(r.stderr, /was created|nothing to capture|inspect private state/);
  noRemovalAdvice(r.stderr);
  assert(!r.ran.includes('stackdown') && !r.ran.includes('purge') && !r.ran.includes('preserve'), r.ran.join());
});

test('state without this run\'s owner marker: says it belongs to another holder or was made outside this run, names the path', () => {
  for (const marker of ['', 'tok-other']) {
    const r = downRun(`${ownReservation}; mkdir "$state"; printf '%s' '${marker}' > "$state/diagnose-owner"`);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /stack ownership unverified; refusing capture\/teardown; inspect private state: \S+/);
    assert.match(r.stderr, /does not carry this run's owner marker/);
    noRemovalAdvice(r.stderr);
    assert(!r.ran.includes('stackdown') && !r.ran.includes('purge') && !r.ran.includes('preserve'), r.ran.join());
  }
});

test('this run\'s state but no verified instance: says the Incus instance is missing or not marked by this run', () => {
  const r = downRun(`${ownReservation}; mkdir "$state"; echo tok-1 > "$state/diagnose-owner"; echo incus > "$state/backend"`);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /stack ownership unverified; refusing capture\/teardown; inspect private state: \S+/);
  assert.match(r.stderr, /Incus instance hadron-e2e-w is missing, unreadable or not marked by this run/);
  noRemovalAdvice(r.stderr);
  assert(!r.ran.includes('stackdown') && !r.ran.includes('purge') && !r.ran.includes('preserve'), r.ran.join());
});

// ── #4607 BLIND fix head ───────────────────────────────────────────────────────────────────────────────────────

test('a lost reservation is its own case, named by its path, even when the state marker matches (#4607 F3)', () => {
  // The state marker is this run's token, but the reservation's owner file no longer is.
  const r = downRun(`DIAG_RUN_TOKEN=tok-1; mkdir "$DIAG_LOCK"; echo someone-else > "$DIAG_LOCK/owner"; mkdir "$state"; echo tok-1 > "$state/diagnose-owner"; echo incus > "$state/backend"`);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /this run no longer holds its reservation \S+\.diagnose-lock/);
  assert.doesNotMatch(r.stderr, /owner marker/);
  noRemovalAdvice(r.stderr);
  assert(!r.ran.includes('stackdown') && !r.ran.includes('purge') && !r.ran.includes('preserve'), r.ran.join());
});

test('a reservation that cannot be created (no lock exists) is not reported as a held reservation (#4607 F1)', () => withDir('diag-2628-', (dir) => {
  // A state name of 250 bytes makes the lock name (+ ".diagnose-lock") exceed the 255-byte name limit, so mkdir fails
  // with no lock present for any user, root included (a permission-based setup does not fail as root, as in CI).
  const state = join(dir, 's'.repeat(250));
  const r = sh(`incus() { return 0; }; acquire_stack_reservation '${state}' hadron-e2e-x`, dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^mkdir: /m);   // mkdir's own line is kept (its wording differs between builds)
  assert.match(r.stderr, /could not create the diagnosis reservation \S+\.diagnose-lock \(see the error above\); refusing/);
  assert.doesNotMatch(r.stderr, /already reserved/);
  assert.equal(existsSync(`${state}.diagnose-lock`), false);
  noRemovalAdvice(r.stderr);
}));

test('the end-of-run explanation tolerates a missing instance name, so the EXIT trap keeps running (#4607 F5)', () => withDir('diag-2628-', (dir) => {
  const r = sh(`DIAG_RUN_TOKEN=t; DIAG_LOCK='${join(dir, 'l')}'; mkdir "$DIAG_LOCK"; echo t > "$DIAG_LOCK/owner"; explain_stack_ownership_failure '${join(dir, 'none')}' ''; echo AFTER`, dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /AFTER/);
  assert.match(r.stderr, /no stack state found at /);
}));
