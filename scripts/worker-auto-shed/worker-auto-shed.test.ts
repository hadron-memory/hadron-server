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
 *    NOTHING_TO_RESUME, no MCP branch (#3082), never --as, never a post as the human).
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
  // A `hadron` that records every call: print mode must never reach it. #3954: it also answers the two reads the
  // human-presence check makes (the worker's name, and its terminal's prompt state, from <root>/terminal.json;
  // the content FAIL makes that read exit 1).
  writeFileSync(join(bin, 'hadron'), `#!/bin/sh
echo "$@" >> "${calls}"
case "$*" in
  "team session whoami"*) echo "Demo (server-engineer)" ;;
  "team worker get"*)
    t="${root}/terminal.json"
    if [ -f "$t" ] && [ "$(cat "$t")" = FAIL ]; then exit 1; fi
    if [ -f "$t" ]; then cat "$t"; else echo '{"terminal":{"prompt":"empty"}}'; fi ;;
esac
exit 0
`);
  chmodSync(join(bin, 'hadron'), 0o755);
  // #3954: the transcript a PreCompact fire names. Default: one human prompt an hour old, so no conversation is live.
  writeFileSync(join(root, 'transcript.jsonl'), humanEntry(60 * 60_000, 'an old question') + '\n');
  return { root, home, bin, calls };
}
/** One transcript line: a prompt that arrived `agoMs` ago. `origin.kind` is how Claude Code tags who authored it. */
function promptEntry(agoMs: number, content: unknown, kind = 'human'): string {
  return JSON.stringify({ type: 'user', origin: { kind }, promptSource: 'typed', timestamp: new Date(Date.now() - agoMs).toISOString(), message: { role: 'user', content } });
}
const humanEntry = (agoMs: number, text: string): string => promptEntry(agoMs, text);
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
    input: fireInput(wt),
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
  ['names no MCP branch: MCP does not bind workers (#3082)', (p) => !/hadron_resume_session|MCP/.test(p)],
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
async function startAgent(root: string, tag = 'agent', onTerm = '', releaseFile = ''): Promise<Agent> {
  const pidFile = join(root, `${tag}.pid`);
  // With `releaseFile`, the stopped stand-in exits only once that file exists (the test releases it), so "still exiting"
  // is a state the test controls, not a wall-clock window (#3812). Without it, it exits DIE_MS after TERM.
  const dying = releaseFile ? `while [ ! -e ${releaseFile} ]; do sleep 0.05; done` : `sleep ${DIE_MS / 1000}`;
  const inner = `trap '${onTerm}${dying}; exit 0' TERM; while :; do sleep 0.1; done`;
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
const fireInput = (wt: string): string => JSON.stringify({ trigger: 'auto', cwd: wt, transcript_path: join(dirname(wt), 'transcript.jsonl') });
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
      const s = sandbox();
      const wt = join(s.root, NAME); mkdirSync(wt);
      // The stopped stand-in stays "still exiting" until released: no sleep, no race on how fast the box is.
      const release = join(s.root, 'release-agent');
      const agent = await startAgent(s.root, 'agent', '', release);
      agents.push(agent);
      try {
        expect(fire(PRE2163_HOOK, s, wt, agent.pid).log).toMatch(/stopping claude pid/); // the stop really happened
        expect(agent.gone(), 'the stand-in exited before the second fire').toBe(false);
        expect(fire(PRE2163_HOOK, s, wt, agent.pid).status).toBe(0);
      } finally {
        writeFileSync(release, ''); // always release, so a failed assertion cannot leave the stand-in waiting
      }
      for (let i = 0; i < 50 && !agent.gone(); i++) await new Promise((r) => setTimeout(r, 100));
      expect(agent.gone(), 'the released stand-in never exited').toBe(true);
    });
  });
});

/**
 * #3954: the hook must not stop an agent while a human is in a conversation with it.
 * Two skip branches (the terminal's prompt box holds a draft; the last human-authored prompt is within 15 minutes),
 * both exit 0 so Claude Code's own (lossy) compaction runs, both fail toward NOT killing when the check cannot
 * be made, and both post one warning line per skip episode (Holger, 2026-11-11: "15 min is fine, and yes to
 * posting a warning"). Wake and delivery prompts are injected through the terminal too, so they are tagged
 * `human` by Claude Code; the hook recognises them by their `[hadron tick|task|chat]` marker.
 */
