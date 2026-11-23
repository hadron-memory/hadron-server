// #4646 (Refs #4278; gate CHECKED T1 by Xanthos, issuecomment-7054667627): the in-VM watchdog on the test-shard vitest
// step. The real script, with a test time unit (WATCHDOG_SECONDS_PER_MINUTE=1, so a "minute" is one second) and
// stand-in commands; no Actions run, no stack, no test database. Where a pin needs a stalled tool, a survivor or a lost
// clock, a shim on PATH (or a test clock file) provides it; the processes, groups and signals are real.
//
// Design (Peter's ruling on #4647, team chat #129455): the command runs as its own process group and ONLY that group
// is ever signalled; a descendant that leaves the group is the accepted residual (#128652), never reported as killed.
//
// Pins:
//   1. a hang: the dump (the [watchdog] process list and a final [sampler] block) is printed while the command still
//      runs, then the group is signalled, the fixed final line, and the distinguishable exit 124; every member of the
//      group is gone, including a grandchild reparented away when its parent exited;
//   2. only the group: an outside process survives; a child that left the group is not signalled and the final line
//      says such descendants are not covered; the script signals nothing but the group and matches nothing by name;
//   3. a group that ignores TERM still gets the KILL after the grace;
//   4. a stalled diagnostic cannot hold the kill; a survivor, or an unreadable process table, is reported as "kill NOT
//      verified"; a TERM to the watchdog (the step cancelled) still ends the command;
//   5. the clock: unreadable at start refuses; lost after launch ends the command and says so; with no clock, each
//      wait makes one bounded attempt;
//   6. inside the budget the command's own exit code comes back unchanged (0, 1 and another code);
//   7. the settings refuse non-integer, empty, zero, negative, oversized and not-below-the-step-timeout values before
//      the command runs, each with a fixed message naming its setting; the budget counts from WATCHDOG_STEP_STARTED_AT;
//   8. the 45 is declared twice in test.yml (timeout-minutes and WATCHDOG_STEP_TIMEOUT_MINUTES) and this pins them
//      equal, the budget below them, the step's first lines recording its start time, the probe's hard deadline, and
//      that no test-only setting reaches the step.
import { test as vitestTest, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

// Each pin waits on real processes and a budget of a few seconds; vitest's 5 s default is too short.
const test = (name, fn) => vitestTest(name, fn, 60_000);

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
const isLive = (pid) => { const s = state(pid); return s !== null && s !== 'Z'; };
/** Gone, allowing a bounded moment for an orphan to be reaped (`kill -0` succeeds on a zombie). */
const gone = (pid) => { for (let i = 0; i < 50 && isLive(pid); i++) spawnSync('sleep', ['0.1']); return !isLive(pid); };
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
/** The final line when the group emptied. */
const emptied = (why, pid) => `[watchdog] ${why}; process group ${pid} signalled and now empty; descendants that left the group are not covered`;

test('a hang: dump while the command still runs, then the group is signalled, the fixed line and exit 124; the group is gone', () => withDir((dir) => {
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
    const done = out.indexOf(emptied('vitest exceeded 2 min', recorded[0]));
    expect(dump).toBeGreaterThanOrEqual(0);
    expect(sampler).toBeGreaterThan(dump);
    expect(done).toBeGreaterThan(sampler);
    expect(out.slice(sampler, done)).toMatch(/Mem:/);   // free -m ran in the final block
    expect(recorded.length).toBe(4);
    const atDump = readFileSync(join(dir, 'at-dump'), 'utf8').trim().split('\n');
    expect(atDump.length).toBe(4);
    for (const line of atDump) expect(line, 'a fixture process was not running at the dump').toMatch(/^\d+ [RS]$/);
    for (const pid of recorded) expect(gone(pid), `pid ${pid} survived`).toBe(true);
  } finally { cleanup(recorded); }
}));

test('a grandchild reparented away when its parent exited is still a group member, and is killed', () => withDir((dir) => {
  const gc = join(dir, 'gc');
  // The subshell starts the grandchild and exits at once, so the grandchild is no longer in the command's ppid tree.
  const r = watch(`(sleep 300 & echo $! > ${gc}); sleep 300`, { minutes: '1' });
  const pid = pidsIn(gc)[0];
  try {
    expect(r.status, r.stderr).toBe(124);
    expect(r.stdout).toMatch(/process group \d+ signalled and now empty/);
    expect(gone(pid), `reparented pid ${pid} survived`).toBe(true);
  } finally { cleanup([pid]); }
}));

