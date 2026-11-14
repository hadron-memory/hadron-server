/**
 * #4011 (follow-ups from the #3994 review of the #3954 human-presence guard), items 1, 2, 4 and 6.
 *
 *  A  whole-hook budget: stdin 5 s, whoami 5, worker get 5, one transcript pass 10, presence margin 5
 *     (presence = 25), warning post 10, log/cleanup margin 5; process start to exit <= 45 s on EVERY skip
 *     path. A step that times out is an unreadable presence: logged, warned once, exit 0, no kill.
 *     Tests cannot sleep 45 s, so each budget reads an env override and runs scaled down.
 *  B  one jq pass over the transcript (validates every record AND finds the last human prompt).
 *  C  `whoami --json` `.workerName` must equal the hook's worktree name (text parse is the fallback).
 *  D  one shared warning marker across skip reasons (preserved, 6 h TTL).
 *  E  gaps: whoami failure, a bare human paste, a failed kill followed by a re-fire.
 *
 * Everything is a stub: no live worker, no real kill, no installed hook. The "agent" is a stand-in process
 * under a `worker-supervise` parent, so "not killed" is observable.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertNoSurvivors, cleanupOwned, newRun, ownedEnv, ownedProcesses, parseStat, signalOwned, spawnOwned, startWatchdog, realOps,
  type OwnedRun, type ProcOps, type ProcRead, type ProcStat,
} from './containment4160';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'worker-auto-shed');
const NAME = 'demo-wt';
const MIN = 60_000;
const REAL_JQ = spawnSync('sh', ['-c', 'command -v jq'], { encoding: 'utf8' }).stdout.trim();
const REAL_CAT = spawnSync('sh', ['-c', 'command -v cat'], { encoding: 'utf8' }).stdout.trim();

/** Scaled budgets (seconds). Their sum is the aggregate the hook must stay inside: stdin + whoami + worker + transcript + warn + margins. */
const SCALED = { stdin: 0.4, whoami: 0.4, worker: 0.4, transcript: 0.6, warn: 0.4 };
const SCALED_ENV = {
  WORKER_AUTO_SHED_T_STDIN: String(SCALED.stdin),
  WORKER_AUTO_SHED_T_WHOAMI: String(SCALED.whoami),
  WORKER_AUTO_SHED_T_WORKER: String(SCALED.worker),
  WORKER_AUTO_SHED_T_TRANSCRIPT: String(SCALED.transcript),
  WORKER_AUTO_SHED_T_WARN: String(SCALED.warn),
};
/** The scaled aggregate (the 5 + 25 + 10 + 5 shape, scaled): every step budget plus slack for process spawns on a loaded host. */
const SCALED_TOTAL_MS = (SCALED.stdin + SCALED.whoami + SCALED.worker + SCALED.transcript + SCALED.warn) * 1000 + 3000;

/** Hard ceiling for any hook run: `timeout` signals its whole process group, so a hung hook and its children die with it. */
const HARNESS_DEADLINE_S = 60;
const hookCmd = (deadlineS = HARNESS_DEADLINE_S): [string, string[]] => ['timeout', ['-k', '2', String(deadlineS), 'bash', HOOK]];

const roots: string[] = [];
const agents: Array<{ pid: number }> = [];
/**
 * #4160 item 2: every process a test starts carries its run's HARNESS_RUN_ID, and cleanup finds them by it (nested `timeout`
 * groups included), then asserts zero owned and zero unverifiable survivors. An early assertion failure still runs this.
 */
const runs: OwnedRun[] = [];
const newOwnedRun = (logFile: string): OwnedRun => { const r = newRun({ harnessDeadlineS: HARNESS_DEADLINE_S, logFile }); runs.push(r); return r; };
afterEach(async () => {
  agents.splice(0);
  const errs: string[] = [];
  for (const run of runs.splice(0)) {
    try { assertNoSurvivors(await cleanupOwned(run)); } catch (e) { errs.push((e as Error).message); }
  }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  if (errs.length) throw new Error(errs.join('; '));
});

interface Sb { run: OwnedRun; root: string; home: string; bin: string; calls: string; wt: string; pid: number; gone: () => boolean }

/**
 * A sandbox with a scriptable `hadron` and `jq`. Knobs are files under <root>/k so a test can change them between fires:
 *   sleep-whoami / sleep-worker / sleep-post   seconds the matching call sleeps first
 *   post-fail                                  the chat post exits 1
 *   whoami-json                                body printed for `whoami --json` (FAIL = exit 1)
 *   whoami-text                                first line printed for plain `whoami` (FAIL = exit 1, EMPTY = nothing)
 *   terminal.json                              body for `worker get` (FAIL = exit 1)
 *   sleep-jq                                   seconds the transcript `jq` sleeps first
 */
