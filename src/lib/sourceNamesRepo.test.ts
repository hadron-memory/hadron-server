/**
 * #1145 — a repo slug identifies a Memory exactly, not by substring.
 *
 * The mirror and webhook paths resolved which Memory a push belongs to with
 * `source: { contains: ownerRepo }`. Prisma compiles `contains` to
 * `LIKE '%' || value || '%'`, and **`_` and `%` are legal in a GitHub
 * repository name**. `_` is a single-character wildcard, so a push to
 * `acme/my_repo` also matched a stored source of `acme/myXrepo` — a DIFFERENT
 * TENANT'S memory, with no ownership predicate anywhere beside the match.
 *
 * Underscores in repository names are ordinary, not exotic, which is what
 * makes this the common case rather than a crafted one.
 *
 * The wildcard cases below are the regression. The rest exist because the fix
 * is an exact comparison, and an exact comparison is easy to make too strict:
 * a stored source may or may not carry `.git`, a trailing slash, or the ssh
 * spelling, and refusing any of those would stop real memories from syncing.
 */

import { describe, it, expect } from 'vitest';
import { parseSourceSlug, sourceNamesRepo } from './gitSource.js';

describe('#1145 — the wildcard cases that started this', () => {
  it('does not let "_" match another repository', () => {
    // The literal defect: `_` is a LIKE wildcard, so the old substring match
    // treated these as the same repository.
    expect(sourceNamesRepo('https://github.com/acme/myXrepo', 'acme/my_repo')).toBe(false);
    expect(sourceNamesRepo('https://github.com/acme/my-repo', 'acme/my_repo')).toBe(false);
  });

  it('still matches the underscore repo it actually names', () => {
    // The other half of the pair — without this, a fix that rejected
    // everything containing `_` would pass the case above.
    expect(sourceNamesRepo('https://github.com/acme/my_repo', 'acme/my_repo')).toBe(true);
  });

  it('does not let "%" match a run of characters', () => {
    expect(sourceNamesRepo('https://github.com/acme/anything', 'acme/%')).toBe(false);
  });

  it('does not match a repo whose name merely CONTAINS the slug', () => {
    // The plain substring failure, independent of wildcards: a source of
    // `acme/my-repo-staging` contains `acme/my-repo`.
    expect(sourceNamesRepo('https://github.com/acme/my-repo-staging', 'acme/my-repo')).toBe(false);
  });

  it('does not match across the owner/repo boundary', () => {
    expect(sourceNamesRepo('https://github.com/other-acme/repo', 'acme/repo')).toBe(false);
  });
});

describe('#1145 — accepts every spelling a source may legitimately hold', () => {
  it.each([
    ['plain https', 'https://github.com/acme/repo'],
    ['https with .git', 'https://github.com/acme/repo.git'],
    ['https with a trailing slash', 'https://github.com/acme/repo/'],
    ['ssh', 'git@github.com:acme/repo'],
    ['ssh with .git', 'git@github.com:acme/repo.git'],
  ])('%s', (_label, source) => {
    expect(sourceNamesRepo(source, 'acme/repo')).toBe(true);
  });

  it('is case-insensitive, as GitHub is', () => {
    // A webhook payload's `full_name` can differ in case from the stored URL.
    expect(sourceNamesRepo('https://github.com/Acme/Repo', 'acme/repo')).toBe(true);
    expect(sourceNamesRepo('https://github.com/acme/repo', 'ACME/REPO')).toBe(true);
  });
});

describe('#1145 — refuses rather than guesses', () => {
  it.each([
    ['null source', null],
    ['undefined source', undefined],
    ['a non-github host', 'https://gitlab.com/acme/repo'],
    ['not a URL at all', 'acme/repo'],
    ['a path-traversal segment', 'https://github.com/../repo'],
  ])('%s yields no slug', (_label, source) => {
    expect(parseSourceSlug(source)).toBeNull();
    expect(sourceNamesRepo(source, 'acme/repo')).toBe(false);
  });

  it('refuses an empty ownerRepo instead of matching everything', () => {
    // A falsy slug reaching a substring match is how "match nothing" becomes
    // "match the first row in the table".
    expect(sourceNamesRepo('https://github.com/acme/repo', '')).toBe(false);
    expect(sourceNamesRepo('https://github.com/acme/repo', null)).toBe(false);
  });
});
