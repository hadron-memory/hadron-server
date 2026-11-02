import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { db } from '../db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';

const paths = vi.hoisted(() => ({ root: '' }));
vi.mock('../../config.js', () => ({ get GRAPHS_PATH() { return paths.root; } }));
vi.mock('./gitBranch.js', () => ({ prepareWriteBranch: vi.fn(async () => {}) }));
vi.mock('./execGit.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./execGit.js')>()),
  execGit: vi.fn(async () => ({ stdout: '', stderr: '' })),
}));

import { execGit, GitCommandError } from './execGit.js';
import { withMirrorCheckout } from './gitMirrorCheckout.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

let memoryId: string;

beforeEach(async () => {
  vi.resetAllMocks();
  paths.root = mkdtempSync(join(tmpdir(), 'hadron-checkout-lock-'));
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: 'mirror-lock', urn: 'mirror-lock-org' },
  });
  const memory = await db.memory.create({
    data: {
      id: generateId(), organizationId: org.id, name: 'mem',
      urn: 'mirror-lock-org:mem', class: 'knowledge',
      source: 'https://github.com/acme/repo.git',
    },
  });
  memoryId = memory.id;
  mkdirSync(join(paths.root, org.urn, 'mem', '.git'), { recursive: true });
  vi.mocked(execGit).mockImplementation(async () => ({ stdout: '', stderr: '' }));
});

afterEach(() => {
  rmSync(paths.root, { recursive: true, force: true });
});

describe('shared Git checkout', () => {
  it('holds the cross-process lock through mutation and remote restoration', async () => {
    const firstEntered = deferred();
    const releaseFirst = deferred();
    const restoreStarted = deferred();
    const releaseRestore = deferred();
    let secondEntered = false;
    let restoreCount = 0;
    let restoreTimeout: number | undefined;
    vi.mocked(execGit).mockImplementation(async (args, options) => {
      if (args[0] === 'remote' && args[1] === 'set-url' && ++restoreCount === 1) {
        restoreTimeout = (options as { timeout?: number })?.timeout;
        restoreStarted.resolve();
        await releaseRestore.promise;
      }
      return { stdout: '', stderr: '' };
    });
    const opts = {
      memoryId, clientId: 'test', commitSubject: 'test', logPrefix: '[test]',
    };
    const first = withMirrorCheckout(opts, async () => {
      firstEntered.resolve();
      await releaseFirst.promise;
    });
    await firstEntered.promise;
    const second = withMirrorCheckout(opts, () => { secondEntered = true; });

    try {
      // The local queue keeps the contender off PostgreSQL while the first
      // writer owns the checkout (covered directly in mirrorCheckoutLock.test).
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(secondEntered).toBe(false);
      releaseFirst.resolve();
      await restoreStarted.promise;
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(secondEntered).toBe(false);
    } finally {
      releaseFirst.resolve();
      releaseRestore.resolve();
      await Promise.allSettled([first, second]);
    }
    expect(secondEntered).toBe(true);
    expect(restoreTimeout).toBe(10_000);
  });

  it.each([0, 20_000])('preserves a config.lock aged %dms and classifies the failed restore without changing the primary result', async ageMs => {
    const localPath = join(paths.root, 'mirror-lock-org', 'mem');
    const lockPath = join(localPath, '.git', 'config.lock');
    const tokenUrl = 'https://ghs_SYNTHETIC_LOCK_2569@github.com/acme/repo.git';
    const git = (...args: string[]) => execFileSync('git', args, {
      cwd: localPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    });
    let attempts = 0;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(execGit).mockImplementation(async (args, options) => {
      if (args[0] === 'remote' && args[1] === 'set-url') {
        attempts++;
        expect(options).toEqual({ cwd: localPath, timeout: 10_000 });
        // Match execGit's asynchronous failure envelope while using real local git.
        try { git(...args); } catch (error) {
          throw new GitCommandError({ code: (error as { status?: number }).status });
        }
      }
      return { stdout: '', stderr: '' };
    });
    try {
      const outcome = await withMirrorCheckout({ memoryId, clientId: 'test', commitSubject: 'test', logPrefix: '[test]' }, async () => {
        git('init', '--template=');
        git('remote', 'add', 'origin', tokenUrl);
        writeFileSync(lockPath, 'synthetic-owner-2569');
        const stamp = new Date(Date.now() - ageMs);
        utimesSync(lockPath, stamp, stamp);
        return false; // The primary outcome is skipped, even when restoration fails.
      });
      expect(outcome).toBe('skipped');
      expect(attempts).toBe(1);
      expect(existsSync(lockPath)).toBe(true);
      expect(readFileSync(lockPath, 'utf8')).toBe('synthetic-owner-2569');
      expect(git('remote', 'get-url', 'origin').trim()).toBe(tokenUrl);
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('config.lock'), expect.objectContaining({
        phase: 'restore', class: 'REMOTE_RESTORE', exitCode: 128,
      }));
      expect(JSON.stringify(logged.mock.calls)).not.toContain('ghs_SYNTHETIC_LOCK_2569');
      expect(JSON.stringify(logged.mock.calls)).not.toContain(localPath);
    } finally { logged.mockRestore(); }
  });

});