async function stage(): Promise<Sb> {
  const root = mkdtempSync(join(tmpdir(), 'auto-shed-4011-'));
  roots.push(root);
  const run = newOwnedRun(join(root, 'watchdog.log'));
  const home = join(root, 'home'); mkdirSync(home);
  const bin = join(root, 'bin'); mkdirSync(bin);
  const k = join(root, 'k'); mkdirSync(k);
  const calls = join(root, 'hadron-calls.log');
  writeFileSync(join(bin, 'hadron'), `#!/bin/bash
echo "$@" >> "${calls}"
nap() { [ -f "${k}/$1" ] && sleep "$(cat "${k}/$1")"; }
case "$*" in
  "team session whoami --json"*)
    nap sleep-whoami
    [ -f "${k}/set-uptime" ] && cp "${k}/set-uptime" "${k}/uptime"
    nap sleep-whoami-json
    [ -f "${k}/ignore-term-whoami" ] && { trap '' TERM; exec sleep 30; }
    b=$(cat "${k}/whoami-json" 2>/dev/null || echo '{"workerName":"Demo-wt"}')
    [ "$b" = FAIL ] && exit 1
    echo "$b" ;;
  "team session whoami"*)
    nap sleep-whoami
    if [ -f "${k}/stamp-text" ]; then
      date +%s.%N > "${k}/text-start"
      trap 'date +%s.%N > "${k}/text-end"; exit 143' TERM
      sleep 5 >/dev/null 2>&1 & wait $!
    fi
    b=$(cat "${k}/whoami-text" 2>/dev/null || echo 'Demo-wt (server-engineer)')
    [ "$b" = FAIL ] && exit 1
    [ "$b" = EMPTY ] && exit 0
    echo "$b" ;;
  "team worker get"*)
    nap sleep-worker
    [ -f "${k}/ignore-term-worker" ] && { trap '' TERM; exec sleep 30; }
    t="${k}/terminal.json"
    if [ -f "$t" ] && [ "$(cat "$t")" = FAIL ]; then exit 1; fi
    if [ -f "$t" ]; then cat "$t"; else echo '{"terminal":{"prompt":"empty"}}'; fi ;;
  "team session resume-claim"*)
    nap sleep-claim
    exit 0 ;;
  "team chat post"*)
    [ -f "${k}/ignore-term-post" ] && { trap '' TERM; exec sleep 30; }
    nap sleep-post
    [ -f "${k}/post-fail" ] && exit 1
    exit 0 ;;
esac
exit 0
`);
  chmodSync(join(bin, 'hadron'), 0o755);
  // A jq that can be made slow for the transcript filter only (the one with -R), so a "huge transcript" is deterministic.
  writeFileSync(join(bin, 'jq'), `#!/bin/bash
case "$*" in
  *-R*) [ -f "${k}/ignore-term-jq" ] && { trap '' TERM; exec sleep 30; }
        [ -f "${k}/sleep-jq" ] && sleep "$(cat "${k}/sleep-jq")" ;;
  *.workerName*) [ -f "${k}/set-uptime2" ] && cp "${k}/set-uptime2" "${k}/uptime"
                 [ -f "${k}/sleep-jq-workername" ] && sleep "$(cat "${k}/sleep-jq-workername")" ;;
  *.terminal.prompt*|*.terminal.stale*) [ -f "${k}/sleep-jq-terminal" ] && sleep "$(cat "${k}/sleep-jq-terminal")" ;;
  *.trigger*|*.cwd*|*.transcript_path*) [ -f "${k}/sleep-jq-stdin" ] && sleep "$(cat "${k}/sleep-jq-stdin")" ;;
esac
exec "${REAL_JQ}" "$@"
`);
  chmodSync(join(bin, 'jq'), 0o755);
  // A cat that can be made to ignore SIGTERM, so a stalled stdin read needs the SIGKILL escalation.
  writeFileSync(join(bin, 'cat'), `#!/bin/bash
[ -f "${k}/ignore-term-cat" ] && trap '' TERM
exec "${REAL_CAT}" "$@"
`);
  chmodSync(join(bin, 'cat'), 0o755);
  const wt = join(root, NAME); mkdirSync(wt);
  writeFileSync(join(root, 'transcript.jsonl'), promptEntry(60 * MIN, 'an old question') + '\n');
  // The stand-in agent, under a worker-supervise parent (the supervision guard of the hook).
  const pidFile = join(root, 'agent.pid');
  spawn('setsid', ['bash', '-c', `(exec -a claude bash -c "trap 'exit 0' TERM; while :; do sleep 0.1; done") & echo $! > "${pidFile}"; wait`, 'worker-supervise'], { stdio: 'ignore', env: ownedEnv(run, process.env) });
  for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50));
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  for (let i = 0; i < 100; i++) {
    try { if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')[0] === 'claude') break; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  agents.push({ pid });
  const gone = (): boolean => { try { process.kill(pid, 0); return false; } catch { return true; } };
  return { run, root, home, bin, calls, wt, pid, gone };
}

function promptEntry(agoMs: number, content: unknown, kind = 'human'): string {
  return JSON.stringify({ type: 'user', origin: { kind }, promptSource: 'typed', timestamp: new Date(Date.now() - agoMs).toISOString(), message: { role: 'user', content } });
}
const knob = (s: Sb, file: string, body: string): void => writeFileSync(join(s.root, 'k', file), body);
const transcript = (s: Sb, ...lines: string[]): void => writeFileSync(join(s.root, 'transcript.jsonl'), lines.join('\n') + '\n');
const stateDir = (s: Sb): string => join(s.home, '.local', 'state', 'hadron-worker-shed');
// A regular file only: K4 makes the log a fifo, and reading a fifo with no writer blocks forever.
const shedLog = (s: Sb): string => { const f = join(stateDir(s), 'auto-shed.log'); return existsSync(f) && statSync(f).isFile() ? readFileSync(f, 'utf8') : ''; };
const warnings = (s: Sb): string[] => (existsSync(s.calls) ? readFileSync(s.calls, 'utf8') : '').split('\n').filter((l) => l.startsWith('team chat post'));

/** One PreCompact(auto) fire; `scaled` runs it under the scaled-down budgets, otherwise the defaults apply. */
function fire(s: Sb, opts: { scaled?: boolean; input?: string; env?: Record<string, string>; deadlineS?: number } = {}): { status: number | null; log: string; ms: number } {
  const env: Record<string, string> = { HARNESS_RUN_ID: s.run.runId, PATH: `${s.bin}:${process.env.PATH}`, HOME: s.home, CLAUDE_PID: String(s.pid), ...(opts.scaled ? SCALED_ENV : {}), ...(opts.env ?? {}) };
  const t0 = Date.now();
  const [cmd, args] = hookCmd(opts.deadlineS);
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: ((opts.deadlineS ?? HARNESS_DEADLINE_S) + 10) * 1000, killSignal: 'SIGKILL', input: opts.input ?? JSON.stringify({ trigger: 'auto', cwd: s.wt, transcript_path: join(s.root, 'transcript.jsonl') }), env });
  return { status: r.status, log: shedLog(s), ms: Date.now() - t0 };
}

