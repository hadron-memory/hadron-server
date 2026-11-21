/** #4348 item 2: "is this file the process entry" must hold for a relative path and for a symlink to the file. */
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isProcessEntry } from './isProcessEntry.js';

const self = new URL('./isProcessEntry.ts', import.meta.url);
const selfPath = fileURLToPath(self);

describe('isProcessEntry (#4348)', () => {
  it('is true for the absolute path the jobs are started by today', () => {
    expect(isProcessEntry(self.href, selfPath)).toBe(true);
  });
  it('is true for a relative argv[1] naming the same file', () => {
    expect(isProcessEntry(self.href, relative(process.cwd(), selfPath))).toBe(true);
  });
  it('is true for a symlink whose real path is the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'entry4348-'));
    try {
      const link = join(dir, 'link.ts');
      symlinkSync(selfPath, link);
      expect(isProcessEntry(self.href, link)).toBe(true);
      expect(isProcessEntry(pathToFileURL(link).href, selfPath)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('is false for another file, for no argv[1] and for a path that does not exist', () => {
    expect(isProcessEntry(self.href, fileURLToPath(new URL('./usageActivityRollup.ts', import.meta.url)))).toBe(false);
    expect(isProcessEntry(self.href, join(tmpdir(), 'entry4348-missing', 'x.ts'))).toBe(false);
  });
});

describe('isProcessEntry with no argv[1] (#4619)', () => {
  // Passing `undefined` as the second argument triggers the default parameter and reads the test runner's own argv[1],
  // so it never reaches the no-argument branch. These pins remove argv[1] for real, or use the empty string.
  it('is false when the process has no argv[1] (node -e, a REPL)', () => {
    const saved = process.argv[1];
    try {
      delete process.argv[1];
      expect(process.argv[1]).toBeUndefined();
      expect(isProcessEntry(self.href)).toBe(false);
    } finally { process.argv[1] = saved as string; }
  });
  it('is false for an empty argv[1], which realpath would resolve to the working directory', () => {
    // Without the early return, realpathSync('') is the cwd, so a module URL naming the cwd would be "the entry".
    expect(isProcessEntry(pathToFileURL(process.cwd()).href, '')).toBe(false);
  });
  it('does not mistake a checkout path with a space for the entry, and still matches it for itself', () => {
    const dir = mkdtempSync(join(tmpdir(), 'entry 4619 '));
    try {
      const link = join(dir, 'a b.ts');
      symlinkSync(selfPath, link);
      expect(isProcessEntry(pathToFileURL(link).href, link)).toBe(true);
      expect(isProcessEntry(pathToFileURL(link).href, undefined)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('the seven jobs name the helper, not the inline comparison (#4348 item 2)', () => {
  const jobs = ['gcOauthClients', 'reapOrphanAssetObjects', 'scanPendingAssets', 'reapSessions', 'usageActivityRollup', 'sweepMergeConsents', 'promotePendingEdges'];
  it.each(jobs)('%s', (job) => {
    const src = readFileSync(new URL(`./${job}.ts`, import.meta.url), 'utf8');
    expect(src).toContain('if (isProcessEntry(import.meta.url)) {');
    expect(src).not.toContain('process.argv[1]');
  });
});
