// #4646 (Refs #4278; gate CHECKED T1 by Xanthos, issuecomment-7054667627): the in-VM watchdog on the test-shard vitest
// step. The real script, with a test time unit (WATCHDOG_SECONDS_PER_MINUTE=1, so a "minute" is one second) and
// stand-in commands; no Actions run, no stack, no test database. Where a pin needs a scheduling window or a stalled
// tool, a shim on PATH chooses it; the processes, PIDs and signals are real.
//
// Pins, one per gate condition and review finding:
//   1. a hang: the dump (the [watchdog] process list and a final [sampler] block) is printed while the command still
//      runs, then the fixed "exceeded N min; killed" line, then the distinguishable exit 124; every process of the
//      command's tree is gone, killed by PID or by its process group;
//   2. no descendant escapes (#4647 LOCAL F1, BLIND P1): a child forked between a scan and its STOP, the grandchild it
//      forks after the next scan, a grandchild reparented away when its parent exited, and a child that left the
//      group for its own session;
//   3. the kill is scoped: a process outside the command's tree and group survives, and nothing is matched by name;
//   4. a stalled diagnostic cannot hold the kill (BLIND P2); a survivor is reported as "kill NOT verified";
//      a TERM to the watchdog (the step cancelled) still ends the command;
//   5. inside the budget the command's own exit code comes back unchanged (0, 1 and another code);
//   6. the settings refuse non-integer, empty, zero, negative, oversized (no bash wrap-around: LOCAL F2, BLIND P3) and
//      not-below-the-step-timeout values before the command runs, each with a fixed message naming its setting; the
//      budget counts from WATCHDOG_STEP_STARTED_AT when set (BLIND P2);
//   7. the 45 is declared twice in test.yml (timeout-minutes and WATCHDOG_STEP_TIMEOUT_MINUTES) and this pins them
//      equal, the budget below them, and the step's first line exporting its start time, so none can drift unnoticed.
import { test as vitestTest, expect } from 'vitest';

// Each pin waits on real processes and a budget of a few seconds; vitest's 5 s default is too short.
const test = (name, fn) => vitestTest(name, fn, 60_000);
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'vitest-watchdog.sh');
const repo = join(here, '..', '..');
const realPs = spawnSync('bash', ['-c', 'command -v ps'], { encoding: 'utf8' }).stdout.trim();

/** This process's environment without any WATCHDOG_* setting: under CI the suite itself runs inside the watched step,
 *  which exports WATCHDOG_STEP_STARTED_AT and the budget, and a pin must set every setting it means to test. */
const baseEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('WATCHDOG_')));
/** Run the watchdog around `command` (a bash -c body) with a budget in test "minutes" (seconds). */
function watch(command, { minutes = '3', stepTimeout = '45', extraEnv = {}, timeout = 60_000 } = {}) {
  const env = { ...baseEnv(), WATCHDOG_MINUTES: minutes, WATCHDOG_STEP_TIMEOUT_MINUTES: stepTimeout, WATCHDOG_SECONDS_PER_MINUTE: '1', ...extraEnv };
  return spawnSync('bash', [script, '--', 'bash', '-c', command], { env, encoding: 'utf8', timeout });
}
/** The process's state letter from /proc, or null when it no longer exists. */
const state = (pid) => { try { return readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /, '')[0]; } catch { return null; } };
/** Not yet ended: running, sleeping or stopped, but not a zombie (a zombie has ended; only its parent has not reaped it). */
const running = (pid) => { const s = state(pid); return s !== null && s !== 'Z'; };
/** Gone, allowing a bounded moment for an orphan to be reaped (#4647 BLIND P2: `kill -0` succeeds on a zombie). */
const gone = (pid) => { for (let i = 0; i < 50 && running(pid); i++) spawnSync('sleep', ['0.1']); return !running(pid); };
const pidsIn = (file) => readFileSync(file, 'utf8').trim().split('\n').map(Number);
const withDir = (fn) => { const dir = mkdtempSync(join(tmpdir(), 'watchdog-4646-')); try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); } };
/** A `name` shim on PATH in `dir`/bin with the given bash body; returns the PATH to pass. */
const shim = (dir, name, body) => {
  const bin = join(dir, 'bin'); mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`); chmodSync(join(bin, name), 0o755);
  return `${bin}:${process.env.PATH}`;
};
/** Whole seconds since boot: the watchdog's monotonic clock. */
const uptime = () => Math.floor(Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]));
const cleanup = (pids) => { for (const pid of pids) spawnSync('kill', ['-KILL', String(pid)]); };

test('a hang: dump while the command still runs, then the kill, the fixed line and exit 124; the whole tree is gone', () => withDir((dir) => {
  const pids = join(dir, 'pids');
  // At the dump's process list, record each fixture process's state: it must still be running (not stopped, not gone).
  const PATH = shim(dir, 'ps', `if [ "$*" = "-eo pid,ppid,pgid,rss,etime,comm" ]; then
  for p in $(cat ${pids}); do echo "$p $(sed 's/^.*) //' /proc/$p/stat | cut -c1)" >> ${dir}/at-dump; done
fi
exec ${realPs} "$@"`);
  // A command with a tree: two children and a grandchild, all outliving the budget. Each records its PID.
  const r = watch(`echo $$ >> ${pids}; (sleep 300 & echo $! >> ${pids}; wait) & echo $! >> ${pids}; sleep 300 & echo $! >> ${pids}; wait`, { minutes: '2', extraEnv: { PATH } });
  const recorded = pidsIn(pids);
  try {
    expect(r.status, r.stderr).toBe(124);
    const out = r.stdout;
    const dump = out.indexOf('[watchdog] budget of 2 min reached; process tree before the kill:');
    const sampler = out.indexOf('[sampler]', dump);
    const killed = out.indexOf('[watchdog] vitest exceeded 2 min; killed');
    expect(dump).toBeGreaterThanOrEqual(0);
    expect(sampler).toBeGreaterThan(dump);
    expect(killed).toBeGreaterThan(sampler);
    expect(out.slice(sampler, killed)).toMatch(/Mem:/);   // free -m ran in the final block
    expect(recorded.length).toBe(4);
    const atDump = readFileSync(join(dir, 'at-dump'), 'utf8').trim().split('\n');
    expect(atDump.length).toBe(4);
    for (const line of atDump) expect(line, 'a fixture process was not running at the dump').toMatch(/^\d+ [RS]$/);
    for (const pid of recorded) expect(gone(pid), `pid ${pid} survived`).toBe(true);
  } finally { cleanup(recorded); }
}));

test('a child forked while the tree is collected, and the grandchild it forks after the next scan, are both killed', () => withDir((dir) => {
  // #4647 LOCAL F1 (Jane): the ps snapshot and the STOP are not atomic. This shim lets the real table be captured, THEN
  // lets a process fork, on the first two tree scans: a child the first scan misses, and a grandchild that child forks
  // after the second scan.
  const PATH = shim(dir, 'ps', `out=$(${realPs} "$@")
if [ "$*" = "-eo pid=,ppid=" ]; then
  n=$(( $(cat ${dir}/calls 2>/dev/null || echo 0) + 1 )); echo "$n" > ${dir}/calls
  if [ "$n" -le 2 ]; then
    t=${dir}/child; [ "$n" = 2 ] && t=${dir}/grandchild
    touch ${dir}/spawn$n
    for _ in $(seq 500); do [ -s "$t" ] && break; sleep 0.01; done
  fi
fi
printf '%s\\n' "$out"`);
  // The forking processes run in their own session, outside the command's group, so the group STOP cannot freeze them
  // and only the rescan loop can (inside the group, the group STOP already closes this window).
  const waitFor = (f) => `until [ -e ${f} ]; do sleep 0.01; done`;
  writeFileSync(join(dir, 'child.sh'), `${waitFor(join(dir, 'spawn2'))}; sleep 300 & echo $! > ${join(dir, 'grandchild')}; wait\n`);
  writeFileSync(join(dir, 'root.sh'), `echo $$ > ${join(dir, 'own')}; ${waitFor(join(dir, 'spawn1'))}; bash ${join(dir, 'child.sh')} & echo $! > ${join(dir, 'child')}; sleep 300\n`);
  const r = watch(`setsid bash ${join(dir, 'root.sh')} & sleep 300`, { minutes: '1', extraEnv: { PATH } });
  const late = ['own', 'child', 'grandchild'].filter((f) => existsSync(join(dir, f))).map((f) => pidsIn(join(dir, f))[0]);
  try {
    expect(r.status, r.stderr).toBe(124);
    expect(late.length, 'the child and grandchild were forked').toBe(3);
    for (const pid of late) expect(gone(pid), `late pid ${pid} survived`).toBe(true);
  } finally { cleanup(late); }
}));

test('a grandchild reparented away when its parent exited is killed through the process group (BLIND P1)', () => withDir((dir) => {
  const gc = join(dir, 'gc');
  // The subshell starts the grandchild and exits at once, so the grandchild is no longer in the command's ppid tree.
  const r = watch(`(sleep 300 & echo $! > ${gc}); sleep 300`, { minutes: '1' });
  const pid = pidsIn(gc)[0];
  try {
    expect(r.status, r.stderr).toBe(124);
    expect(r.stdout).toContain('[watchdog] vitest exceeded 1 min; killed');
    expect(gone(pid), `reparented pid ${pid} survived`).toBe(true);
  } finally { cleanup([pid]); }
}));

test('a child that left the group for its own session is killed through the PID tree', () => withDir((dir) => {
  const own = join(dir, 'own');
  const r = watch(`setsid sleep 300 & echo $! > ${own}; sleep 300`, { minutes: '1' });
  const pid = pidsIn(own)[0];
  try {
    expect(r.status, r.stderr).toBe(124);
    expect(gone(pid), `own-session pid ${pid} survived`).toBe(true);
  } finally { cleanup([pid]); }
}));

test('the kill is scoped to the command\'s own tree and group: an outside process with the same name survives', () => {
  const outside = spawnSync('bash', ['-c', 'sleep 300 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' });
  const pid = Number(outside.stdout.trim());
  try {
    expect(running(pid)).toBe(true);
    const r = watch('sleep 300', { minutes: '1' });
    expect(r.status).toBe(124);
    expect(running(pid), 'a sleep outside the tree was killed').toBe(true);
  } finally { cleanup([pid]); }
  // No name-based kill anywhere in the script (Hugo's house rule).
  expect(readFileSync(script, 'utf8')).not.toMatch(/\bpkill\b|\bkillall\b|pgrep/);
});

test('a stalled diagnostic cannot hold the kill (BLIND P2)', () => withDir((dir) => {
  const root = join(dir, 'root');
  const PATH = shim(dir, 'df', 'exec sleep 300');   // df never returns
  const t0 = Date.now();
  const r = watch(`echo $$ > ${root}; sleep 300`, { minutes: '1', extraEnv: { PATH } });
  const pid = pidsIn(root)[0];
  try {
    expect(r.status, r.stderr).toBe(124);
    expect(r.stdout).toContain('[watchdog] vitest exceeded 1 min; killed');
    expect(Date.now() - t0).toBeLessThan(30_000);
    expect(gone(pid)).toBe(true);
  } finally { cleanup([pid]); }
}));

test('a process still running after the kill is reported as not verified, still exit 124', () => withDir((dir) => {
  const root = join(dir, 'root');
  // The survivor check sees one extra, never-ending member of the command's group.
  const PATH = shim(dir, 'ps', `if [ "$*" = "-eo pid=,pgid=,stat=" ]; then ${realPs} "$@"; echo "4194999 $(cat ${root}) S"; exit 0; fi
exec ${realPs} "$@"`);
  const r = watch(`echo $$ > ${root}; sleep 300`, { minutes: '1', extraEnv: { PATH } });
  const pid = pidsIn(root)[0];
  try {
    expect(r.status, r.stderr).toBe(124);
    expect(r.stdout).toContain('[watchdog] vitest exceeded 1 min; kill NOT verified, still running: 4194999');
    expect(r.stdout).not.toContain('; killed');
  } finally { cleanup([pid]); }
}));

test('a verification scan that fails is never reported as a verified kill (BLIND delta P1)', () => withDir((dir) => {
  const root = join(dir, 'root');
  const PATH = shim(dir, 'ps', `[ "$*" = "-eo pid=,pgid=,stat=" ] && exit 1
exec ${realPs} "$@"`);
  const r = watch(`echo $$ > ${root}; sleep 300`, { minutes: '1', extraEnv: { PATH } });
  const pid = pidsIn(root)[0];
  try {
    expect(r.status, r.stderr).toBe(124);
    expect(r.stdout).toContain('[watchdog] vitest exceeded 1 min; kill NOT verified, the process table could not be read');
    expect(r.stdout).not.toContain('; killed');
    expect(gone(pid)).toBe(true);   // the group KILL still went out
  } finally { cleanup([pid]); }
}));

test('a tree scan that fails still kills the group, and the kill is reported unverified (BLIND delta P1)', () => withDir((dir) => {
  const root = join(dir, 'root');
  const PATH = shim(dir, 'ps', `[ "$*" = "-eo pid=,ppid=" ] && exit 1
exec ${realPs} "$@"`);
  const r = watch(`echo $$ > ${root}; sleep 300 & wait`, { minutes: '1', extraEnv: { PATH } });
  const pid = pidsIn(root)[0];
  try {
    expect(r.status, r.stderr).toBe(124);
    expect(r.stdout).toContain('[watchdog] vitest exceeded 1 min; kill NOT verified, a process scan failed');
    expect(gone(pid)).toBe(true);
  } finally { cleanup([pid]); }
}));

test('a slow scan that never settles cannot hold the KILL past the cleanup bound (BLIND delta P2)', () => withDir((dir) => {
  const root = join(dir, 'root');
  // Each tree scan takes 0.6 s and shows one more child the watchdog has not stopped yet (an unused PID above the
  // kernel's limit, so no real process is signalled). Without the elapsed bound the loop runs its 50 rounds (30 s+).
  const PATH = shim(dir, 'ps', `if [ "$*" = "-eo pid=,ppid=" ]; then
  n=$(( $(cat ${dir}/calls 2>/dev/null || echo 0) + 1 )); echo "$n" > ${dir}/calls
  sleep 0.6; ${realPs} "$@"; echo "$(( 4194400 + n )) $(cat ${root})"; exit 0
fi
exec ${realPs} "$@"`);
  const t0 = Date.now();
  const r = watch(`echo $$ > ${root}; sleep 300`, { minutes: '1', extraEnv: { PATH } });
  const pid = pidsIn(root)[0];
  try {
    expect(r.status, r.stderr).toBe(124);
    expect(Date.now() - t0).toBeLessThan(20_000);   // the bound is 5 s with the test unit
    expect(Number(readFileSync(join(dir, 'calls'), 'utf8'))).toBeLessThan(15);
    expect(gone(pid)).toBe(true);
  } finally { cleanup([pid]); }
}));

test('a clock that cannot be read at start refuses before the command runs', () => withDir((dir) => {
  const ran = join(dir, 'ran');
  const r = watch(`touch ${ran}`, { minutes: '20', extraEnv: { WATCHDOG_UPTIME_FILE: join(dir, 'no-such-clock') } });
  expect(r.status).toBe(2);
  expect(r.stderr).toContain(`[watchdog] cannot read the clock (${join(dir, 'no-such-clock')}); refusing`);
  expect(existsSync(ran)).toBe(false);
}));

test('a clock lost after launch ends the command, says so, and never stops watching silently (BLIND delta 3)', () => withDir((dir) => {
  const root = join(dir, 'root');
  const clock = join(dir, 'uptime');
  writeFileSync(clock, `${uptime()}.00 0.00\n`);   // a frozen clock: the 20 s budget is never reached by it
  const t0 = Date.now();
  // The command itself takes the clock away after it starts.
  const r = watch(`echo $$ > ${root}; sleep 1.5; rm ${clock}; sleep 300`, { minutes: '20', extraEnv: { WATCHDOG_UPTIME_FILE: clock } });
  const pid = pidsIn(root)[0];
  try {
    expect(r.status, r.stderr).toBe(124);
    const out = r.stdout;
    const dump = out.indexOf(`[watchdog] cannot read the clock (${clock}); process tree before the kill:`);
    expect(dump).toBeGreaterThanOrEqual(0);
    expect(out.indexOf('[sampler]', dump)).toBeGreaterThan(dump);
    expect(out).toContain('[watchdog] watchdog lost its clock; killed');
    expect(Date.now() - t0).toBeLessThan(30_000);
    expect(gone(pid)).toBe(true);
  } finally { cleanup([pid]); }
}));

test('with the clock lost, verification of a survivor still ends, after a bounded number of polls', () => withDir((dir) => {
  const root = join(dir, 'root');
  const clock = join(dir, 'uptime');
  writeFileSync(clock, `${uptime()}.00 0.00\n`);
  // The survivor check always sees one never-ending member of the group, and no clock is left to bound it.
  const PATH = shim(dir, 'ps', `if [ "$*" = "-eo pid=,pgid=,stat=" ]; then ${realPs} "$@"; echo "4194999 $(cat ${root}) S"; exit 0; fi
exec ${realPs} "$@"`);
  const t0 = Date.now();
  const r = watch(`echo $$ > ${root}; sleep 1.5; rm ${clock}; sleep 300`, { minutes: '20', extraEnv: { WATCHDOG_UPTIME_FILE: clock, PATH } });
  const pid = pidsIn(root)[0];
  try {
    expect(r.status, r.stderr).toBe(124);
    expect(r.stdout).toContain('[watchdog] watchdog lost its clock; kill NOT verified, still running: 4194999');
    expect(Date.now() - t0).toBeLessThan(45_000);
  } finally { cleanup([pid]); }
}));

test('a walked PID that is no longer stopped at the KILL is left alone and reported, never killed blind (gate, #128652)', () => withDir((dir) => {
  // The kill must never widen: a walked PID gets the KILL only if it is still stopped, because one that is running was
  // resumed by someone else or is a reused PID. Here an outside helper keeps resuming a child that left the group (so
  // only the walk reaches it); the watchdog must leave it running and say the kill was not verified.
  const own = join(dir, 'own');
  const helper = spawn('bash', ['-c', `until [ -s ${own} ]; do sleep 0.01; done; c=$(cat ${own}); while kill -CONT "$c" 2>/dev/null; do :; done`], { stdio: 'ignore' });
  // The child's output goes nowhere, so the survivor holds no pipe to this test open.
  const r = watch(`setsid sleep 300 >/dev/null 2>&1 & echo $! > ${own}; sleep 300`, { minutes: '1' });
  const pid = pidsIn(own)[0];
  try {
    expect(r.status, r.stderr).toBe(124);
    expect(r.stdout).toMatch(new RegExp(`kill NOT verified, still running: .*\\b${pid}\\b`));
    expect(running(pid), 'a PID that was not stopped at the KILL was killed').toBe(true);
  } finally { cleanup([pid]); helper.kill('SIGKILL'); }
}));

test('a TERM to the watchdog (the step cancelled) still ends the command', () => withDir((dir) => {
  const root = join(dir, 'root');
  const env = { ...baseEnv(), WATCHDOG_MINUTES: '30', WATCHDOG_STEP_TIMEOUT_MINUTES: '45', WATCHDOG_SECONDS_PER_MINUTE: '1' };
  const r = spawnSync('bash', ['-c', `bash ${script} -- bash -c 'echo $$ > ${root}; sleep 300' & w=$!; until [ -s ${root} ]; do sleep 0.05; done; kill -TERM $w; wait $w`], { env, encoding: 'utf8', timeout: 30_000 });
  const pid = pidsIn(root)[0];
  try {
    expect(r.status, r.stderr).toBe(143);
    expect(gone(pid), `pid ${pid} survived the watchdog's TERM`).toBe(true);
  } finally { cleanup([pid]); }
}));

