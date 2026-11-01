import { readFileSync as readCutSource3082 } from 'node:fs';
/**
 * #1958 residual: the recovery prompt the PreCompact hook `worker-auto-shed` writes.
 *
 * The candidate hook lives in this directory; `testdata/worker-auto-shed.old` is the
 * hook that was installed on orca1 before the fix (sha256-12 4cd9664c741a), kept so the
 * tests can PROVE the old emitted ladder fails the requirements ("red pins").
 *
 *  - `--print-prompt <name>` must be side-effect-free: no state dir, no log, no claim
 *    (`hadron` is never called), no snapshot, no prompt file, no stdin read, no signal.
 *  - The emitted prompt must hold every branch of the ladder (bound-open, unbound
 *    redemption, CHOOSE asks the human, exit 5 two meanings, transport error is not
 *    NOTHING_TO_RESUME, MCP branch, never --as, never a post as the human).
 *  - The old hook's actually-emitted prompt (captured by running it in dry-run mode in a
 *    sandbox) fails those requirements.
 *  - The hook's normal mode writes exactly what `--print-prompt` prints.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const NEW_HOOK = join(here, 'worker-auto-shed');
const OLD_HOOK = join(here, 'testdata', 'worker-auto-shed.old');
const NAME = 'demo-wt';

const dirs: string[] = [];
function sandbox(): { root: string; home: string; bin: string; calls: string } {
  const root = mkdtempSync(join(tmpdir(), 'auto-shed-'));
  dirs.push(root);
  const home = join(root, 'home'); mkdirSync(home);
  const bin = join(root, 'bin'); mkdirSync(bin);
  const calls = join(root, 'hadron-calls.log');
  // A `hadron` that records every call: print mode must never reach it.
  writeFileSync(join(bin, 'hadron'), `#!/bin/sh\necho "$@" >> "${calls}"\nexit 0\n`);
  chmodSync(join(bin, 'hadron'), 0o755);
  return { root, home, bin, calls };
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function listAll(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    out.push(p);
    if (e.isDirectory()) out.push(...listAll(p));
  }
  return out;
}

function printPrompt(): string {
  const s = sandbox();
  const r = spawnSync('bash', [NEW_HOOK, '--print-prompt', NAME], {
    encoding: 'utf8', input: '', env: { PATH: `${s.bin}:${process.env.PATH}`, HOME: s.home },
  });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
}

/** Run a hook in its real (non-print) mode in dry-run, capturing the prompt it writes before dry-run removes it. */
function emittedByHook(hook: string): string {
  const s = sandbox();
  const wt = join(s.root, NAME); mkdirSync(wt);
  const captured = join(s.root, 'captured.prompt');
  // The dry run writes the prompt and then `rm -f`s it. Intercept that rm to keep a copy.
  writeFileSync(join(s.bin, 'rm'), `#!/bin/sh\nfor a in "$@"; do case "$a" in *.prompt) cp "$a" "${captured}" 2>/dev/null;; esac; done\nexec /bin/rm "$@"\n`);
  chmodSync(join(s.bin, 'rm'), 0o755);
  const r = spawnSync('bash', [hook], {
    encoding: 'utf8',
    input: JSON.stringify({ trigger: 'auto', cwd: wt, transcript_path: '' }),
    env: { PATH: `${s.bin}:${process.env.PATH}`, HOME: s.home, WORKER_AUTO_SHED_DRY: '1' },
  });
  expect(r.status, r.stderr).toBe(0);
  expect(existsSync(captured), 'the hook never wrote a prompt').toBe(true);
  return readFileSync(captured, 'utf8');
}

/** Each requirement is a name + a predicate on the emitted prompt. */
const REQUIREMENTS: Array<[string, (p: string) => boolean]> = [
  ['leads with whoami --check and keeps a bound-open binding (no rebind)', (p) => /whoami --check/.test(p) && /do NOT\s+start or rebind a session/.test(p)],
  ['unbound recovery is `session start` with NO --as', (p) => /session start\\?`? with NO --as/.test(p.replace(/\\`/g, '`'))],
  ['MCP-only binding is unsupported; recovery uses CLI', (p) => !p.includes('hadron_resume_session') && p.includes('MCP-only worker binding is unsupported')],
  ['CHOOSE (exit 2) asks the human and never selects automatically', (p) => /CHOOSE[\s\S]{0,160}ask the human/.test(p) && /Never select automatically/.test(p)],
  ['exit 5 has two meanings: still bound OR RESUME_REFUSED', (p) => /RESUME_REFUSED/.test(p) && /still bound/.test(p)],
  ['a transport error is not NOTHING_TO_RESUME', (p) => /transport[\s\S]{0,80}NOT an absent claim/.test(p)],
  ['never posts or records anything as the human', (p) => /never posts or records anything as the human/.test(p)],
];