test('only the group: a child that left it is not signalled, and the final line says such descendants are not covered', () => withDir((dir) => {
  // The accepted residual (#128652): it fails toward "no kill", and nothing claims it was killed.
  const own = join(dir, 'own');
  const r = watch(`setsid sleep 300 >/dev/null 2>&1 & echo $! > ${own}; sleep 300`, { minutes: '1' });
  const pid = pidsIn(own)[0];
  try {
    expect(r.status, r.stderr).toBe(124);
    expect(state(pid), 'a process outside the group was signalled').toMatch(/^[RS]$/);
    expect(r.stdout).toContain('; descendants that left the group are not covered');
  } finally { cleanup([pid]); }
}));

test('only the group: an outside process survives, and the script signals nothing but the group, matching nothing by name', () => {
  const outside = spawnSync('bash', ['-c', 'sleep 300 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' });
  const pid = Number(outside.stdout.trim());
  try {
    expect(isLive(pid)).toBe(true);
    const r = watch('sleep 300', { minutes: '1' });
    expect(r.status).toBe(124);
    expect(state(pid), 'a sleep outside the group was signalled').toMatch(/^[RS]$/);
  } finally { cleanup([pid]); }
  const source = readFileSync(script, 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('#'));
  // Hugo's house rule: no name-based kill.
  expect(source.join('\n')).not.toMatch(/\bpkill\b|\bkillall\b|pgrep/);
  // Every signal the script sends is to the group ("-$cmd"); the only other use of kill is the liveness probe (-0).
  // (A kill invocation always takes an option here; the words "kill NOT verified" in a message are not one.)
  const kills = source.flatMap((l) => l.match(/\bkill -[^;|&)]*/g) ?? []);
  expect(kills.length).toBeGreaterThan(0);
  for (const k of kills) expect(k, `a signal not aimed at the group: ${k}`).toMatch(/^kill (-0 "\$cmd"|-s (TERM|KILL) -- "-\$cmd")/);
});

test('a group that ignores TERM still gets the KILL after the grace', () => withDir((dir) => {
  const root = join(dir, 'root');
  // An ignored signal stays ignored across fork and exec, so the whole group ignores TERM.
  const r = watch(`trap '' TERM; echo $$ > ${root}; sleep 300 & wait`, { minutes: '1' });
  const pid = pidsIn(root)[0];
  try {
    expect(r.status, r.stderr).toBe(124);
    expect(r.stdout).toContain(emptied('vitest exceeded 1 min', pid));
    expect(gone(pid)).toBe(true);
  } finally { cleanup([pid]); }
}));

test('a stalled diagnostic cannot hold the kill', () => withDir((dir) => {
  const root = join(dir, 'root');
  const PATH = shim(dir, 'df', 'exec sleep 300');   // df never returns
  const t0 = Date.now();
  const r = watch(`echo $$ > ${root}; sleep 300`, { minutes: '1', extraEnv: { PATH } });
  const pid = pidsIn(root)[0];
  try {
    expect(r.status, r.stderr).toBe(124);
    expect(r.stdout).toContain(emptied('vitest exceeded 1 min', pid));
    expect(Date.now() - t0).toBeLessThan(30_000);
    expect(gone(pid)).toBe(true);
  } finally { cleanup([pid]); }
}));

test('a group member still running after the kill is reported as not verified, still exit 124', () => withDir((dir) => {
  const root = join(dir, 'root');
  // The membership check always sees one extra, never-ending member of the command's group.
  const PATH = shim(dir, 'ps', `if [ "$*" = "-eo pid=,pgid=,stat=" ]; then ${realPs} "$@"; echo "4194999 $(cat ${root}) S"; exit 0; fi
exec ${realPs} "$@"`);
  const r = watch(`echo $$ > ${root}; sleep 300`, { minutes: '1', extraEnv: { PATH } });
  const pid = pidsIn(root)[0];
  try {
    expect(r.status, r.stderr).toBe(124);
    expect(r.stdout).toContain(`[watchdog] vitest exceeded 1 min; process group ${pid} signalled, kill NOT verified, still running: 4194999`);
    expect(r.stdout).not.toContain('now empty');
  } finally { cleanup([pid]); }
}));