describe('#4011 A: the whole hook is bounded on every skip path', () => {
  it('positive control: instant stubs, defaults unchanged: no human present still sheds (exit 2, agent stopped)', async () => {
    const s = await stage();
    const r = fire(s);
    expect(r.status, r.log).toBe(2);
    expect(r.log).toMatch(/stopping claude pid/);
  });

  it('a stalled stdin is a skip, not a kill: exit 0 within the stdin budget, logged, nothing else read', async () => {
    const s = await stage();
    const t0 = Date.now();
    const [cmd, args] = hookCmd();
    const child = spawnOwned(s.run, cmd, args, { PATH: `${s.bin}:${process.env.PATH}`, HOME: s.home, CLAUDE_PID: String(s.pid), ...SCALED_ENV });
    child.stdin.write('{"trigger":"auto","cw'); // a partial record, then silence with the pipe held open
    const status: number = await new Promise((res) => child.on('close', (c) => res(c ?? -1)));
    expect(status).toBe(0);
    expect(Date.now() - t0, 'the stdin read ran past its budget').toBeLessThan((SCALED.stdin * 1000) + 3000);
    expect(shedLog(s)).toMatch(/stdin read timed out/);
    expect(s.gone(), 'a stalled stdin stopped the agent').toBe(false);
    expect(existsSync(s.calls), 'hadron was called after an unreadable stdin').toBe(false);
  });

  it.each([
    ['whoami', 'sleep-whoami', 'whoami timed out'],
    ['worker get', 'sleep-worker', 'worker get timed out'],
  ])('a %s that outlasts its step: exit 0, no kill, a log line naming the step, one warning, inside the aggregate', async (_n, file, reason) => {
    const s = await stage();
    knob(s, file, '5');
    const r = fire(s, { scaled: true });
    expect(r.status, r.log).toBe(0);
    expect(r.log).toContain(`skip: human presence unreadable (${reason})`);
    expect(s.gone(), 'a timed-out step stopped the agent').toBe(false);
    expect(warnings(s)).toHaveLength(1);
    expect(r.ms, `took ${r.ms} ms`).toBeLessThan(SCALED_TOTAL_MS);
  });

  it.each([
    ['whoami .workerName parse', 'sleep-jq-workername', 'skip: human presence unreadable (whoami timed out)', true],
    ['worker get prompt/stale parse', 'sleep-jq-terminal', 'skip: human presence unreadable (worker get timed out)', true],
    ['stdin field parse', 'sleep-jq-stdin', 'skip: stdin parse timed out', false],
  ])('a stalled %s is inside its segment budget: exit 0, no kill, inside the aggregate (QA F1)', async (_n, file, expected, calledHadron) => {
    const s = await stage();
    knob(s, file, '5');
    const r = fire(s, { scaled: true });
    expect(r.status, r.log).toBe(0);
    expect(r.log).toContain(expected);
    expect(s.gone(), 'a stalled parse stopped the agent').toBe(false);
    expect(existsSync(s.calls), `hadron calls presence: ${calledHadron}`).toBe(calledHadron);
    expect(r.ms, `took ${r.ms} ms`).toBeLessThan(SCALED_TOTAL_MS);
  });

  it('a huge transcript that outlasts its pass: exit 0, no kill, logged, inside the aggregate', async () => {
    const s = await stage();
    knob(s, 'sleep-jq', '5');
    const r = fire(s, { scaled: true });
    expect(r.status, r.log).toBe(0);
    expect(r.log).toContain('skip: human presence unreadable (transcript read timed out)');
    expect(s.gone()).toBe(false);
    expect(r.ms, `took ${r.ms} ms`).toBeLessThan(SCALED_TOTAL_MS);
  });

  it('a slow decision followed by a slow warning post stays inside the aggregate: exit 0, no kill, the failure logged', async () => {
    const s = await stage();
    knob(s, 'sleep-whoami', '5');
    knob(s, 'sleep-post', '5');
    const r = fire(s, { scaled: true });
    expect(r.status, r.log).toBe(0);
    expect(r.log).toContain('whoami timed out');
    expect(r.log, 'the timed-out warning post must be logged as failed').toMatch(/warning post FAILED \(unreadable\)/);
    expect(s.gone()).toBe(false);
    expect(existsSync(join(stateDir(s), `${NAME}.skip-warned`)), 'a failed post must not mark the episode warned').toBe(false);
    expect(r.ms, `took ${r.ms} ms`).toBeLessThan(SCALED_TOTAL_MS);
  });

  it('a failing warning post alone is logged, never fatal, and the hook still exits 0 with no kill', async () => {
    const s = await stage();
    knob(s, 'terminal.json', '{"terminal":{"prompt":"not_empty"}}');
    knob(s, 'post-fail', '');
    const r = fire(s, { scaled: true });
    expect(r.status, r.log).toBe(0);
    expect(r.log).toMatch(/warning post FAILED \(typing\)/);
    expect(s.gone()).toBe(false);
  });

  it('a step that ignores SIGTERM is killed after the grace: exit 0, no kill of the agent, inside the aggregate plus the grace', async () => {
    const s = await stage();
    knob(s, 'ignore-term-whoami', '');
    const r = fire(s, { scaled: true, env: { WORKER_AUTO_SHED_T_KILL_GRACE: '0.3' } });
    expect(r.status, r.log).toBe(0);
    expect(r.log).toContain('skip: human presence unreadable (whoami timed out)');
    expect(s.gone(), 'a SIGTERM-proof whoami stopped the agent').toBe(false);
    expect(r.ms, `took ${r.ms} ms`).toBeLessThan(SCALED_TOTAL_MS);
  });

  it('an invalid or zero override falls back to the default instead of disabling the bound', async () => {
    const s = await stage();
    knob(s, 'sleep-whoami', '7');
    const r = fire(s, { env: { WORKER_AUTO_SHED_T_WHOAMI: '0', WORKER_AUTO_SHED_T_WORKER: 'abc' } });
    // `timeout 0` would mean "no limit" and let the 7 s whoami finish (shed, exit 2); the 5 s default applies instead,
    // so the step times out: unreadable, exit 0, no kill.
    expect(r.status, shedLog(s)).toBe(0);
    expect(shedLog(s)).toContain('whoami timed out');
    expect(s.gone()).toBe(false);
  }, 20_000);
});

describe('#4011 B: one jq pass validates every record and finds the last human prompt', () => {
  it('runs exactly one filter pass over the transcript', async () => {
    const s = await stage();
    // The jq shim logs each -R invocation.
    writeFileSync(join(s.bin, 'jq'), `#!/bin/bash
case "$*" in *-R*) echo pass >> "${join(s.root, 'jq-passes')}" ;; esac
exec "${REAL_JQ}" "$@"
`);
    transcript(s, promptEntry(60 * MIN, 'old'));
    expect(fire(s).status).toBe(2);
    const passes = readFileSync(join(s.root, 'jq-passes'), 'utf8').trim().split('\n');
    expect(passes, 'the transcript was parsed more than once').toHaveLength(1);
  });

  it.each([
    ['truncated record', ['{"type":"user","origin":{"kind":"human"},"timestamp":"2026-']],
    ['old valid record plus a recent invalid one', [promptEntry(60 * MIN, 'old'), '{"type":"user","origin":{"kind":"hum']],
    ['non-JSON', ['not json at all']],
    ['an unparseable record AFTER a recent human prompt', [promptEntry(1 * MIN, 'recent'), '{"broken']],
  ])('a malformed record is unreadable, never "no human": %s', async (_n, lines) => {
    const s = await stage();
    transcript(s, ...lines);
    const r = fire(s);
    expect(r.status, r.log).toBe(0);
    expect(r.log).toContain('transcript has an unparseable record');
    expect(s.gone()).toBe(false);
  });

  it('a valid recent human prompt among valid records still counts as a conversation', async () => {
    const s = await stage();
    transcript(s, promptEntry(60 * MIN, 'old'), promptEntry(2 * MIN, 'recent'));
    const r = fire(s);
    expect(r.status, r.log).toBe(0);
    expect(r.log).toMatch(/skip: human conversation/);
  });
});