describe('worker-auto-shed --print-prompt is side-effect-free (#1958)', () => {
  it('prints the prompt, exits 0, and leaves NOTHING behind (no files, no hadron call)', () => {
    const s = sandbox();
    const before = listAll(s.root).sort();
    const r = spawnSync('bash', [NEW_HOOK, '--print-prompt', NAME], {
      encoding: 'utf8', input: '', env: { PATH: `${s.bin}:${process.env.PATH}`, HOME: s.home },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('AUTOMATIC SHED');
    expect(listAll(s.root).sort(), 'print mode created files').toEqual(before);
    expect(existsSync(s.calls), 'print mode called hadron (a claim / session mutation)').toBe(false);
    expect(existsSync(join(s.home, '.local', 'state')), 'print mode created the state dir').toBe(false);
  });

  it('does not read stdin (returns immediately with a held-open pipe) and does not touch CLAUDE_PID', async () => {
    const s = sandbox();
    const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      const start = Date.now();
      const child = spawn('bash', [NEW_HOOK, '--print-prompt', NAME], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { PATH: `${s.bin}:${process.env.PATH}`, HOME: s.home, CLAUDE_PID: String(sleeper.pid) },
      });
      // stdin stays OPEN and silent: hook mode would block ~10 s on `timeout 10 cat`.
      const status: number = await new Promise((res) => child.on('close', (c) => res(c ?? -1)));
      expect(status).toBe(0);
      expect(Date.now() - start, 'print mode waited on stdin').toBeLessThan(5000);
      expect(() => process.kill(sleeper.pid!, 0), 'print mode signalled CLAUDE_PID').not.toThrow();
    } finally { sleeper.kill('SIGKILL'); }
  });

  it('refuses a missing name without side effects', () => {
    const s = sandbox();
    const r = spawnSync('bash', [NEW_HOOK, '--print-prompt'], { encoding: 'utf8', input: '', env: { PATH: `${s.bin}:${process.env.PATH}`, HOME: s.home } });
    expect(r.status).toBe(2);
    expect(listAll(s.home)).toEqual([]);
  });
});

