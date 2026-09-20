/**
 * #1146 — branch names that git would read as OPTIONS are refused.
 *
 * `readBranch` / `writeBranch` reach `git` as positional arguments, so a value
 * beginning with `-` is parsed as an option rather than as a ref. Not shell
 * injection — `execGit` uses no shell — which is why it survived #561's
 * transport hardening pass, whose subject was the remote URL.
 *
 * The rules were verified against git 2.50.1 rather than transcribed from
 * memory, and the ACCEPT cases matter as much as the REJECT ones: a guard that
 * refused `my_repo` or `release/1.2` would break ordinary branches. The
 * temptation when writing a blocklist is to over-refuse and never notice,
 * because nothing in a test suite complains about a rule that is too strict.
 */

import { describe, it, expect } from 'vitest';
import { isValidGitBranch, validateGitBranch, GitRefError } from './gitRef.js';

describe('isValidGitBranch — refuses', () => {
  it.each([
    ['the argument-injection case', '-orphan'],
    ['a long option', '--orphan'],
    ['a bare dash', '-'],
    ['empty', ''],
    ['whitespace', 'my branch'],
    ['a tab', 'my\tbranch'],
    ['a NUL byte', 'my\u0000branch'],
    ['a DEL byte', 'my\u007fbranch'],
    ['".." traversal', 'a..b'],
    ['leading dot', '.hidden'],
    ['trailing dot', 'branch.'],
    ['a .lock suffix', 'branch.lock'],
    ['leading slash', '/branch'],
    ['trailing slash', 'branch/'],
    ['a double slash', 'a//b'],
    ['a dot after a slash', 'a/.b'],
    ['the reflog "@"', '@'],
    ['a reflog expression', 'branch@{1}'],
    ['a colon', 'a:b'],
    ['a caret', 'a^b'],
    ['a tilde', 'a~b'],
    ['a question mark', 'a?b'],
    ['a glob', 'a*b'],
    ['a bracket', 'a[b'],
    ['a backslash', 'a\\b'],
  ])('%s', (_label, value) => {
    expect(isValidGitBranch(value)).toBe(false);
  });
});

describe('isValidGitBranch — accepts', () => {
  it.each([
    ['a plain name', 'main'],
    // The one the sibling issue #1145 turns on: underscores are ORDINARY in
    // repo and branch names, and a guard that refused them would be worse than
    // the bug it fixed.
    ['an underscore', 'my_branch'],
    ['a hyphen not in first position', 'my-branch'],
    ['a slash-separated name', 'release/1.2'],
    ['a dot inside', 'v1.2.3'],
    ['digits', '2026'],
    ['the mirror default', 'hadron-updates'],
    ['the sync default', 'main'],
  ])('%s', (_label, value) => {
    expect(isValidGitBranch(value)).toBe(true);
  });
});

describe('validateGitBranch', () => {
  it('passes through null and undefined — the columns are optional', () => {
    // A memory with no branch override is the common case; refusing "unset"
    // would break every memory that never set one.
    expect(() => validateGitBranch(null, 'readBranch')).not.toThrow();
    expect(() => validateGitBranch(undefined, 'writeBranch')).not.toThrow();
  });

  it('names the offending field and the value', () => {
    // Both columns are settable in one mutation, so a bare refusal makes the
    // caller guess which one to retype.
    try {
      validateGitBranch('-orphan', 'writeBranch');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(GitRefError);
      expect((e as Error).message).toContain('writeBranch');
      expect((e as Error).message).toContain('-orphan');
    }
  });
});