describe('#4011 C: the whoami worker must be the hook worker', () => {
  it('reads .workerName from whoami --json, case-insensitively against the worktree name (json wins over a differing text line)', async () => {
    const s = await stage();
    knob(s, 'whoami-text', 'Somebody-else (server-engineer)');
    const r = fire(s);
    expect(r.status, r.log).toBe(2);
    expect(readFileSync(s.calls, 'utf8')).toMatch(/team session whoami --json/);
  });

  it.each([
    ['--json fails', 'FAIL'],
    ['--json has no workerName', '{"sessionId":"x"}'],
    ['--json is not JSON', 'garbage'],
  ])('falls back to the text parse when %s', async (_n, body) => {
    const s = await stage();
    knob(s, 'whoami-json', body);
    const r = fire(s);
    expect(r.status, r.log).toBe(2);
  });

  it('no worker name from either form is unreadable, warned once', async () => {
    const s = await stage();
    knob(s, 'whoami-json', 'FAIL');
    knob(s, 'whoami-text', 'FAIL');
    const r = fire(s);
    expect(r.status, r.log).toBe(0);
    expect(r.log).toContain('unreadable (no worker name from whoami)');
    expect(s.gone()).toBe(false);
    fire(s);
    expect(warnings(s)).toHaveLength(1);
  });

  it('a whoami worker that differs from the hook worker is unreadable: exit 0, no kill, warned once, worker get never called', async () => {
    const s = await stage();
    knob(s, 'whoami-json', '{"workerName":"Mallory"}');
    const r = fire(s);
    expect(r.status, r.log).toBe(0);
    expect(r.log).toContain('unreadable (whoami worker differs from hook worker)');
    expect(s.gone()).toBe(false);
    expect(readFileSync(s.calls, 'utf8')).not.toMatch(/team worker get/);
    expect(warnings(s)).toHaveLength(1);
  });

  it('the text fallback gets only the REMAINING whoami budget: --json burns part of it then fails, the text form stalls', async () => {
    const s = await stage();
    knob(s, 'sleep-whoami-json', '1.5'); // --json consumes 1.5 of the 2 s budget, then fails
    knob(s, 'whoami-json', 'FAIL');
    knob(s, 'stamp-text', ''); // the text form stalls and records when it started and when it was told to stop
    const r = fire(s, { scaled: true, env: { WORKER_AUTO_SHED_T_WHOAMI: '2' } });
    expect(r.status, r.log).toBe(0);
    expect(r.log).toContain('skip: human presence unreadable (whoami timed out)');
    const start = Number(readFileSync(join(s.root, 'k', 'text-start'), 'utf8'));
    const end = Number(readFileSync(join(s.root, 'k', 'text-end'), 'utf8'));
    // remaining is about 0.5 s; a fresh full allowance would be 2 s.
    expect(end - start, `the text fallback ran ${(end - start).toFixed(2)} s`).toBeGreaterThan(0.2);
    expect(end - start, `the text fallback ran ${(end - start).toFixed(2)} s: it got a fresh allowance`).toBeLessThan(1.3);
    expect(s.gone()).toBe(false);
  });
});

describe('#4011 D: one shared warning marker across skip reasons (preserved)', () => {
  it('a typing skip then a conversation skip then an unreadable skip within the TTL post exactly one warning', async () => {
    const s = await stage();
    knob(s, 'terminal.json', '{"terminal":{"prompt":"not_empty"}}');
    expect(fire(s).log).toMatch(/skip: human typing/);
    knob(s, 'terminal.json', '{"terminal":{"prompt":"empty"}}');
    transcript(s, promptEntry(1 * MIN, 'ok'));
    expect(fire(s).log).toMatch(/skip: human conversation/);
    knob(s, 'terminal.json', 'FAIL');
    expect(fire(s).log).toMatch(/skip: human presence unreadable/);
    expect(warnings(s)).toHaveLength(1);
  });

  it('a skip after the 6 h TTL posts a second warning', async () => {
    const s = await stage();
    knob(s, 'terminal.json', '{"terminal":{"prompt":"not_empty"}}');
    fire(s);
    expect(warnings(s)).toHaveLength(1);
    const marker = join(stateDir(s), `${NAME}.skip-warned`);
    const old = new Date(Date.now() - 7 * 3600_000);
    utimesSync(marker, old, old);
    expect(statSync(marker).mtimeMs).toBeLessThan(Date.now() - 6 * 3600_000);
    fire(s);
    expect(warnings(s)).toHaveLength(2);
  });
});

describe('#4011 E: gaps', () => {
  it('whoami failing outright skips, warns once, never kills', async () => {
    const s = await stage();
    knob(s, 'whoami-json', 'FAIL');
    knob(s, 'whoami-text', 'EMPTY');
    const r = fire(s);
    expect(r.status, r.log).toBe(0);
    expect(r.log).toContain('no worker name from whoami');
    expect(s.gone()).toBe(false);
    expect(warnings(s)).toHaveLength(1);
  });

  it('a bare <pasted_content> human paste with no hadron marker counts as a human prompt (conversation skip)', async () => {
    const s = await stage();
    transcript(s, promptEntry(1 * MIN, '\n\n<pasted_content id="ab12">\nthe plan, as I wrote it down\n</pasted_content id="ab12">'));
    const r = fire(s);
    expect(r.status, r.log).toBe(0);
    expect(r.log).toMatch(/skip: human conversation/);
    expect(s.gone()).toBe(false);
  });

  it('a failed kill followed by a re-fire in the same episode posts no second warning', async () => {
    const s = await stage();
    knob(s, 'terminal.json', '{"terminal":{"prompt":"not_empty"}}');
    fire(s); // the skip episode: one warning
    expect(warnings(s)).toHaveLength(1);
    knob(s, 'terminal.json', '{"terminal":{"prompt":"empty"}}');
    // The human leaves; the kill cannot be made (no owner proven: a bogus CLAUDE_PID, no claude ancestor).
    const env = { HARNESS_RUN_ID: s.run.runId, PATH: `${s.bin}:${process.env.PATH}`, HOME: s.home, CLAUDE_PID: '' };
    const input = JSON.stringify({ trigger: 'auto', cwd: s.wt, transcript_path: join(s.root, 'transcript.jsonl') });
    const failed = spawnSync('bash', [HOOK], { encoding: 'utf8', input, env });
    expect(failed.status, shedLog(s)).toBe(0);
    expect(shedLog(s)).toMatch(/no claude process found/);
    const again = spawnSync('bash', [HOOK], { encoding: 'utf8', input, env });
    expect(again.status).toBe(0);
    expect(warnings(s), 'the re-fire after a failed kill posted again').toHaveLength(1);
  });
});