describe('the emitted recovery ladder (#1958)', () => {
  it('the candidate prompt satisfies every requirement', () => {
    const p = printPrompt();
    for (const [name, ok] of REQUIREMENTS) expect(ok(p), name).toBe(true);
  });

  it('the hook in its real mode writes exactly what --print-prompt prints', () => {
    const real = emittedByHook(NEW_HOOK);
    const printed = (() => {
      // the real run's state dir text differs by sandbox path; compare after normalising it
      const norm = (t: string) => t.replace(/\S*\/\.local\/state\/hadron-worker-shed\//g, '<STATE>/');
      return norm(printPrompt()) === norm(real);
    })();
    expect(printed).toBe(true);
  });

  // RED PINS: the hook that was installed before the fix, actually run, emits a prompt that
  // fails each requirement the candidate meets.
  describe('red pins: the OLD installed hook\'s emitted ladder fails', () => {
    const oldPrompt = () => emittedByHook(OLD_HOOK);
    const mustFailOnOld = [
      'CHOOSE (exit 2) asks the human and never selects automatically',
      'exit 5 has two meanings: still bound OR RESUME_REFUSED',
      'a transport error is not NOTHING_TO_RESUME',
      'MCP-only binding is unsupported; recovery uses CLI',
      'never posts or records anything as the human',
    ];
    for (const name of mustFailOnOld) {
      it(`old prompt fails: ${name}`, () => {
        const req = REQUIREMENTS.find(([n]) => n === name)!;
        expect(req[1](oldPrompt()), `the old prompt unexpectedly satisfies "${name}"`).toBe(false);
      });
    }
    it('old prompt still has the branches that were already right (whoami first, unbound = start with no --as)', () => {
      const p = oldPrompt();
      expect(p).toMatch(/whoami --check/);
      expect(p.replace(/\\`/g, '`')).toMatch(/session start` with NO --as/);
      expect(p).toMatch(/must NOT start or rebind any session/);
    });
  });
});

/**
 * #2163 part 1: after a confirmed stop the hook BLOCKS compaction (exit 2), and inside the
 * 10-minute cooldown it blocks only while the process it stopped is still exiting. Hugo's
 * four sandbox cases from the live fix (sha256-12 923b3a0e792b), plus the CLAUDE_PID clause.
 *
 * The agent is a stand-in: a process whose argv0 is `claude`, a child of a process whose
 * cmdline names `worker-supervise` (the supervision guard), that takes DIE_MS to exit on TERM.
 * `testdata/worker-auto-shed.pre2163` is the hook installed on orca1 before the fix
 * (sha256-12 e2d63d2beded), kept for the red pins.
 */
const PRE2163_HOOK = join(here, 'testdata', 'worker-auto-shed.pre2163');
const DIE_MS = 4000;

interface Agent { pid: number; supervisor: ReturnType<typeof spawn>; gone: () => boolean }

/**
 * Start a supervised stand-in agent and wait until its pid is known. `onTerm` is shell run first
 * when it is stopped, as its own child (a PreCompact fire from the dying agent itself).
 */
async function startAgent(root: string, tag = 'agent', onTerm = ''): Promise<Agent> {
  const pidFile = join(root, `${tag}.pid`);
  const inner = `trap '${onTerm}sleep ${DIE_MS / 1000}; exit 0' TERM; while :; do sleep 0.1; done`;
  const supervisor = spawn('bash', ['-c', `(exec -a claude bash -c "${inner}") & echo $! > "${pidFile}"; wait`, 'worker-supervise'], { stdio: 'ignore' });
  for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50));
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  // Wait until the exec has happened: the stand-in's argv0 must read `claude`.
  for (let i = 0; i < 100; i++) {
    try { if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')[0] === 'claude') break; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  const gone = (): boolean => { try { process.kill(pid, 0); return false; } catch { return true; } };
  return { pid, supervisor, gone };
}

/** One PreCompact(auto) fire of `hook` for the worktree, as the agent `claudePid`. */
function fire(hook: string, s: ReturnType<typeof sandbox>, wt: string, claudePid?: number | ''): { status: number | null; log: string } {
  const env: Record<string, string> = { PATH: `${s.bin}:${process.env.PATH}`, HOME: s.home };
  if (claudePid !== undefined) env.CLAUDE_PID = String(claudePid);
  const r = spawnSync('bash', [hook], { encoding: 'utf8', input: fireInput(wt), env });
  return { status: r.status, log: shedLog(s) };
}
const fireInput = (wt: string): string => JSON.stringify({ trigger: 'auto', cwd: wt, transcript_path: '' });
function shedLog(s: ReturnType<typeof sandbox>): string {
  const logPath = join(s.home, '.local', 'state', 'hadron-worker-shed', 'auto-shed.log');
  return existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
}

describe('#2163 part 1: a stopped agent cannot compact on the way out', () => {
  const agents: Agent[] = [];
  afterEach(() => { for (const a of agents.splice(0)) { try { process.kill(a.pid, 'SIGKILL'); } catch { /* gone */ } a.supervisor.kill('SIGKILL'); } });

  async function stage(): Promise<{ s: ReturnType<typeof sandbox>; wt: string; agent: Agent }> {
    const s = sandbox();
    const wt = join(s.root, NAME); mkdirSync(wt);
    const agent = await startAgent(s.root);
    agents.push(agent);
    return { s, wt, agent };
  }

  it('case 1: the first fire stops the agent and blocks (exit 2)', async () => {
    const { s, wt, agent } = await stage();
    const r = fire(NEW_HOOK, s, wt, agent.pid);
    expect(r.status, r.log).toBe(2);
    expect(r.log).toMatch(/stopping claude pid \d+ \(cmdline-verified, supervised\)/);
  });

  it('case 2: a second fire while the stopped agent is still exiting blocks (exit 2)', async () => {
    const { s, wt, agent } = await stage();
    expect(fire(NEW_HOOK, s, wt, agent.pid).status).toBe(2);
    await new Promise((r) => setTimeout(r, 1000));
    expect(agent.gone(), 'the stand-in exited before the second fire').toBe(false);
    const r = fire(NEW_HOOK, s, wt, agent.pid);
    expect(r.status, r.log).toBe(2);
    expect(r.log).toMatch(/BLOCKING compaction/);
  });

  it('case 3: a fire inside the cooldown after the stopped agent exited allows compaction (exit 0)', async () => {
    const { s, wt, agent } = await stage();
    expect(fire(NEW_HOOK, s, wt, agent.pid).status).toBe(2);
    for (let i = 0; i < 100 && !agent.gone(); i++) await new Promise((r) => setTimeout(r, 100));
    expect(agent.gone(), 'the stand-in never exited').toBe(true);
    const r = fire(NEW_HOOK, s, wt, agent.pid);
    expect(r.status, r.log).toBe(0);
    expect(r.log).toMatch(/loop guard\)\n$/);
  }, 15000);

  it('case 4: a fire inside the cooldown with no recorded stop allows compaction (exit 0)', async () => {
    const { s, wt, agent } = await stage();
    const state = join(s.home, '.local', 'state', 'hadron-worker-shed');
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, `${NAME}.last-auto-shed`), '');
    const r = fire(NEW_HOOK, s, wt, agent.pid);
    expect(r.status, r.log).toBe(0);
    expect(agent.gone(), 'a cooldown fire signalled the agent').toBe(false);
  });

  it('a fire from another live agent inside the cooldown is not blocked (the CLAUDE_PID clause)', async () => {
    const { s, wt, agent } = await stage();
    const other = await startAgent(s.root, 'other'); // a second, unrelated live agent
    agents.push(other);
    expect(fire(NEW_HOOK, s, wt, agent.pid).status).toBe(2);
    const r = fire(NEW_HOOK, s, wt, other.pid);
    expect(r.status, r.log).toBe(0);
    expect(other.gone(), 'a cooldown fire signalled the other agent').toBe(false);
  });

  // George's #2164 P2: the cooldown must verify the caller, never default it to the stopped pid.
  for (const [label, pid] of [['missing', undefined], ['empty', '']] as const) {
    it(`a fire with a ${label} CLAUDE_PID, not descended from the stopped agent, is allowed while it exits (exit 0)`, async () => {
      const { s, wt, agent } = await stage();
      expect(fire(NEW_HOOK, s, wt, agent.pid).status).toBe(2);
      await new Promise((r) => setTimeout(r, 500));
      expect(agent.gone(), 'the stand-in exited before the second fire').toBe(false);
      const r = fire(NEW_HOOK, s, wt, pid);
      expect(r.status, r.log).toBe(0);
      expect(r.log).not.toMatch(/BLOCKING compaction/);
    });
  }

  it('a fire from the dying agent itself with no CLAUDE_PID is blocked: its ancestry proves the owner (exit 2)', async () => {
    const s = sandbox();
    const wt = join(s.root, NAME); mkdirSync(wt);
    const input = join(s.root, 'fire.json'); writeFileSync(input, fireInput(wt));
    const rc = join(s.root, 'self-fire.rc');
    // On TERM the stand-in runs the hook as its own child, with CLAUDE_PID removed from the environment.
    // (`\$?` survives the supervisor's double-quoted `bash -c`, so it is the hook's exit status.)
    const onTerm = `env -u CLAUDE_PID HOME=${s.home} PATH=${s.bin}:${process.env.PATH} bash ${NEW_HOOK} < ${input} > /dev/null 2>&1; echo \\$? > ${rc}; `;
    const agent = await startAgent(s.root, 'agent', onTerm);
    agents.push(agent);
    expect(fire(NEW_HOOK, s, wt, agent.pid).status).toBe(2);
    for (let i = 0; i < 50 && !existsSync(rc); i++) await new Promise((r) => setTimeout(r, 100));
    expect(readFileSync(rc, 'utf8').trim(), shedLog(s)).toBe('2');
    expect(shedLog(s)).toMatch(/BLOCKING compaction/);
  });

  describe('red pins: the hook installed before the fix lets compaction through', () => {
    it('old hook: the stopping fire exits 0', async () => {
      const { s, wt, agent } = await stage();
      const r = fire(PRE2163_HOOK, s, wt, agent.pid);
      expect(r.log).toMatch(/stopping claude pid/);
      expect(r.status).toBe(0);
    });
    it('old hook: a second fire while the stopped agent is still exiting exits 0', async () => {
      const { s, wt, agent } = await stage();
      fire(PRE2163_HOOK, s, wt, agent.pid);
      await new Promise((r) => setTimeout(r, 1000));
      expect(agent.gone()).toBe(false);
      expect(fire(PRE2163_HOOK, s, wt, agent.pid).status).toBe(0);
    });
  });
});

it('#3082 recovery prompt never instructs MCP worker binding', () => {
  expect(readCutSource3082(new URL('./worker-auto-shed', import.meta.url), 'utf8')).not.toContain('hadron_resume_session');
});