test('inside the budget the command\'s own exit code comes back unchanged, with no watchdog line', () => {
  for (const [command, code] of [['true', 0], ['exit 1', 1], ['exit 7', 7]]) {
    const r = watch(command, { minutes: '20' });
    expect(r.status, command).toBe(code);
    expect(r.stdout, command).not.toContain('[watchdog]');
  }
});

test('a bad setting refuses before the command runs, with a fixed message naming it', () => withDir((dir) => {
  const ran = join(dir, 'ran');
  const budget = '[watchdog] WATCHDOG_MINUTES must be a positive integer below WATCHDOG_STEP_TIMEOUT_MINUTES (the step\'s timeout-minutes); refusing';
  const unit = '[watchdog] WATCHDOG_SECONDS_PER_MINUTE must be a positive integer of at most four digits (tests only); refusing';
  const start = '[watchdog] WATCHDOG_STEP_STARTED_AT must be the step\'s start in whole seconds since boot (/proc/uptime), not after now; refusing';
  const now = uptime();
  const cases = [
    ...[['', '45'], ['abc', '45'], ['0', '45'], ['-5', '45'], ['1.5', '45'], ['045x', '45'], ['45', '45'], ['50', '45'], ['40', ''], ['40', 'x'],
      ['18446744073709551617', '45'], ['40', '18446744073709551657']].map(([minutes, stepTimeout]) => [{ minutes, stepTimeout }, budget]),
    ...['0', 'x', '18446744073709551617'].map((u) => [{ minutes: '40', extraEnv: { WATCHDOG_SECONDS_PER_MINUTE: u } }, unit]),
    // '' is a failed read at step entry: refused, never taken as "start now" (BLIND delta P2).
    ...['x', '', ' ', '-1', '1.5', String(now + 3600), '18446744073709551617'].map((t) => [{ minutes: '40', extraEnv: { WATCHDOG_STEP_STARTED_AT: t } }, start]),
  ];
  for (const [opts, message] of cases) {
    const label = JSON.stringify(opts);
    const r = watch(`touch ${ran}`, opts);
    expect(r.status, label).toBe(2);
    expect(r.stderr, label).toContain(message);
    expect(existsSync(ran), `${label} ran the command`).toBe(false);
  }
  const ok = watch(`touch ${ran}`, { minutes: '40', stepTimeout: '45' });
  expect(ok.status).toBe(0);
  expect(existsSync(ran)).toBe(true);
}));