/* ------------------------------------------------------------------------------------------------------------------
 * #4160 item 1: ONE absolute deadline shared by every SKIP path (start to exit <= 45 s).
 * Scaled: step budgets stay at SCALED, KILL_GRACE 0.3 s, and WORKER_AUTO_SHED_T_HOOK is lowered (the override may only lower).
 * BASELINE-GREEN controls (B*, N1) characterise main and must pass on it; P*, K* are the preventive pins (red on main).
 * ---------------------------------------------------------------------------------------------------------------- */
const KG = { WORKER_AUTO_SHED_T_KILL_GRACE: '0.3' };
const BOUND_MS = 7000;
const posted = (s: Sb): number => warnings(s).length;
const markerFile = (s: Sb): string => join(stateDir(s), `${NAME}.skip-warned`);
const uptimeFile = (s: Sb): string => join(s.root, 'k', 'uptime');
const setUptime = (s: Sb, body: string): void => writeFileSync(uptimeFile(s), body);
const clockEnv = (s: Sb): Record<string, string> => ({ WORKER_AUTO_SHED_UPTIME_FILE: uptimeFile(s) });

describe('#4160 baseline: what main already does (green on main, characterization only)', () => {
  it('B0 start-up and exit: a manual-compact skip runs start to exit well inside one second of overhead', async () => {
    const s = await stage();
    const r = fire(s, { input: JSON.stringify({ trigger: 'manual', cwd: s.wt }) });
    expect(r.status, r.log).toBe(0);
    expect(r.ms, `start to exit took ${r.ms} ms`).toBeLessThan(1500);
  });

  it('B1 reachable chain: valid stdin, slow-success whoami and terminal, a TERM-ignoring transcript, a TERM-ignoring warning post', async () => {
    const s = await stage();
    knob(s, 'sleep-whoami', '0.36'); knob(s, 'sleep-worker', '0.36'); knob(s, 'ignore-term-jq', ''); knob(s, 'ignore-term-post', '');
    const r = fire(s, { scaled: true, env: KG });
    expect(r.status, r.log).toBe(0);
    expect(r.log).toContain('human presence unreadable (transcript read timed out)');
    expect(s.gone(), 'the chain stopped the agent').toBe(false);
    expect(posted(s), 'exactly one warning attempt').toBe(1);
    expect(existsSync(markerFile(s)), 'a stalled post must not mark the episode warned').toBe(false);
    expect(r.ms, `B1 wall ${r.ms} ms`).toBeLessThan(BOUND_MS);
  });

  it('B2 slow-success transcript, then a conversation skip, then a TERM-ignoring warning post', async () => {
    const s = await stage();
    knob(s, 'sleep-whoami', '0.36'); knob(s, 'sleep-worker', '0.36'); knob(s, 'sleep-jq', '0.5'); knob(s, 'ignore-term-post', '');
    transcript(s, promptEntry(1 * MIN, 'recent'));
    const r = fire(s, { scaled: true, env: KG });
    expect(r.status, r.log).toBe(0);
    expect(r.log).toMatch(/skip: human conversation/);
    expect(s.gone()).toBe(false);
    expect(posted(s)).toBe(1);
    expect(r.ms, `B2 wall ${r.ms} ms`).toBeLessThan(BOUND_MS);
  });

  it.each([
    ['stdin cat', 'ignore-term-cat'],
    ['whoami', 'ignore-term-whoami'],
    ['worker get', 'ignore-term-worker'],
  ])('B3 early failure, separate run: a TERM-ignoring %s is killed after the grace: exit 0, no kill, inside the bound', async (_n, file) => {
    const s = await stage();
    knob(s, file, '');
    if (file === 'ignore-term-cat') {
      // cat only stalls when stdin does: a partial record with the pipe held open (valid stdin lets cat finish and the hook sheds)
      const t0 = Date.now();
      const [cmd, args] = hookCmd();
      const child = spawnOwned(s.run, cmd, args, { PATH: `${s.bin}:${process.env.PATH}`, HOME: s.home, CLAUDE_PID: String(s.pid), ...SCALED_ENV, ...KG });
      child.stdin.write('{"trigger":"auto","cw');
      const status: number = await new Promise((res) => child.on('close', (c) => res(c ?? -1)));
      expect(status, shedLog(s)).toBe(0);
      expect(s.gone()).toBe(false);
      expect(Date.now() - t0, 'B3 wall').toBeLessThan(BOUND_MS);
      return;
    }
    const r = fire(s, { scaled: true, env: KG });
    expect(r.status, r.log).toBe(0);
    expect(s.gone()).toBe(false);
    expect(r.ms, `B3 wall ${r.ms} ms`).toBeLessThan(BOUND_MS);
  });

  it('N1 a slow SHED step is not cut: with T_HOOK far below the claim step, the clear path still commits and stops the agent', async () => {
    const s = await stage();
    knob(s, 'sleep-claim', '4');
    const r = fire(s, { scaled: true, env: { ...KG, WORKER_AUTO_SHED_T_HOOK: '3' } });
    expect(r.status, r.log).toBe(2);
    expect(r.log).toMatch(/stopping claude pid/);
    expect(r.ms, `the shed path was cut: ${r.ms} ms`).toBeGreaterThan(3500);
    expect(r.log).not.toMatch(/guard deadline/);
  });
});

