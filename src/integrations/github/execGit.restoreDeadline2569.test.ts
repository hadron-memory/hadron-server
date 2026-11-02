/** #2569: exercise a real, SIGTERM-resistant child, not a rejected Promise standing in for a hang. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inspect } from 'node:util';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execGit, GitCommandError } from './execGit.js';
import { withMirrorCheckoutLock } from './mirrorCheckoutLock.js';

let root: string;
let watchdog: ReturnType<typeof setTimeout> | undefined;
const SECRET = 'ghs_SYNTHETIC_RESTORE_2569';
function pid(): number | undefined {
  const file = join(root, 'pid');
  if (!existsSync(file)) return undefined;
  const value = Number(readFileSync(file, 'utf8'));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid owned child PID');
  return value;
}
function killOwnedChild() {
  const child = pid();
  if (child === undefined) return;
  try { process.kill(child, 'SIGKILL'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
  }
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'restore2569-'));
  mkdirSync(join(root, 'bin'));
  // Only this invocation's PATH changes. No real repository, network or credentials.
  writeFileSync(join(root, 'bin', 'git'), `#!${process.execPath}\n` +
    `const fs = require('node:fs');\n` +
    `if (!process.argv.includes('stall-2569')) { process.stdout.write('ordinary'); process.exit(0); }\n` +
    `process.on('SIGTERM', () => {});\n` +
    `fs.writeFileSync(${JSON.stringify(join(root, 'pid'))}, String(process.pid));\n` +
    `process.stderr.write(${JSON.stringify(SECRET)});\n` +
    `setInterval(() => {}, 1000);\n`, { mode: 0o700 });
});
afterEach(() => {
  if (watchdog) clearTimeout(watchdog);
  watchdog = undefined;
  killOwnedChild();
  rmSync(root, { recursive: true, force: true });
});

describe('#2569 bounded child completion under the checkout lock', () => {
  it.each([false, true])('kills and reaps before the next lock holder, preserving primary failure=%s', async fail => {
    const memory = `restore2569-${root}`;
    const primary = new Error('primary-2569');
    let safetyKill = false;
    let caught: unknown;
    let restored = false;
    let nextEntered = false;
    // A broken implementation is cleaned up too; reaching this timer makes the pin RED.
    watchdog = setTimeout(() => { safetyKill = true; killOwnedChild(); }, 2500);
    const first = withMirrorCheckoutLock(memory, async () => {
      try {
        if (fail) throw primary;
        return 'primary-success';
      } finally {
        try {
          await execGit(['remote', 'set-url', 'origin', `https://${SECRET}@github.com/o/r`, 'stall-2569'], {
            cwd: root, env: { ...process.env, PATH: join(root, 'bin') }, timeout: 500,
          } as Parameters<typeof execGit>[1] & { timeout: number });
        } catch (error) { caught = error; }
        restored = true;
      }
    });
    const next = withMirrorCheckoutLock(memory, async () => {
      nextEntered = true;
      expect(restored).toBe(true);
      const child = pid();
      expect(child).toBeDefined();
      // kill(0) still sees an unreaped zombie; ESRCH proves the child is gone at lock handoff.
      expect(() => process.kill(child!, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }));
    });
    const [outcome, successor] = await Promise.allSettled([first, next]);
    expect(successor.status).toBe('fulfilled');
    expect(nextEntered).toBe(true);
    expect(safetyKill, 'deadline must kill a child that ignores SIGTERM').toBe(false);
    expect(caught).toBeInstanceOf(GitCommandError);
    expect(caught).toMatchObject({ signal: 'SIGKILL' });
    expect(inspect(caught, { depth: null })).not.toContain(SECRET);
    expect(inspect(caught, { depth: null })).not.toContain(root);
    if (fail) expect(outcome).toEqual({ status: 'rejected', reason: primary });
    else expect(outcome).toEqual({ status: 'fulfilled', value: 'primary-success' });
  }, 10_000);

  it('keeps an invocation without a deadline working normally', async () => {
    const output = await execGit(['status'], { cwd: root, env: { ...process.env, PATH: join(root, 'bin') } });
    expect(output.stdout).toBe('ordinary');
  });
});
