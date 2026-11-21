// #4646 (Refs #4278; gate CHECKED T1 by Xanthos, issuecomment-7054667627): the in-VM watchdog on the test-shard vitest
// step. The real script, with a test time unit (WATCHDOG_SECONDS_PER_MINUTE=1, so a "minute" is one second) and
// stand-in commands; no Actions run, no stack, no test database.
//
// Pins, one per gate condition:
//   1. a hang: the dump (the [watchdog] process list and a final [sampler] block) is printed BEFORE the kill, then the
//      fixed "exceeded N min; killed" line, then the distinguishable exit 124; every process of the command's tree is
//      gone, killed by PID;
//   2. the kill is scoped: a process outside the command's tree survives, and nothing is matched by name;
//   3. inside the budget the command's own exit code comes back unchanged (0, 1 and another code);
//   4. the budget refuses a non-integer, empty, zero, negative or not-below-the-step-timeout value before the command
//      runs, with a fixed message;
//   5. the 45 has one source: the step's WATCHDOG_STEP_TIMEOUT_MINUTES must equal its timeout-minutes in test.yml, and
//      WATCHDOG_MINUTES must be below it, so the two cannot drift apart unnoticed.
import { test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'vitest-watchdog.sh');
const repo = join(here, '..', '..');

/** Run the watchdog around `command` (a bash -c body) with a budget in test "minutes" (seconds). */
function watch(command, { minutes = '3', stepTimeout = '45', extraEnv = {} } = {}) {
  const env = { ...process.env, WATCHDOG_MINUTES: minutes, WATCHDOG_STEP_TIMEOUT_MINUTES: stepTimeout, WATCHDOG_SECONDS_PER_MINUTE: '1', ...extraEnv };
  return spawnSync('bash', [script, '--', 'bash', '-c', command], { env, encoding: 'utf8', timeout: 60_000 });
}
const alive = (pid) => spawnSync('kill', ['-0', String(pid)]).status === 0;
const withDir = (fn) => { const dir = mkdtempSync(join(tmpdir(), 'watchdog-4646-')); try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); } };

test('a hang: dump first, then the kill, then the fixed line and exit 124; the whole tree is gone', () => withDir((dir) => {
  const pids = join(dir, 'pids');
  // A command with a tree: two children and a grandchild, all outliving the budget. Each records its PID.
  const r = watch(`echo $$ >> ${pids}; (sleep 300 & echo $! >> ${pids}; wait) & echo $! >> ${pids}; sleep 300 & echo $! >> ${pids}; wait`, { minutes: '2' });
  expect(r.status, r.stderr).toBe(124);
  const out = r.stdout;
  const dump = out.indexOf('[watchdog] budget of 2 min reached; process tree before the kill:');
  const sampler = out.indexOf('[sampler]', dump);
  const killed = out.indexOf('[watchdog] vitest exceeded 2 min; killed');
  expect(dump).toBeGreaterThanOrEqual(0);
  expect(sampler).toBeGreaterThan(dump);
  expect(killed).toBeGreaterThan(sampler);
  expect(out.slice(sampler, killed)).toMatch(/Mem:/);   // free -m ran in the final block
  const recorded = readFileSync(pids, 'utf8').trim().split('\n').map(Number);
  expect(recorded.length).toBe(4);
  for (const pid of recorded) expect(alive(pid), `pid ${pid} survived`).toBe(false);
}));

test('the kill is scoped to the command\'s own tree: an outside process with the same name survives', () => {
  const outside = spawnSync('bash', ['-c', 'sleep 300 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' });
  const pid = Number(outside.stdout.trim());
  try {
    expect(alive(pid)).toBe(true);
    const r = watch('sleep 300', { minutes: '1' });
    expect(r.status).toBe(124);
    expect(alive(pid), 'a sleep outside the tree was killed').toBe(true);
  } finally { spawnSync('kill', [String(pid)]); }
  // No name-based kill anywhere in the script (Hugo's house rule).
  expect(readFileSync(script, 'utf8')).not.toMatch(/\bpkill\b|\bkillall\b|pgrep/);
});

test('inside the budget the command\'s own exit code comes back unchanged, with no watchdog line', () => {
  for (const [command, code] of [['true', 0], ['exit 1', 1], ['exit 7', 7]]) {
    const r = watch(command, { minutes: '20' });
    expect(r.status, command).toBe(code);
    expect(r.stdout, command).not.toContain('[watchdog]');
  }
});

test('a bad budget refuses before the command runs, with a fixed message', () => withDir((dir) => {
  const ran = join(dir, 'ran');
  for (const [minutes, stepTimeout] of [['', '45'], ['abc', '45'], ['0', '45'], ['-5', '45'], ['1.5', '45'], ['045x', '45'], ['45', '45'], ['50', '45'], ['40', ''], ['40', 'x']]) {
    const r = watch(`touch ${ran}`, { minutes, stepTimeout });
    expect(r.status, `${minutes}/${stepTimeout}`).toBe(2);
    expect(r.stderr, `${minutes}/${stepTimeout}`).toContain('[watchdog] WATCHDOG_MINUTES must be a positive integer below WATCHDOG_STEP_TIMEOUT_MINUTES (the step\'s timeout-minutes); refusing');
    expect(existsSync(ran), `${minutes}/${stepTimeout} ran the command`).toBe(false);
  }
  const ok = watch(`touch ${ran}`, { minutes: '40', stepTimeout: '45' });
  expect(ok.status).toBe(0);
  expect(existsSync(ran)).toBe(true);
}));

test('the step runs the watchdog, and its step-timeout setting equals the step\'s timeout-minutes (no drift)', () => {
  const wf = parse(readFileSync(join(repo, '.github/workflows/test.yml'), 'utf8'));
  const step = wf.jobs['test-shard'].steps.find((s) => typeof s.name === 'string' && s.name.startsWith('Run vitest suite'));
  expect(step, 'the Run vitest suite step').toBeTruthy();
  expect(step.run).toMatch(/scripts\/ci\/vitest-watchdog\.sh -- pnpm test --shard=/);
  expect(String(step.env.WATCHDOG_STEP_TIMEOUT_MINUTES)).toBe(String(step['timeout-minutes']));
  const minutes = Number(step.env.WATCHDOG_MINUTES);
  expect(Number.isInteger(minutes) && minutes > 0 && minutes < step['timeout-minutes']).toBe(true);
  expect(step.env.WATCHDOG_SECONDS_PER_MINUTE).toBeUndefined();   // the test unit never reaches CI
});