describe('#4160 preventive: the shared guard deadline', () => {
  it('P1 shrunk T_HOOK below the chain: unreadable at the deadline, no kill, one warning, wall <= T_HOOK + C + overhead', async () => {
    const s = await stage();
    knob(s, 'sleep-whoami', '0.2'); knob(s, 'sleep-worker', '0.2'); knob(s, 'ignore-term-jq', ''); knob(s, 'ignore-term-post', '');
    const r = fire(s, { scaled: true, env: { ...KG, WORKER_AUTO_SHED_T_HOOK: '2.4' } });
    expect(r.status, r.log).toBe(0);
    expect(r.log, 'a shared deadline must cut the presence chain').toMatch(/skip: guard deadline before [a-z ]+; unreadable, no kill/);
    expect(s.gone(), 'the deadline skip stopped the agent').toBe(false);
    expect(posted(s), 'exactly ONE warning attempt (no claim it was delivered)').toBe(1);
    expect(r.ms, `P1 wall ${r.ms} ms`).toBeLessThan(2400 + 1000 + 1500);
  });

  it('P2a a warning the deadline leaves no room for is skipped: marker untouched, a log line, and the NEXT fire posts it once', async () => {
    const s = await stage();
    setUptime(s, '1000.00 0.00\n');
    knob(s, 'set-uptime', '1100.00 0.00\n'); // the clock jumps +100 s once whoami has answered: every later guard step and the warning slice are gone
    const r = fire(s, { scaled: true, env: { ...KG, ...clockEnv(s) } });
    expect(r.status, r.log).toBe(0);
    expect(r.log).toMatch(/skip: guard deadline before/);
    expect(r.log).toMatch(/warning skipped: guard deadline/);
    expect(posted(s), 'no post was started').toBe(0);
    expect(existsSync(markerFile(s)), 'the marker must stay untouched').toBe(false);
    expect(s.gone()).toBe(false);
    // The next fire, under no deadline pressure, still unreadable (terminal fails) and posts the warning exactly once.
    rmSync(join(s.root, 'k', 'set-uptime'));
    setUptime(s, '2000.00 0.00\n');
    knob(s, 'terminal.json', 'FAIL');
    const again = fire(s, { scaled: true, env: { ...KG, ...clockEnv(s) } });
    expect(again.status, again.log).toBe(0);
    expect(posted(s)).toBe(1);
    expect(existsSync(markerFile(s))).toBe(true);
    fire(s, { scaled: true, env: { ...KG, ...clockEnv(s) } });
    expect(posted(s), 'the episode posts once').toBe(1);
  });

  it('P2b a warning that starts and is cut off: marker untouched, "will retry" logged, the next fire posts once', async () => {
    const s = await stage();
    knob(s, 'terminal.json', '{"terminal":{"prompt":"not_empty"}}');
    knob(s, 'ignore-term-post', '');
    const r = fire(s, { scaled: true, env: KG });
    expect(r.status, r.log).toBe(0);
    expect(r.log).toMatch(/warning post FAILED \(typing\); will retry/);
    expect(existsSync(markerFile(s))).toBe(false);
    expect(posted(s)).toBe(1);
    rmSync(join(s.root, 'k', 'ignore-term-post'));
    fire(s, { scaled: true, env: KG });
    expect(posted(s), 'one failed attempt plus the retry').toBe(2);
    expect(existsSync(markerFile(s))).toBe(true);
    fire(s, { scaled: true, env: KG });
    expect(posted(s), 'a delivered warning ends the episode').toBe(2);
  });

  it('P3 the T_HOOK override may only LOWER the 44 s deadline: 1000 is clamped and logged', async () => {
    const s = await stage();
    const r = fire(s, { scaled: true, env: { ...KG, WORKER_AUTO_SHED_T_HOOK: '1000' } });
    expect(r.status, r.log).toBe(2);
    expect(r.log).toContain('guard: T_HOOK clamped to 44');
  });

  it('K1 a BACKWARD clock step cannot extend the deadline: elapsed never decreases', async () => {
    const s = await stage();
    setUptime(s, '1000.00 0.00\n');
    knob(s, 'set-uptime', '1000.30 0.00\n'); knob(s, 'set-uptime2', '900.00 0.00\n'); // +0.3 s once whoami answers (read by the hook), then 100 s BACKWARD during the whoami parse
    const r = fire(s, { scaled: true, env: { ...KG, ...clockEnv(s), WORKER_AUTO_SHED_T_HOOK: '2.4' } });
    expect(r.status, r.log).toBe(0);
    expect(r.log, 'with a decreasing clock the worker-get step would have run').toMatch(/skip: guard deadline before worker get/);
    expect(readFileSync(s.calls, 'utf8')).not.toMatch(/team worker get/);
    expect(s.gone()).toBe(false);
    expect(r.ms).toBeLessThan(BOUND_MS);
  });

  it('K2 a FORWARD jump past the deadline skips the remaining guard steps: exit 0, no kill, at most one warning attempt', async () => {
    const s = await stage();
    setUptime(s, '1000.00 0.00\n');
    knob(s, 'set-uptime', '1100.00 0.00\n');
    const r = fire(s, { scaled: true, env: { ...KG, ...clockEnv(s) } });
    expect(r.status, r.log).toBe(0);
    expect(r.log).toMatch(/guard deadline/);
    expect(readFileSync(s.calls, 'utf8')).not.toMatch(/team worker get/);
    expect(posted(s)).toBeLessThanOrEqual(1);
    expect(s.gone()).toBe(false);
  });

  it('K3a an unreadable clock BEFORE identity is established: logged only, exit 0, no kill, no clear/shed, no hadron call', async () => {
    const s = await stage();
    setUptime(s, 'garbage\n');
    const r = fire(s, { scaled: true, env: { ...KG, ...clockEnv(s) } });
    expect(r.status, r.log).toBe(0);
    expect(r.log).toContain('skip: guard clock unreadable; unreadable, no kill');
    expect(s.gone(), 'an unreadable clock stopped the agent').toBe(false);
    expect(existsSync(s.calls), 'nothing may proceed toward the shed path').toBe(false);
    expect(existsSync(join(stateDir(s), `${NAME}.last-auto-shed`)) || existsSync(join(stateDir(s), `${NAME}.prompt`))).toBe(false);
  });

  it('K3b an unreadable clock AFTER identity: exit 0, no kill, no shed, one bounded warning attempt (marker only on success)', async () => {
    const s = await stage();
    setUptime(s, '1000.00 0.00\n');
    knob(s, 'set-uptime', '\n'); // empty after whoami answered
    const r = fire(s, { scaled: true, env: { ...KG, ...clockEnv(s) } });
    expect(r.status, r.log).toBe(0);
    expect(r.log).toMatch(/guard clock unreadable/);
    expect(s.gone()).toBe(false);
    expect(readFileSync(s.calls, 'utf8')).not.toMatch(/team worker get/);
    expect(posted(s)).toBe(1);
    expect(existsSync(join(stateDir(s), `${NAME}.prompt`)), 'a prompt was written: the shed path ran').toBe(false);
  });

  it('K4 a stalled log append is dropped after 0.5 s and cannot hold the hook (exit inside C)', async () => {
    const s = await stage();
    mkdirSync(stateDir(s), { recursive: true });
    spawnSync('mkfifo', [join(stateDir(s), 'auto-shed.log')]); // opening it for append blocks with no reader
    const r = fire(s, { scaled: true, env: KG, deadlineS: 6, input: JSON.stringify({ trigger: 'manual', cwd: s.wt }) });
    expect(r.status, 'the hook hung on a blocked log').toBe(0);
    expect(r.ms, `K4 wall ${r.ms} ms`).toBeLessThan(3500);
  });
});

