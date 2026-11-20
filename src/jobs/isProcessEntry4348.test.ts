/** #4348 item 2: "is this file the process entry" must hold for a relative path and for a symlink to the file. */
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isProcessEntry } from './isProcessEntry.js';

const self = new URL('./isProcessEntry.ts', import.meta.url);
const selfPath = self.pathname;

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
    expect(isProcessEntry(self.href, new URL('./usageActivityRollup.ts', import.meta.url).pathname)).toBe(false);
    expect(isProcessEntry(self.href, undefined)).toBe(false);
    expect(isProcessEntry(self.href, join(tmpdir(), 'entry4348-missing', 'x.ts'))).toBe(false);
  });
});
