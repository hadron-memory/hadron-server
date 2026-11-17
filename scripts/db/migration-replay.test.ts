/**
 * #434 Slice C: the shrink-only judgement of scripts/db/migration-replay.ts, as pure functions. The database-level red
 * controls (a seeded new object, the stale IF-NOT-EXISTS redefinition, a removed and a stale baseline line, the green
 * unaltered main) are shown on the PR at the exact head and run by the CI job itself.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BASELINE_PATH, differenceEntries, judge, parseBaseline } from './migration-replay.js';

describe('#434 Slice C: the replay baseline is shrink-only', () => {
  const baseline = ['added idx:a', 'changed col:t.c'];

  it('green: exactly the listed differences', () => {
    expect(judge(['added idx:a', 'changed col:t.c'], baseline)).toEqual({ unexpected: [], stale: [] });
  });
  it('red: a difference the baseline does not list is new drift', () => {
    expect(judge(['added idx:a', 'changed col:t.c', 'changed idx:new'], baseline)).toEqual({ unexpected: ['changed idx:new'], stale: [] });
  });
  it('red: a deleted line whose difference is still present is new drift again', () => {
    expect(judge(['added idx:a', 'changed col:t.c'], ['added idx:a'])).toEqual({ unexpected: ['changed col:t.c'], stale: [] });
  });
  it('red: a line whose difference is gone is stale (a fix must delete its line)', () => {
    expect(judge(['added idx:a'], baseline)).toEqual({ unexpected: [], stale: ['changed col:t.c'] });
  });
  it('red: a duplicated line is stale, so repetition cannot hide growth', () => {
    expect(judge(['added idx:a'], ['added idx:a', 'added idx:a']).stale).toEqual(['added idx:a']);
  });
  it('the baseline file parses: comments and blanks skipped, every entry a known kind and unique', () => {
    expect(parseBaseline('# c\n\n added idx:a \n#x\nchanged col:t.c\n')).toEqual(['added idx:a', 'changed col:t.c']);
    const entries = parseBaseline(readFileSync(BASELINE_PATH, 'utf8'));
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) expect(e).toMatch(/^(added|removed|changed|reformatted) (col|con|idx|fn|seq|view|tg):\S+$/);
    expect(new Set(entries).size).toBe(entries.length);
  });
  it('reduces a difference to its identity line and skips the migration engine\'s own table', () => {
    const { entries, details } = differenceEntries([
      'changed idx:x\n  before: A\n  after:  B',
      'added col:_prisma_migrations.checksum',
      'added con:_prisma_migrations._prisma_migrations_pkey',
      'added idx:_prisma_migrations_pkey',
      'added idx:real_one',
    ]);
    expect(entries).toEqual(['added idx:real_one', 'changed idx:x']);
    expect(details.get('changed idx:x')).toContain('before: A');
  });
});
