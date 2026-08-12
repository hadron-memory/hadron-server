/**
 * #947 — the work-ref normalizer IS the worklog's equality-lookup contract, so
 * the accepted-spelling table is tested exhaustively: every accepted input
 * spelling per kind, canonical idempotence, case handling, kind-contradiction
 * refusals, and the not-accepted set (bare numbers above all — the server
 * never infers a repo).
 */
import { describe, it, expect } from 'vitest';
import { parseWorkRef, normalizeWorkRef, WorkRefInvalidError, type WorkKind } from './workRef.js';

describe('parseWorkRef / normalizeWorkRef (#947)', () => {
  // ── the accepted-spelling table ────────────────────────────────────────────
  const ACCEPTED: Array<[input: string, canonical: string, kinds: WorkKind[]]> = [
    // repo — canonical, URL, scheme variants, www, .git, ssh remote, trailing slash
    ['owner/repo', 'owner/repo', ['repo']],
    ['Owner/Repo', 'owner/repo', ['repo']],
    ['owner/repo.git', 'owner/repo', ['repo']],
    ['https://github.com/owner/repo', 'owner/repo', ['repo']],
    ['https://github.com/owner/repo/', 'owner/repo', ['repo']],
    ['http://github.com/owner/repo', 'owner/repo', ['repo']],
    ['https://www.github.com/owner/repo', 'owner/repo', ['repo']],
    ['github.com/owner/repo', 'owner/repo', ['repo']],
    ['https://github.com/Owner/Repo.git', 'owner/repo', ['repo']],
    ['git@github.com:owner/repo.git', 'owner/repo', ['repo']],
    ['git@github.com:Owner/Repo', 'owner/repo', ['repo']],
    ['baragaun/hadron-server', 'baragaun/hadron-server', ['repo']],
    ['owner/repo.name-x_1', 'owner/repo.name-x_1', ['repo']],

    // pr / issue — one shared canonical spelling
    ['owner/repo#371', 'owner/repo#371', ['pr', 'issue']],
    ['Owner/Repo#371', 'owner/repo#371', ['pr', 'issue']],
    ['https://github.com/owner/repo/pull/371', 'owner/repo#371', ['pr', 'issue']],
    ['https://github.com/owner/repo/pull/371/files', 'owner/repo#371', ['pr', 'issue']],
    ['https://github.com/owner/repo/pull/371#discussion_r1', 'owner/repo#371', ['pr', 'issue']],
    ['https://github.com/owner/repo/pull/371?diff=split', 'owner/repo#371', ['pr', 'issue']],
    ['https://github.com/owner/repo/issues/42', 'owner/repo#42', ['pr', 'issue']],
    ['github.com/owner/repo/issues/42#issuecomment-1', 'owner/repo#42', ['pr', 'issue']],

    // commit — sha lowercased, 7..40 hex accepted
    ['owner/repo@ABCDEF1', 'owner/repo@abcdef1', ['commit']],
    ['owner/repo@abcdef1234567890abcdef1234567890abcdef12', 'owner/repo@abcdef1234567890abcdef1234567890abcdef12', ['commit']],
    ['https://github.com/owner/repo/commit/ABCdef1234', 'owner/repo@abcdef1234', ['commit']],

    // branch — case PRESERVED, slashes allowed
    ['owner/repo:main', 'owner/repo:main', ['branch']],
    ['owner/repo:feat/team-Worklog', 'owner/repo:feat/team-Worklog', ['branch']],
    ['Owner/Repo:Feat-X', 'owner/repo:Feat-X', ['branch']],
    ['https://github.com/owner/repo/tree/main', 'owner/repo:main', ['branch']],
    ['https://github.com/owner/repo/tree/feat/team-worklog', 'owner/repo:feat/team-worklog', ['branch']],
  ];

  it.each(ACCEPTED)('accepts %s → %s', (input, canonical, kinds) => {
    expect(parseWorkRef(input)).toEqual({ ref: canonical, kinds });
    for (const kind of kinds) {
      expect(normalizeWorkRef(input, kind)).toBe(canonical);
    }
    // kind-less normalization (the read-filter path) yields the same spelling
    expect(normalizeWorkRef(input)).toBe(canonical);
  });

  it('is idempotent: normalizing a canonical form returns it unchanged', () => {
    for (const [, canonical] of ACCEPTED) {
      expect(normalizeWorkRef(canonical)).toBe(canonical);
    }
  });

  // ── the refused set ────────────────────────────────────────────────────────
  const REFUSED: string[] = [
    '', '   ',
    // bare numbers: repo inference is client-inherent — the server never guesses
    '371', '#371',
    'owner', 'owner/', '/repo',
    'owner//repo',
    'owner/repo#', 'owner/repo#0', 'owner/repo#12a', 'owner/repo#-3',
    'owner/repo@', 'owner/repo@notahex', 'owner/repo@abc',        // sha < 7 chars
    'owner/repo@abcdef1234567890abcdef1234567890abcdef123',        // sha > 40 chars
    'owner/repo:', 'owner/repo:has space', 'owner/repo:a:b',       // ':' is not a git refname char
    'owner/repo/pull/371',                                         // path form without a github.com host
    'https://gitlab.com/owner/repo',                               // foreign host
    'https://github.com/owner',                                    // no repo
    'https://github.com/owner/repo/pull/notanumber',
    'https://github.com/owner/repo/commit/nothex',
    'https://github.com/owner/repo/tree/',
    'https://github.com/owner/repo/unknown/5',
    '-owner/repo',                                                 // illegal owner
    'ow ner/repo',
  ];

  it.each(REFUSED.map((r) => [r]))('refuses %j', (input) => {
    expect(parseWorkRef(input)).toBeNull();
    expect(() => normalizeWorkRef(input)).toThrow(WorkRefInvalidError);
  });

  // ── kind contradictions ────────────────────────────────────────────────────
  const CONTRADICTIONS: Array<[string, WorkKind]> = [
    ['owner/repo#5', 'commit'],
    ['owner/repo#5', 'branch'],
    ['owner/repo#5', 'repo'],
    ['owner/repo@abcdef1', 'pr'],
    ['owner/repo@abcdef1', 'issue'],
    ['owner/repo:main', 'pr'],
    ['owner/repo', 'pr'],
    ['owner/repo', 'commit'],
    ['https://github.com/owner/repo/pull/5', 'commit'],
    ['https://github.com/owner/repo/tree/main', 'repo'],
  ];

  it.each(CONTRADICTIONS)('refuses %s as kind %s', (input, kind) => {
    expect(() => normalizeWorkRef(input, kind)).toThrow(WorkRefInvalidError);
  });

  it('a pr URL is accepted for kind issue and vice versa (shared number space)', () => {
    expect(normalizeWorkRef('https://github.com/o/r/pull/7', 'issue')).toBe('o/r#7');
    expect(normalizeWorkRef('https://github.com/o/r/issues/7', 'pr')).toBe('o/r#7');
  });
});