/* ------------------------------------------------------------------------------------------------------------------
 * #4160 item 2: the containment helper's own pins (real processes C1-C6d, mocked /proc C7-C12).
 * ---------------------------------------------------------------------------------------------------------------- */
const NESTED_STUB = `#!/bin/bash
timeout 600 sh -c "trap '' TERM; sleep 600" &
wait
`;
const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 3000): Promise<boolean> { const t = Date.now(); while (Date.now() - t < ms) { if (pred()) return true; await sleepMs(25); } return pred(); }
function stubFile(body: string): string {
  const d = mkdtempSync(join(tmpdir(), 'containment-4160-')); roots.push(d);
  const f = join(d, 'stub.sh'); writeFileSync(f, body); chmodSync(f, 0o755);
  return f;
}
const ownedRun = (): OwnedRun => newOwnedRun(join(mkdtempSync(join(tmpdir(), 'containment-wd-')), 'wd.log'));

describe('#4160 item 2: owned-descendant containment (real processes)', () => {
  it('C1 a nested-group, TERM-ignoring descendant survives the OLD group kill and does not survive the owned cleanup', async () => {
    const run = ownedRun();
    const child = spawnOwned(run, 'bash', [stubFile(NESTED_STUB)], process.env);
    expect(await until(() => ownedProcesses(run).length >= 3), 'stub never started').toBe(true);
    process.kill(-child.pid!, 'SIGKILL'); // what the old afterEach did
    await sleepMs(150);
    expect(ownedProcesses(run).length, 'premise: the nested group survives a group kill').toBeGreaterThanOrEqual(1);
    const res = await cleanupOwned(run);
    assertNoSurvivors(res);
    expect(ownedProcesses(run)).toEqual([]);
  });

  it('C2 normal completion: zero owned survivors', async () => {
    const run = ownedRun();
    const child = spawnOwned(run, 'bash', ['-c', 'sleep 0.1; exit 0'], process.env);
    await new Promise((r) => child.on('close', r));
    assertNoSurvivors(await cleanupOwned(run));
    expect(ownedProcesses(run)).toEqual([]);
  });

  it('C3 an early assertion failure inside the test body still cleans up (the afterEach path)', async () => {
    const run = ownedRun();
    spawnOwned(run, 'bash', [stubFile(NESTED_STUB)], process.env);
    await until(() => ownedProcesses(run).length >= 3);
    try { expect(1, 'a deliberate early failure').toBe(2); } catch { /* the body threw; cleanup still runs */ }
    assertNoSurvivors(await cleanupOwned(run));
    expect(ownedProcesses(run)).toEqual([]);
  });

  it('C4 a descendant forking new owned children DURING the sweep is caught by the confirming pass', async () => {
    const run = ownedRun();
    const forker = `#!/bin/bash
setsid bash -c 'for i in $(seq 60); do (trap "" TERM; exec sleep 600) & sleep 0.02; done' &
wait
`;
    spawnOwned(run, 'bash', [stubFile(forker)], process.env);
    await until(() => ownedProcesses(run).length >= 4);
    const res = await cleanupOwned(run);
    assertNoSurvivors(res);
    expect(res.passes, 'a clean result needs two consecutive empty passes').toBeGreaterThanOrEqual(2);
    expect(ownedProcesses(run)).toEqual([]);
  });

  it('C5 ownership: a same-uid process WITHOUT the run id survives cleanup', async () => {
    const run = ownedRun();
    const decoy = spawn('sleep', ['600'], { stdio: 'ignore', detached: true, env: { PATH: process.env.PATH } });
    try {
      spawnOwned(run, 'bash', ['-c', 'sleep 600 & wait'], process.env);
      await until(() => ownedProcesses(run).length >= 2);
      assertNoSurvivors(await cleanupOwned(run));
      expect(() => process.kill(decoy.pid!, 0), 'the decoy was killed by command name or uid').not.toThrow();
    } finally { decoy.kill('SIGKILL'); }
  });

  /** A decoy plus an owned nested stub; `watchPid` is what the watchdog treats as vitest. */
  async function watchdogScenario(watchPid: number, watchStart: string, waitS: number): Promise<{ run: OwnedRun; decoy: ReturnType<typeof spawn>; log: string }> {
    const run = ownedRun();
    const wdLog = join(mkdtempSync(join(tmpdir(), 'containment-wdlog-')), 'wd.log'); roots.push(wdLog.replace(/\/wd\.log$/, ''));
    spawnOwned(run, 'bash', [stubFile(NESTED_STUB)], process.env);
    await until(() => ownedProcesses(run).length >= 3);
    const decoy = spawn('sleep', ['600'], { stdio: 'ignore', detached: true, env: { PATH: process.env.PATH } });
    // The run's own watchdog is replaced by the one under test; the run's cleanup never ran, as if vitest had died.
    if (run.watchdog) { process.kill(run.watchdog.pid, 'SIGKILL'); run.watchdog = null; }
    run.launcher = null; run.child = null;
    startWatchdog(run.runId, watchPid, watchStart, waitS, wdLog);
    return { run, decoy, log: wdLog };
  }

  it('C6b harness death: the watchdog sweeps a nested TERM-ignoring group within the poll plus the sweep, the decoy lives', async () => {
    const harness = spawn('sleep', ['600'], { stdio: 'ignore', detached: true });
    const hst = parseStat(readFileSync(`/proc/${harness.pid}/stat`, 'latin1'))!;
    const { run, decoy } = await watchdogScenario(harness.pid!, hst.start, 60);
    try {
      expect(ownedProcesses(run).length).toBeGreaterThanOrEqual(1);
      harness.kill('SIGKILL'); // no afterEach will ever run for it
      expect(await until(() => ownedProcesses(run).length === 0, 4000), 'the watchdog left owned survivors').toBe(true);
      expect(() => process.kill(decoy.pid!, 0)).not.toThrow();
    } finally { decoy.kill('SIGKILL'); harness.kill('SIGKILL'); }
  });

  it('C6c harness hung (alive): the watchdog fires at its deadline and sweeps', async () => {
    const harness = spawn('sleep', ['600'], { stdio: 'ignore', detached: true });
    const hst = parseStat(readFileSync(`/proc/${harness.pid}/stat`, 'latin1'))!;
    const { run, decoy } = await watchdogScenario(harness.pid!, hst.start, 1);
    try {
      expect(ownedProcesses(run).length).toBeGreaterThanOrEqual(1);
      expect(await until(() => ownedProcesses(run).length === 0, 5000), 'the watchdog did not fire at its deadline').toBe(true);
      expect(() => process.kill(decoy.pid!, 0)).not.toThrow();
    } finally { decoy.kill('SIGKILL'); harness.kill('SIGKILL'); }
  });

  it('C6d a reused harness pid (alive, different start-time) counts as dead; the watchdog kills nothing without the run id', async () => {
    const other = spawn('sleep', ['600'], { stdio: 'ignore', detached: true });
    const { run, decoy } = await watchdogScenario(other.pid!, '1', 60);
    try {
      expect(await until(() => ownedProcesses(run).length === 0, 4000)).toBe(true);
      expect(() => process.kill(decoy.pid!, 0), 'the decoy died').not.toThrow();
      expect(() => process.kill(other.pid!, 0), 'the reused pid died').not.toThrow();
    } finally { decoy.kill('SIGKILL'); other.kill('SIGKILL'); }
  });
});

