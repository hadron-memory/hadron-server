import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { db } from '../db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';

const paths = vi.hoisted(() => ({ root: '' }));
vi.mock('../../config.js', () => ({ get GRAPHS_PATH() { return paths.root; } }));
vi.mock('./gitBranch.js', () => ({ prepareWriteBranch: vi.fn(async () => {}) }));
vi.mock('./execGit.js', () => ({ execGit: vi.fn(async () => ({ stdout: '', stderr: '' })) }));

import { execGit } from './execGit.js';
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
});
