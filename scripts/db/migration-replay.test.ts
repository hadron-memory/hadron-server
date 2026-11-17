/**
 * #434 Slice C: the shrink-only judgement of scripts/db/migration-replay.ts, as pure functions. The database-level red
 * controls (a seeded new object, the stale IF-NOT-EXISTS redefinition, a baselined object changed again, a removed and a
 * stale baseline line, the green unaltered head) run as steps of the Migration Replay workflow itself (#4338 BLIND F4).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BASELINE_PATH, baselineGrowth, differenceEntries, encodeKey, fingerprint, isEngineBookkeeping, judge, parseBaseline } from './migration-replay.js';

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
  it('the baseline file parses: comments and blanks skipped, every entry a known kind, a key and a fingerprint, unique', () => {
    expect(parseBaseline('# c\n\n added idx:a \n#x\nchanged col:t.c\n')).toEqual(['added idx:a', 'changed col:t.c']);
    const entries = parseBaseline(readFileSync(BASELINE_PATH, 'utf8'));
    // An EMPTY baseline is valid once every listed drift is fixed (#4338 BLIND F6). A key may hold spaces (F2).
    for (const e of entries) expect(e).toMatch(/^(added|removed|changed|reformatted) (col|con|idx|fn|seq|view|tg):.+ [0-9a-f]{16}$/);
    expect(new Set(entries).size).toBe(entries.length);
  });
  it('builds entries from both snapshots: kind, key and a fingerprint of both definitions', () => {
    const reference = new Map([['idx:x', 'A'], ['idx:gone', 'G'], ['fn:f(x integer, y text)', 'BEGIN  RETURN 1; END']]);
    const replay = new Map([['idx:x', 'B'], ['idx:real_one', 'R'], ['fn:f(x integer, y text)', 'BEGIN RETURN 1; END']]);
    const { entries, details } = differenceEntries(reference, replay);
    expect(entries).toEqual([
      `added idx:real_one ${fingerprint(undefined, 'R')}`,
      `changed idx:x ${fingerprint('A', 'B')}`,
      `reformatted fn:f(x integer, y text) ${fingerprint('BEGIN  RETURN 1; END', 'BEGIN RETURN 1; END')}`,
      `removed idx:gone ${fingerprint('G', undefined)}`,
    ].sort());
    expect(details.get(`changed idx:x ${fingerprint('A', 'B')}`)).toContain('push + post-push: A');
  });
  it('a key with a newline or tab stays one line (#4338 BLIND F2)', () => {
    expect(encodeKey('col:"we\nird"\t.x\\y')).toBe('col:"we\\nird"\\t.x\\\\y');
    const { entries } = differenceEntries(new Map(), new Map([['col:"a\nb".c', 'text']]));
    expect(entries).toHaveLength(1);
    expect(entries[0]).not.toContain('\n');
  });
  it('skips only the EXACT engine bookkeeping relation and its pkey; a lookalike table is still drift (#4338 BLIND F3)', () => {
    for (const k of ['col:_prisma_migrations.checksum', 'con:_prisma_migrations._prisma_migrations_pkey', 'idx:_prisma_migrations_pkey']) {
      expect(isEngineBookkeeping(k)).toBe(true);
    }
    for (const k of ['col:_prisma_migrations_archive.id', 'idx:_prisma_migrations_archive_pkey', 'con:_prisma_migrations_x.c']) {
      expect(isEngineBookkeeping(k)).toBe(false);
    }
    const { entries } = differenceEntries(new Map(), new Map([['col:_prisma_migrations.id', 'a'], ['col:_prisma_migrations_archive.id', 'b']]));
    expect(entries).toEqual([`added col:_prisma_migrations_archive.id ${fingerprint(undefined, 'b')}`]);
  });
  it('red (#4338 BLIND F1, LOCAL F1): a baselined object that changes AGAIN no longer matches its line', () => {
    const accepted = `changed idx:x ${fingerprint('A', 'B')}`;
    const now = differenceEntries(new Map([['idx:x', 'A']]), new Map([['idx:x', 'C']])).entries;
    expect(judge(now, [accepted])).toEqual({ unexpected: now, stale: [accepted] });
  });
  it('the fingerprint depends on both sides and on their order', () => {
    expect(fingerprint('A', 'B')).not.toBe(fingerprint('B', 'A'));
    expect(fingerprint('A', 'B')).not.toBe(fingerprint('A', 'C'));
    expect(fingerprint(undefined, 'B')).toBe(fingerprint('', 'B'));
  });
  it('growth over the base branch\'s baseline is reported (#4338 BLIND F1); a shrink is not growth', () => {
    expect(baselineGrowth(['a 1', 'b 2', 'c 3'], ['a 1', 'b 2'])).toEqual(['c 3']);
    expect(baselineGrowth(['a 1'], ['a 1', 'b 2'])).toEqual([]);
    expect(baselineGrowth(['a 9'], ['a 1'])).toEqual(['a 9']); // a re-fingerprinted line is growth too
  });
});
