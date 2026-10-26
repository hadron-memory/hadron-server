/** #2360: execute recovery against a local CLI shim; never touch a real worker. */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const hook = join(dirname(fileURLToPath(import.meta.url)), 'worker-auto-shed');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** Script the claim outcome, recording argv before any simulated side effect. */
function stage(codes: number[], whoamiExit = 0) {
  const root = mkdtempSync(join(tmpdir(), 'bruno-recovery2360-'));
  roots.push(root);
  const bin = join(root, 'bin'); mkdirSync(bin);
  const home = join(root, 'home'); mkdirSync(home);
  const cwd = join(root, 'cwd'); mkdirSync(cwd);
  const emptyBin = join(root, 'empty-bin'); mkdirSync(emptyBin);
  const calls = join(root, 'calls'); writeFileSync(calls, '');
  const remaining = join(root, 'codes'); writeFileSync(remaining, codes.join('\n') + '\n');
  writeFileSync(join(bin, 'hadron'), `#!/bin/bash
printf '%s\\n' "$*" >> '${calls}'
if [ "$*" = 'team session whoami --check' ]; then echo 'whoami evidence'; exit ${whoamiExit}; fi
if [ "$1 $2 $3" != 'team session start' ]; then exit 99; fi
code=$(head -1 '${remaining}')
tail -n +2 '${remaining}' > '${remaining}.next'
mv '${remaining}.next' '${remaining}'
case "$code" in
  0) echo 'RESUMED existing-session';;
  2) echo 'CHOOSE: candidate-a candidate-b';;
  4) echo 'NOTHING_TO_RESUME: claims expired';;
  5) echo 'RESUME_REFUSED';;
  *) echo 'transport failure';;
esac
exit "$code"
`);
  chmodSync(join(bin, 'hadron'), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home };
  const run = (command: string, args: string[], path = env.PATH) => spawnSync(command, args, {
    encoding: 'utf8', input: '', timeout: 5000, cwd, env: { ...env, PATH: path },
  });
  return {
    run: (...args: string[]) => run('/bin/bash', [hook, '--resume-unbound', ...args]),
    runErrexit: (...args: string[]) => run('/bin/bash', ['-e', hook, '--resume-unbound', ...args]),
    runDirect: (...args: string[]) => run(hook, ['--resume-unbound', ...args]),
    runWithoutCli: () => run('/bin/bash', [hook, '--resume-unbound', '--tool', 'codex'], emptyBin),
    home, cwd, env,
    calls: () => readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean),
  };
}

describe('unbound shed recovery (#2360)', () => {
  it('CHOOSE then expired claims stops at ask-human with zero --as invocations', () => {
    const s = stage([2, 4]);
    const choose = s.run('--tool', 'codex');
    expect(choose.status, choose.stderr).toBe(2);
    expect(choose.stdout + choose.stderr).toMatch(/STOP.*ask the human/i);
    // The HUMAN picked candidate-a, but the claims expired before this retry.
    const expired = s.run('--tool', 'codex', '--session', 'candidate-a');
    expect(expired.status, expired.stderr).toBe(4);
    expect(expired.stdout + expired.stderr).toMatch(/STOP.*ask the human/i);
    expect(s.calls()).toEqual([
      'team session start --tool codex',
      'team session start --tool codex --session candidate-a',
      'team session whoami --check',
    ]);
    expect(s.calls().some((call) => /--as\b/.test(call))).toBe(false);
  });

  it('a single expired claim also asks the human', () => {
    const s = stage([4]);
    const r = s.run('--tool', 'codex');
    expect(r.status, r.stderr).toBe(4);
    expect(r.stdout + r.stderr).toMatch(/STOP.*ask the human/i);
    expect(s.calls()).toEqual(['team session start --tool codex', 'team session whoami --check']);
  });

  it('preserves successful resume and the explicit human-selected session', () => {
    const s = stage([0]);
    const r = s.run('--tool', 'codex', '--session', 'candidate-b');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('RESUMED existing-session');
    expect(s.calls()).toEqual(['team session start --tool codex --session candidate-b']);
  });

  for (const code of [5, 7]) it(`preserves refusal/error ${code} without retry or mint`, () => {
    const s = stage([code]);
    const r = s.run('--tool', 'codex');
    expect(r.status, r.stderr).toBe(code);
    expect(r.stdout + r.stderr).toMatch(/STOP/);
    expect(s.calls()).toEqual(['team session start --tool codex']);
  });

  for (const args of [[], ['--tool'], ['--tool', 'codex', '--as', 'someone'], ['--tool', 'codex', '--force'], ['--tool', 'codex', '--session', '--as'], ['--session', 'candidate-a'], ['--tool', 'codex', '--tool', 'claude'], ['--tool', 'codex', '--session', 'candidate-a', '--session', 'candidate-b']]) {
    it(`rejects malformed or mint-capable arguments ${JSON.stringify(args)} before any CLI call`, () => {
      const s = stage([0]);
      const r = s.run(...args);
      expect(r.status, r.stderr).toBe(64);
      expect(s.calls()).toEqual([]);
    });
  }

  for (const code of [2, 4, 5, 7]) it(`preserves STOP and status ${code} under explicit errexit`, () => {
    const s = stage([code], 7);
    const r = s.runErrexit('--tool', 'codex');
    expect(r.status, r.stderr).toBe(code);
    expect(r.stderr).toContain('STOP:');
    if (code === 4) {
      expect(r.stdout).toContain('whoami evidence');
      expect(r.stderr).toMatch(/whoami.*failed/i);
      expect(r.stderr).toMatch(/STOP.*ask the human/i);
    }
  });

  it('direct invocation follows the executable Bash shebang and preserves a failed evidence read', () => {
    const s = stage([4], 7);
    const r = s.runDirect('--tool', 'codex');
    expect(r.error).toBeUndefined();
    expect(r.status, r.stderr).toBe(4);
    expect(r.stdout).toContain('whoami evidence');
    expect(r.stderr).toMatch(/STOP.*ask the human/i);
    expect(readdirSync(s.home)).toEqual([]);
    expect(readdirSync(s.cwd)).toEqual([]);
    expect(s.calls()).toEqual(['team session start --tool codex', 'team session whoami --check']);
  });

  it('direct recovery returns with stdin held open, leaving no hook state, log or prompt', async () => {
    const s = stage([4]);
    const child = spawn(hook, ['--resume-unbound', '--tool', 'codex'], { cwd: s.cwd, env: s.env, stdio: ['pipe', 'ignore', 'ignore'] });
    const timer = setTimeout(() => child.kill(), 3000);
    try {
      const status = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      expect(status, 'recovery read hook stdin or failed direct execution').toBe(4);
      expect(readdirSync(s.home), 'recovery created hook state under HOME').toEqual([]);
      expect(readdirSync(s.cwd), 'recovery wrote to the working directory').toEqual([]);
      expect(s.calls()).toEqual(['team session start --tool codex', 'team session whoami --check']);
    } finally {
      clearTimeout(timer);
      child.stdin.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  });

  it('reports the actual unexpected exit status', () => {
    const s = stage([42]);
    const r = s.run('--tool', 'codex');
    expect(r.status, r.stderr).toBe(42);
    expect(r.stderr).toMatch(/STOP:.*42/);
  });

  it('treats a missing CLI as a terminal setup failure with the actual status', () => {
    const s = stage([]);
    const r = s.runWithoutCli();
    expect(r.status, r.stderr).toBe(127);
    expect(r.stderr).toMatch(/STOP:.*127.*not found/);
    expect(s.calls()).toEqual([]);
  });
});
