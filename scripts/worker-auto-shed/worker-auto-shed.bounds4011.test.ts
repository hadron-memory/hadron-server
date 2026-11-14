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

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'worker-auto-shed');
const NAME = 'demo-wt';
const MIN = 60_000;
const REAL_JQ = spawnSync('sh', ['-c', 'command -v jq'], { encoding: 'utf8' }).stdout.trim();

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

const roots: string[] = [];
const agents: Array<{ pid: number; supervisor: ReturnType<typeof spawn> }> = [];
afterEach(() => {
  for (const a of agents.splice(0)) { try { process.kill(a.pid, 'SIGKILL'); } catch { /* gone */ } a.supervisor.kill('SIGKILL'); }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

interface Sb { root: string; home: string; bin: string; calls: string; wt: string; pid: number; gone: () => boolean }

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
    b=$(cat "${k}/whoami-json" 2>/dev/null || echo '{"workerName":"Demo-wt"}')
    [ "$b" = FAIL ] && exit 1
    echo "$b" ;;
  "team session whoami"*)
    nap sleep-whoami
    b=$(cat "${k}/whoami-text" 2>/dev/null || echo 'Demo-wt (server-engineer)')
    [ "$b" = FAIL ] && exit 1
    [ "$b" = EMPTY ] && exit 0
    echo "$b" ;;
  "team worker get"*)
    nap sleep-worker
    t="${k}/terminal.json"
    if [ -f "$t" ] && [ "$(cat "$t")" = FAIL ]; then exit 1; fi
    if [ -f "$t" ]; then cat "$t"; else echo '{"terminal":{"prompt":"empty"}}'; fi ;;
  "team chat post"*)
    nap sleep-post
    [ -f "${k}/post-fail" ] && exit 1
    exit 0 ;;
esac
exit 0
`);
  chmodSync(join(bin, 'hadron'), 0o755);
  // A jq that can be made slow for the transcript filter only (the one with -R), so a "huge transcript" is deterministic.
  writeFileSync(join(bin, 'jq'), `#!/bin/bash
case "$*" in *-R*) [ -f "${k}/sleep-jq" ] && sleep "$(cat "${k}/sleep-jq")" ;; esac
exec "${REAL_JQ}" "$@"
`);
  chmodSync(join(bin, 'jq'), 0o755);
  const wt = join(root, NAME); mkdirSync(wt);
  writeFileSync(join(root, 'transcript.jsonl'), promptEntry(60 * MIN, 'an old question') + '\n');
  // The stand-in agent, under a worker-supervise parent (the supervision guard of the hook).
  const pidFile = join(root, 'agent.pid');
  const supervisor = spawn('bash', ['-c', `(exec -a claude bash -c "trap 'exit 0' TERM; while :; do sleep 0.1; done") & echo $! > "${pidFile}"; wait`, 'worker-supervise'], { stdio: 'ignore' });
  for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50));
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  for (let i = 0; i < 100; i++) {
    try { if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')[0] === 'claude') break; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  agents.push({ pid, supervisor });
  const gone = (): boolean => { try { process.kill(pid, 0); return false; } catch { return true; } };
  return { root, home, bin, calls, wt, pid, gone };
}

function promptEntry(agoMs: number, content: unknown, kind = 'human'): string {
  return JSON.stringify({ type: 'user', origin: { kind }, promptSource: 'typed', timestamp: new Date(Date.now() - agoMs).toISOString(), message: { role: 'user', content } });
}
const knob = (s: Sb, file: string, body: string): void => writeFileSync(join(s.root, 'k', file), body);
const transcript = (s: Sb, ...lines: string[]): void => writeFileSync(join(s.root, 'transcript.jsonl'), lines.join('\n') + '\n');
const stateDir = (s: Sb): string => join(s.home, '.local', 'state', 'hadron-worker-shed');
const shedLog = (s: Sb): string => (existsSync(join(stateDir(s), 'auto-shed.log')) ? readFileSync(join(stateDir(s), 'auto-shed.log'), 'utf8') : '');
const warnings = (s: Sb): string[] => (existsSync(s.calls) ? readFileSync(s.calls, 'utf8') : '').split('\n').filter((l) => l.startsWith('team chat post'));

/** One PreCompact(auto) fire; `scaled` runs it under the scaled-down budgets, otherwise the defaults apply. */
function fire(s: Sb, opts: { scaled?: boolean; input?: string } = {}): { status: number | null; log: string; ms: number } {
  const env: Record<string, string> = { PATH: `${s.bin}:${process.env.PATH}`, HOME: s.home, CLAUDE_PID: String(s.pid), ...(opts.scaled ? SCALED_ENV : {}) };
  const t0 = Date.now();
  const r = spawnSync('bash', [HOOK], { encoding: 'utf8', input: opts.input ?? JSON.stringify({ trigger: 'auto', cwd: s.wt, transcript_path: join(s.root, 'transcript.jsonl') }), env });
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
    const child = spawn('bash', [HOOK], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: `${s.bin}:${process.env.PATH}`, HOME: s.home, CLAUDE_PID: String(s.pid), ...SCALED_ENV } });
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

  it('an invalid or zero override falls back to the default instead of disabling the bound', async () => {
    const s = await stage();
    knob(s, 'sleep-whoami', '7');
    const env = { PATH: `${s.bin}:${process.env.PATH}`, HOME: s.home, CLAUDE_PID: String(s.pid), WORKER_AUTO_SHED_T_WHOAMI: '0', WORKER_AUTO_SHED_T_WORKER: 'abc' };
    const r = spawnSync('bash', [HOOK], { encoding: 'utf8', input: JSON.stringify({ trigger: 'auto', cwd: s.wt, transcript_path: join(s.root, 'transcript.jsonl') }), env });
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

  it('the text fallback shares the whoami budget: a slow --json that then fails cannot be followed by a second full allowance', async () => {
    const s = await stage();
    knob(s, 'sleep-whoami', '5'); // both forms are slow
    const r = fire(s, { scaled: true });
    expect(r.log).toContain('whoami timed out');
    expect(r.ms, `took ${r.ms} ms: the fallback got its own allowance`).toBeLessThan((SCALED.whoami * 1000) + 1500 + (SCALED.warn * 1000) + 1500);
    const calls = readFileSync(s.calls, 'utf8').split('\n').filter((l) => l.startsWith('team session whoami'));
    expect(calls.length, 'the text fallback must not start after the budget is spent').toBeLessThanOrEqual(1);
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
    const env = { PATH: `${s.bin}:${process.env.PATH}`, HOME: s.home, CLAUDE_PID: '' };
    const input = JSON.stringify({ trigger: 'auto', cwd: s.wt, transcript_path: join(s.root, 'transcript.jsonl') });
    const failed = spawnSync('bash', [HOOK], { encoding: 'utf8', input, env });
    expect(failed.status, shedLog(s)).toBe(0);
    expect(shedLog(s)).toMatch(/no claude process found/);
    const again = spawnSync('bash', [HOOK], { encoding: 'utf8', input, env });
    expect(again.status).toBe(0);
    expect(warnings(s), 'the re-fire after a failed kill posted again').toHaveLength(1);
  });
});