test('a membership check that cannot read the process table is never reported as an empty group', () => withDir((dir) => {
  const root = join(dir, 'root');
  const PATH = shim(dir, 'ps', `[ "$*" = "-eo pid=,pgid=,stat=" ] && exit 1
exec ${realPs} "$@"`);
  const r = watch(`echo $$ > ${root}; sleep 300`, { minutes: '1', extraEnv: { PATH } });
  const pid = pidsIn(root)[0];
  try {
    expect(r.status, r.stderr).toBe(124);
    expect(r.stdout).toContain(`process group ${pid} signalled, kill NOT verified, the process table could not be read`);
    expect(r.stdout).not.toContain('now empty');
    expect(gone(pid)).toBe(true);   // the KILL still went out
  } finally { cleanup([pid]); }
}));

test('a clock that cannot be read at start refuses before the command runs', () => withDir((dir) => {
  const ran = join(dir, 'ran');
  const r = watch(`touch ${ran}`, { minutes: '20', extraEnv: { WATCHDOG_UPTIME_FILE: join(dir, 'no-such-clock') } });
  expect(r.status).toBe(2);
  expect(r.stderr).toContain(`[watchdog] cannot read the clock (${join(dir, 'no-such-clock')}); refusing`);
  expect(existsSync(ran)).toBe(false);
}));

test('a clock lost after launch ends the command, says so, and never stops watching silently', () => withDir((dir) => {
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
    expect(out).toContain(emptied('watchdog lost its clock', pid));
    expect(Date.now() - t0).toBeLessThan(30_000);
    expect(gone(pid)).toBe(true);
  } finally { cleanup([pid]); }
}));

test('with the clock lost, each wait on the group makes one bounded attempt, and a survivor is reported', () => withDir((dir) => {
  const root = join(dir, 'root');
  const clock = join(dir, 'uptime');
  writeFileSync(clock, `${uptime()}.00 0.00\n`);
  // The membership check always sees one never-ending member and takes 2 s, so polling on would take a minute or more.
  const PATH = shim(dir, 'ps', `if [ "$*" = "-eo pid=,pgid=,stat=" ]; then echo x >> ${dir}/checks; sleep 2; ${realPs} "$@"; echo "4194999 $(cat ${root}) S"; exit 0; fi
exec ${realPs} "$@"`);
  const t0 = Date.now();
  const r = watch(`echo $$ > ${root}; sleep 1.5; rm ${clock}; sleep 300`, { minutes: '20', extraEnv: { WATCHDOG_UPTIME_FILE: clock, PATH } });
  const pid = pidsIn(root)[0];
  try {
    expect(r.status, r.stderr).toBe(124);
    expect(r.stdout).toContain(`[watchdog] watchdog lost its clock; process group ${pid} signalled, kill NOT verified, still running: 4194999`);
    // Exactly two checks: one in the grace after TERM, one in the verification.
    expect(readFileSync(join(dir, 'checks'), 'utf8').trim().split('\n')).toHaveLength(2);
    expect(Date.now() - t0).toBeLessThan(25_000);
  } finally { cleanup([pid]); }
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
    // '' is a failed read at step entry: refused, never taken as "start now".
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
  // empty one anyway.
  expect(step.run.split('\n').slice(0, 2)).toEqual(['read -r up _ < /proc/uptime', 'export WATCHDOG_STEP_STARTED_AT=${up%.*}']);
  expect(step.run).toMatch(/^timeout -k 10 120 psql /m);   // a hard deadline: KILL 10 s after the TERM
  expect(String(step.env.WATCHDOG_STEP_TIMEOUT_MINUTES)).toBe(String(step['timeout-minutes']));
  const minutes = Number(step.env.WATCHDOG_MINUTES);
  expect(Number.isInteger(minutes) && minutes > 0 && minutes < step['timeout-minutes']).toBe(true);
  // No test-only setting reaches the step.
  expect(step.env.WATCHDOG_SECONDS_PER_MINUTE).toBeUndefined();
  expect(step.env.WATCHDOG_UPTIME_FILE).toBeUndefined();
  expect(step.run).not.toMatch(/WATCHDOG_(SECONDS_PER_MINUTE|UPTIME_FILE|PROC_ROOT)/);
});