describe('#3954: no kill while a human is in the conversation', () => {
  const agents: Agent[] = [];
  afterEach(() => { for (const a of agents.splice(0)) { try { process.kill(a.pid, 'SIGKILL'); } catch { /* gone */ } a.supervisor.kill('SIGKILL'); } });

  async function stage(): Promise<{ s: ReturnType<typeof sandbox>; wt: string; agent: Agent; transcript: (...lines: string[]) => void; terminal: (content: string) => void }> {
    const s = sandbox();
    const wt = join(s.root, NAME); mkdirSync(wt);
    const agent = await startAgent(s.root);
    agents.push(agent);
    return {
      s, wt, agent,
      transcript: (...lines) => writeFileSync(join(s.root, 'transcript.jsonl'), lines.join('\n') + '\n'),
      terminal: (content) => writeFileSync(join(s.root, 'terminal.json'), content),
    };
  }
  const state = (s: ReturnType<typeof sandbox>): string => join(s.home, '.local', 'state', 'hadron-worker-shed');
  const warnings = (s: ReturnType<typeof sandbox>): string[] =>
    (existsSync(s.calls) ? readFileSync(s.calls, 'utf8') : '').split('\n').filter((l) => l.startsWith('team chat post'));
  const MIN = 60_000;

  it('typing: a draft in the prompt box means no kill, compaction runs (exit 0)', async () => {
    const { s, wt, agent, terminal } = await stage();
    terminal('{"terminal":{"prompt":"not_empty"}}');
    const r = fire(NEW_HOOK, s, wt, agent.pid);
    expect(r.status, r.log).toBe(0);
    expect(r.log).toMatch(/skip: human typing/);
    expect(agent.gone(), 'the hook stopped an agent whose human was typing').toBe(false);
    expect(existsSync(join(state(s), `${NAME}.prompt`)), 'a recovery prompt was left behind without a shed').toBe(false);
    expect(existsSync(join(state(s), `${NAME}.last-auto-shed`)), 'a skip must not start the 10-minute cooldown').toBe(false);
  });

  it('conversation: a human prompt 5 minutes ago means no kill (exit 0)', async () => {
    const { s, wt, agent, transcript } = await stage();
    transcript(humanEntry(5 * MIN, 'what do you think about the second option?'));
    const r = fire(NEW_HOOK, s, wt, agent.pid);
    expect(r.status, r.log).toBe(0);
    expect(r.log).toMatch(/skip: human conversation/);
    expect(agent.gone(), 'the hook stopped an agent mid-conversation').toBe(false);
  });

  it('conversation: the window is 15 minutes: 14 skips, 16 kills', async () => {
    const a = await stage();
    a.transcript(humanEntry(14 * MIN, 'recent'));
    expect(fire(NEW_HOOK, a.s, a.wt, a.agent.pid).log).toMatch(/skip: human conversation/);
    const b = await stage();
    b.transcript(humanEntry(16 * MIN, 'stale'));
    const r = fire(NEW_HOOK, b.s, b.wt, b.agent.pid);
    expect(r.status, r.log).toBe(2);
    expect(r.log).toMatch(/stopping claude pid/);
  });

  it('conversation: a prompt whose content is an array of text blocks counts as a human prompt', async () => {
    const { s, wt, agent, transcript } = await stage();
    transcript(promptEntry(2 * MIN, [{ type: 'text', text: 'and what about the rollout?' }]));
    expect(fire(NEW_HOOK, s, wt, agent.pid).log).toMatch(/skip: human conversation/);
    expect(agent.gone()).toBe(false);
  });

  it.each([
    ['a tick', '[hadron tick] tick team-tick: resolve your task for tick.team-tick yourself'],
    ['a task delivery', '[hadron task] child finished: LOCAL review at abc (01a1)'],
    ['a chat delivery', '[hadron chat] 2 for Beryl · #99237 Coco: hello'],
    ['a pasted chat delivery', '\n\n<pasted_content id="6c71">\n[hadron chat] 2 for Beryl · #1 Bruce: hi\n</pasted_content id="6c71">'],
  ])('wake and delivery prompts do not count as human: %s injected a minute ago still sheds', async (_n, text) => {
    const { s, wt, agent, transcript } = await stage();
    transcript(humanEntry(30 * MIN, 'an old question'), humanEntry(1 * MIN, text));
    const r = fire(NEW_HOOK, s, wt, agent.pid);
    expect(r.status, r.log).toBe(2);
    expect(r.log).not.toMatch(/skip: human/);
  });

  it('tool results, assistant turns and non-human origins do not count either', async () => {
    const { s, wt, agent, transcript } = await stage();
    transcript(
      humanEntry(30 * MIN, 'an old question'),
      promptEntry(1 * MIN, 'a background task finished', 'task-notification'),
      JSON.stringify({ type: 'user', timestamp: new Date(Date.now() - 1 * MIN).toISOString(), message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } }),
      JSON.stringify({ type: 'assistant', timestamp: new Date(Date.now() - 1 * MIN).toISOString(), message: { role: 'assistant', content: 'done' } }),
    );
    const r = fire(NEW_HOOK, s, wt, agent.pid);
    expect(r.status, r.log).toBe(2);
  });

  it('fails toward not killing when the terminal state cannot be read (exit 0, agent untouched)', async () => {
    for (const bad of ['FAIL', 'not json', '{"terminal":{}}', '{"terminal":{"prompt":"mystery"}}']) {
      const { s, wt, agent, terminal } = await stage();
      terminal(bad);
      const r = fire(NEW_HOOK, s, wt, agent.pid);
      expect(r.status, `${bad}: ${r.log}`).toBe(0);
      expect(r.log, bad).toMatch(/skip: human presence unreadable/);
      expect(agent.gone(), `${bad}: the hook stopped an agent whose human state is unknown`).toBe(false);
    }
  });

  it('fails toward not killing when the terminal report is stale (an old empty prompt proves nothing)', async () => {
    for (const bad of ['{"terminal":{"prompt":"empty","stale":true,"status":"dark"}}', '{"terminal":{"prompt":"empty","stale":true}}']) {
      const { s, wt, agent, terminal } = await stage();
      terminal(bad);
      const r = fire(NEW_HOOK, s, wt, agent.pid);
      expect(r.status, `${bad}: ${r.log}`).toBe(0);
      expect(r.log, bad).toMatch(/skip: human presence unreadable/);
      expect(agent.gone(), `${bad}: stopped on a stale terminal report`).toBe(false);
    }
  });

  it('fails toward not killing when the transcript holds a malformed record (truncated, or mixed with an old valid one)', async () => {
    const bad: string[][] = [
      ['{"type":"user","origin":{"kind":"human"},"timestamp":"2026-'],
      [humanEntry(60 * MIN, 'old'), '{"type":"user","origin":{"kind":"hum'],
      ['not json at all'],
    ];
    for (const lines of bad) {
      const { s, wt, agent, transcript } = await stage();
      transcript(...lines);
      const r = fire(NEW_HOOK, s, wt, agent.pid);
      expect(r.status, `${lines}: ${r.log}`).toBe(0);
      expect(r.log, String(lines)).toMatch(/skip: human presence unreadable/);
      expect(agent.gone(), `${lines}: stopped on an unparseable transcript`).toBe(false);
    }
  });

  it('fails toward not killing when the transcript cannot be read (exit 0, agent untouched)', async () => {
    const { s, wt, agent } = await stage();
    rmSync(join(s.root, 'transcript.jsonl'));
    const r = fire(NEW_HOOK, s, wt, agent.pid);
    expect(r.status, r.log).toBe(0);
    expect(r.log).toMatch(/skip: human presence unreadable/);
    expect(agent.gone()).toBe(false);
  });

  it('warns once per skip episode, in both skip cases, not on every attempt', async () => {
    const { s, wt, agent, terminal } = await stage();
    terminal('{"terminal":{"prompt":"not_empty"}}');
    fire(NEW_HOOK, s, wt, agent.pid);
    fire(NEW_HOOK, s, wt, agent.pid);
    expect(warnings(s), 'one warning for the whole typing episode').toHaveLength(1);
    expect(warnings(s)[0]).toMatch(/shed is due/);
    // The same episode continues as a conversation skip: still no second warning.
    terminal('{"terminal":{"prompt":"empty"}}');
    writeFileSync(join(s.root, 'transcript.jsonl'), humanEntry(1 * MIN, 'ok, go on') + '\n');
    expect(fire(NEW_HOOK, s, wt, agent.pid).log).toMatch(/skip: human conversation/);
    expect(warnings(s)).toHaveLength(1);
  });

  it('the conversation skip warns too', async () => {
    const { s, wt, agent, transcript } = await stage();
    transcript(humanEntry(1 * MIN, 'a question'));
    fire(NEW_HOOK, s, wt, agent.pid);
    expect(warnings(s)).toHaveLength(1);
  });

  it('a new episode warns again: after the human is gone and a shed ran, the next skip posts', async () => {
    const { s, wt, agent, terminal } = await stage();
    terminal('{"terminal":{"prompt":"not_empty"}}');
    fire(NEW_HOOK, s, wt, agent.pid);
    expect(warnings(s)).toHaveLength(1);
    terminal('{"terminal":{"prompt":"empty"}}');
    expect(fire(NEW_HOOK, s, wt, agent.pid).status, 'the shed proceeds once no human is present').toBe(2);
    // The shed ends the episode; the relaunched agent's next skip is a new one.
    const again = await startAgent(s.root, 'again');
    agents.push(again);
    rmSync(join(state(s), `${NAME}.last-auto-shed`), { force: true });
    terminal('{"terminal":{"prompt":"not_empty"}}');
    fire(NEW_HOOK, s, wt, again.pid);
    expect(warnings(s)).toHaveLength(2);
  });

  it('the kill path warns nobody', async () => {
    const { s, wt, agent } = await stage();
    expect(fire(NEW_HOOK, s, wt, agent.pid).status).toBe(2);
    expect(warnings(s)).toHaveLength(0);
  });

  it('manual /compact stays untouched and reads nothing about the human', async () => {
    const { s, wt } = await stage();
    const r = spawnSync('bash', [NEW_HOOK], { encoding: 'utf8', input: JSON.stringify({ trigger: 'manual', cwd: wt, transcript_path: '' }), env: { PATH: `${s.bin}:${process.env.PATH}`, HOME: s.home } });
    expect(r.status).toBe(0);
    expect(existsSync(s.calls), 'a manual compact called hadron').toBe(false);
  });
});