test('the budget counts from WATCHDOG_STEP_STARTED_AT: time the step spent before the watchdog comes out of it', () => {
  const t0 = Date.now();
  // The step started 100 s ago with a 20 s budget: already spent, so the watchdog fires on its first check.
  const r = watch('sleep 300', { minutes: '20', extraEnv: { WATCHDOG_STEP_STARTED_AT: String(Math.max(0, uptime() - 100)) } });
  expect(r.status, r.stderr).toBe(124);
  expect(Date.now() - t0).toBeLessThan(15_000);
});

test('the step runs the watchdog from its own start, and its step-timeout setting equals its timeout-minutes (no drift)', () => {
  const wf = parse(readFileSync(join(repo, '.github/workflows/test.yml'), 'utf8'));
  const step = wf.jobs['test-shard'].steps.find((s) => typeof s.name === 'string' && s.name.startsWith('Run vitest suite'));
  expect(step, 'the Run vitest suite step').toBeTruthy();
  expect(step.run).toMatch(/scripts\/ci\/vitest-watchdog\.sh -- pnpm test --shard=/);
  // Two lines, so a failed read fails the step (bash -e) instead of exporting an empty start; the watchdog refuses an
  // empty one anyway. The probe before the watchdog is bounded.
  expect(step.run.split('\n').slice(0, 2)).toEqual(['read -r up _ < /proc/uptime', 'export WATCHDOG_STEP_STARTED_AT=${up%.*}']);
  expect(step.run).toMatch(/^timeout -k 10 120 psql /m);   // a hard deadline: KILL 10 s after the TERM
  expect(String(step.env.WATCHDOG_STEP_TIMEOUT_MINUTES)).toBe(String(step['timeout-minutes']));
  const minutes = Number(step.env.WATCHDOG_MINUTES);
  expect(Number.isInteger(minutes) && minutes > 0 && minutes < step['timeout-minutes']).toBe(true);
  expect(step.env.WATCHDOG_SECONDS_PER_MINUTE).toBeUndefined();   // the test unit never reaches CI
  expect(step.env.WATCHDOG_UPTIME_FILE).toBeUndefined();          // nor the test clock
  expect(step.run).not.toMatch(/WATCHDOG_(SECONDS_PER_MINUTE|UPTIME_FILE)/);
});