interface MockProc { stat: ProcStat; uid: number; environ: () => ProcRead<string> }
function mockOps(procs: Map<number, MockProc>, calls: Array<[number, string]>, opts: { killRemoves?: boolean } = {}): ProcOps {
  return {
    list: () => [...procs.keys()],
    stat: (pid) => procs.get(pid)?.stat ?? 'gone',
    uid: (pid) => procs.get(pid)?.uid ?? 'gone',
    environ: (pid) => procs.get(pid)?.environ() ?? 'gone',
    kill: (target, sig) => { calls.push([target, sig]); if (opts.killRemoves !== false && target > 0 && sig === 'SIGKILL') procs.delete(target); },
  };
}
const mockRun = (over: Partial<OwnedRun> = {}): OwnedRun => ({ runId: 'rid-1', uid: 1000, protectedPids: new Set([1]), launcher: null, child: null, watchdog: null, watchdogLog: null, ...over });
const st = (over: Partial<ProcStat> = {}): ProcStat => ({ state: 'S', ppid: 1, pgrp: 500, sid: 500, start: 'A', ...over });
const owned = (rid = 'rid-1') => (): ProcRead<string> => `PATH=/bin\0HARNESS_RUN_ID=${rid}\0`;

describe('#4160 item 2: signal identity and unverifiable evidence (mocked /proc)', () => {
  it('parseStat reads fields from AFTER the last ")": a comm with spaces and parentheses cannot shift them', () => {
    const rest = 'S 7 500 500 0 -1 4194560 100 0 0 0 0 0 0 0 20 0 1 0 987654 1000 100 0 0 0 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0';
    expect(parseStat(`1234 (we ird) (name) ${rest}`)).toEqual({ state: 'S', ppid: 7, pgrp: 500, sid: 500, start: '987654' });
  });

  it('C7 a recycled pid (stale start-time) is never signaled', () => {
    const calls: Array<[number, string]> = [];
    const ops = mockOps(new Map([[600, { stat: st({ start: 'Y' }), uid: 1000, environ: owned() }]]), calls);
    expect(signalOwned(mockRun(), 600, 'SIGKILL', 'X', ops)).toBe('mismatch');
    expect(calls).toEqual([]);
    expect(signalOwned(mockRun(), 600, 'SIGKILL', 'Y', ops)).toBe('signaled');
  });

  it('C10 the group kill needs identity: a launcher record whose pid now belongs to a process without the run id sends zero kill(-pgid)', async () => {
    const calls: Array<[number, string]> = [];
    const procs = new Map([[500, { stat: st({ start: 'A' }), uid: 1000, environ: (): ProcRead<string> => 'PATH=/bin\0' }]]);
    const run = mockRun({ launcher: { pid: 500, start: 'B', sid: 500, pgid: 500 }, child: { exitCode: null, signalCode: null } });
    const res = await cleanupOwned(run, { ops: mockOps(procs, calls), gapMs: 1 });
    expect(res.groupKills).toBe(0);
    expect(calls.filter(([t]) => t < 0)).toEqual([]);
    expect(calls, 'a process without the run id was signaled').toEqual([]);
  });

  it('C11 an empty group (the launcher exited, no verified member) sends no group signal', async () => {
    const calls: Array<[number, string]> = [];
    const run = mockRun({ launcher: { pid: 500, start: 'A', sid: 500, pgid: 500 }, child: { exitCode: 0, signalCode: null } });
    const res = await cleanupOwned(run, { ops: mockOps(new Map(), calls), gapMs: 1 });
    expect(res.groupKills).toBe(0);
    expect(calls).toEqual([]);
    assertNoSurvivors(res);
  });

  it('C8/C12 evidence that becomes unreadable for a pid already seen as owned is UNVERIFIABLE: the helper fails with the limitation, never passes', async () => {
    const calls: Array<[number, string]> = [];
    let reads = 0;
    // Pass 1 proves it owned and the kill does nothing (mocked); from pass 2 its environ is unreadable.
    const procs = new Map([[700, { stat: st({ pgrp: 700, sid: 700, start: 'P' }), uid: 1000, environ: (): ProcRead<string> => (reads++ < 2 ? owned()() : 'unreadable') }]]);
    const res = await cleanupOwned(mockRun(), { ops: mockOps(procs, calls, { killRemoves: false }), gapMs: 1 });
    expect(res.unverifiable).toBeGreaterThan(0);
    expect(res.clean).toBe(false);
    expect(() => assertNoSurvivors(res)).toThrow(/limitation: \d+ process\(es\) could not be verified/);
    expect(calls.filter(([t, sig]) => t === 700 && sig === 'SIGKILL').length, 'an unverifiable pid was signaled after it became unreadable').toBeLessThanOrEqual(2);
  });

  it('C9 the cleanup cap with a survivor the (mocked) kill cannot remove FAILS, never passes', async () => {
    const calls: Array<[number, string]> = [];
    const procs = new Map([[800, { stat: st({ pgrp: 800, sid: 800, start: 'Q' }), uid: 1000, environ: owned() }]]);
    const res = await cleanupOwned(mockRun(), { ops: mockOps(procs, calls, { killRemoves: false }), gapMs: 1, maxPasses: 6 });
    expect(res.clean).toBe(false);
    expect(res.owned).toBe(1);
    expect(() => assertNoSurvivors(res)).toThrow(/1 owned survivor/);
  });

  it('a clean result needs TWO consecutive empty passes', async () => {
    const res = await cleanupOwned(mockRun(), { ops: mockOps(new Map(), []), gapMs: 1 });
    expect(res).toMatchObject({ clean: true, passes: 2, owned: 0, unverifiable: 0 });
  });
});
