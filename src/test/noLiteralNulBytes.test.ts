/**
 * No source file may contain a literal NUL byte.
 *
 * Found while reviewing #1172: `resolvers.types.ts` carried one inside a
 * template literal (`` `${r.appId}\0${…}` `` written as the raw byte rather
 * than the escape, landed by #1163). The code was correct — NUL is a fine
 * cache-key separator — but **grep treats the whole file as binary and skips
 * it silently**: a repo-wide `grep -rn "defaultChannel" src` returned nothing
 * while the resolver sat in that file, so the search reported ABSENCE for the
 * largest type-resolver module in the repo. `rg` behaves the same way by
 * default.
 *
 * That is the expensive part. Nothing fails, nothing warns, and every later
 * reader — human or agent — gets a confident false negative on every symbol in
 * the file. One file is enough to make "I grepped and it isn't there" unsafe
 * repo-wide, which is a conclusion this codebase's conventions lean on
 * constantly.
 *
 * The fix is always the escape (`\0`, `\x00`), which is byte-identical at
 * runtime and leaves the file searchable.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not `.pathname`: the latter stays percent-encoded, so a
// checkout under a path containing a space would fail this with the files
// right there (Copilot on PR #1172).
const ROOT = fileURLToPath(new URL('../', import.meta.url)); // src/
const SKIP_DIRS = new Set(['generated', 'node_modules']);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) sourceFiles(full, out);
    } else if (entry.endsWith('.ts') || entry.endsWith('.mts')) {
      out.push(full);
    }
  }
  return out;
}

describe('source hygiene', () => {
  it('no file under src/ contains a literal NUL byte (it makes grep skip the whole file)', () => {
    const offenders = sourceFiles(ROOT)
      .filter((f) => readFileSync(f).includes(0x00))
      .map((f) => f.slice(ROOT.length));
    // Named rather than counted: the remedy is per-file and is always the same
    // one character, so the message should say exactly where to apply it.
    expect(offenders, 'replace the raw byte with the escape \\0 — same value, searchable file').toEqual([]);
  });
});
