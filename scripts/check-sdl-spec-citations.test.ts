/**
 * Tests for the #1722 SDL spec-citation gate. Synthetic strings, so a schema
 * edit never turns one red; what they pin is the classifier (the portal gate's
 * own), the added-line check against real `git diff` output, and the ratchet.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addedLines, compareWithBaseline, findBareCitations, onAddedLines, parseBaseline } from './check-sdl-spec-citations.mjs';

describe('#1722 — findBareCitations', () => {
  it('finds a bare citation, at any depth, and its line', () => {
    expect(findBareCitations('a\n  Readers: (cor:agt:050:21).\nx cor:agt:050 and cor:acl:010:01:02')).toEqual([
      { line: 2, citation: 'cor:agt:050:21' },
      { line: 3, citation: 'cor:agt:050' },
      { line: 3, citation: 'cor:acl:010:01:02' },
    ]);
  });

  it('accepts a fully qualified one, and the legacy urn:node: scheme', () => {
    expect(findBareCitations('(hrn:node:hadronmemory.com:specs:cor:agt:050:21) urn:node:x:specs:cor:agt:050:01')).toEqual([]);
  });

  it('a memory slug without hrn:node: is still bare (the token decides, not the character before)', () => {
    expect(findBareCitations('hadronmemory.com:specs:cor:agt:050:21')).toEqual([{ line: 1, citation: 'cor:agt:050:21' }]);
  });

  it('a range cites its head: hrn:node:…:cor:agt:050:14–:17 is clean, the bare form is one finding', () => {
    expect(findBareCitations('(hrn:node:hadronmemory.com:specs:cor:agt:050:14–:17)')).toEqual([]);
    expect(findBareCitations('(cor:agt:050:14–:17)')).toHaveLength(1);
  });

  it('prose with colons is not a citation (three letters, three digits, then pairs)', () => {
    expect(findBareCitations('cor:agents:050 or cor:agt:50:01 or core:agt:050')).toEqual([]);
  });

  it('an identifier that merely starts like a citation is not one; a sentence colon after one is', () => {
    expect(findBareCitations('cor:dmo:060:12abc cor:dmo:060:12-x')).toEqual([]);
    expect(findBareCitations('per cor:api:090: the rule')).toEqual([{ line: 1, citation: 'cor:api:090' }]);
  });
});

describe('#1722 — the baseline ratchet', () => {
  const baseline = parseBaseline('# note\ncor:agt:020:03 2\n\ncor:acl:040:02 1\n');
  const at = (citation: string, line = 1) => ({ citation, line });

  it('within the baseline passes; a qualified old one makes the baseline lowerable', () => {
    expect(compareWithBaseline([at('cor:agt:020:03'), at('cor:agt:020:03')], baseline)).toEqual({
      over: [], lowerable: [{ citation: 'cor:acl:040:02', count: 0, allowed: 1 }],
    });
  });

  it('one more than the baseline fails, and so does a citation with no entry', () => {
    const { over } = compareWithBaseline([at('cor:acl:040:02', 3), at('cor:acl:040:02', 9), at('cor:agt:050:21', 7)], baseline);
    expect(over).toEqual([
      { citation: 'cor:acl:040:02', count: 2, allowed: 1, lines: [3, 9] },
      { citation: 'cor:agt:050:21', count: 1, allowed: 0, lines: [7] },
    ]);
  });

  it('the real SDL is within the real baseline', () => {
    const found = findBareCitations(readFileSync(new URL('../src/api/graphql/schema/typeDefs.ts', import.meta.url), 'utf8'));
    const base = parseBaseline(readFileSync(new URL('./sdl-spec-citations-baseline.txt', import.meta.url), 'utf8'));
    expect(compareWithBaseline(found, base).over).toEqual([]);
  });
});

describe('#1724 — a malformed baseline fails instead of exempting', () => {
  it.each([
    ['a missing count', 'cor:agt:020:03'],
    ['a word for a count', 'cor:agt:020:03 typo'],
    ['Infinity', 'cor:agt:020:03 Infinity'],
    ['a negative count', 'cor:agt:020:03 -1'],
    ['a fraction', 'cor:agt:020:03 1.5'],
    ['an exponent', 'cor:agt:020:03 1e3'],
    ['an extra field', 'cor:agt:020:03 2 3'],
    ['a key that is not a citation', 'cor:agents:020 2'],
    ['a duplicate key', 'cor:agt:020:03 2\ncor:agt:020:03 1'],
  ])('%s', (_, raw) => {
    expect(() => parseBaseline(raw)).toThrow(/malformed baseline/);
  });

  it('reports every problem, with its line', () => {
    expect(() => parseBaseline('# c\ncor:agt:020:03 x\ncor:acl:040:02 NaN')).toThrow(/line 2: .*\n.*line 3: /);
  });
});

describe('#1724 — addedLines reads a --unified=0 diff', () => {
  it('counts added and edited lines in new-file numbering, not removals', () => {
    const diff = [
      'diff --git a/f b/f', '--- a/f', '+++ b/f',
      '@@ -3 +3 @@', '-old', '+new',
      '@@ -10,2 +9,0 @@', '-gone', '-gone',
      '@@ -20,0 +18,2 @@', '+a', '++ starts with a plus',
    ].join('\n');
    expect([...addedLines(diff)]).toEqual([3, 18, 19]);
  });

  it('an empty diff adds nothing', () => {
    expect(addedLines('').size).toBe(0);
  });
});

/**
 * Diego's counterexamples on #1724, through real `git diff` output: the
 * baseline totals pass all three, the portal fails all three, and so must this.
 */
describe('#1724 — the added-line check, against git', () => {
  const LEGACY = ['  """', '  Old prose (cor:agt:020:03).', '  """', '  a: Int', '  """', '  Other (cor:agt:020:03).', '  """', '  b: Int', ''].join('\n');
  const baseline = parseBaseline('cor:agt:020:03 2');

  function check(after: string) {
    const dir = mkdtempSync(join(tmpdir(), 'sdl-cite-'));
    try {
      const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
      g('init', '-q');
      writeFileSync(join(dir, 'f'), LEGACY);
      g('add', 'f');
      g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
      writeFileSync(join(dir, 'f'), after);
      const found = findBareCitations(after);
      return {
        added: onAddedLines(found, addedLines(g('diff', '--unified=0', '--no-color', 'HEAD', '--', 'f'))),
        over: compareWithBaseline(found, baseline).over,
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('untouched legacy citations pass, and so does an edit elsewhere', () => {
    expect(check(LEGACY.replace('a: Int', 'a: String'))).toEqual({ added: [], over: [] });
  });

  it('a prose edit that keeps its citation fails, though the total is unchanged', () => {
    const r = check(LEGACY.replace('Old prose', 'Edited prose'));
    expect(r.over).toEqual([]);
    expect(r.added).toEqual([{ line: 2, citation: 'cor:agt:020:03' }]);
  });

  it('qualifying one old occurrence and adding a new bare one fails, though the total is unchanged', () => {
    const r = check(
      LEGACY.replace('Other (cor:agt:020:03)', 'Other (hrn:node:hadronmemory.com:specs:cor:agt:020:03)') +
        ['  """', '  New (cor:agt:020:03).', '  """', '  c: Int', ''].join('\n'),
    );
    expect(r.over).toEqual([]);
    expect(r.added).toEqual([{ line: 10, citation: 'cor:agt:020:03' }]);
  });

  it('moving a legacy citation to a new field fails, though the total is unchanged', () => {
    const r = check(
      LEGACY.replace('  Other (cor:agt:020:03).', '  Other.') + ['  """', '  Moved (cor:agt:020:03).', '  """', '  c: Int', ''].join('\n'),
    );
    expect(r.over).toEqual([]);
    expect(r.added).toEqual([{ line: 10, citation: 'cor:agt:020:03' }]);
  });

  it('qualifying an added line passes', () => {
    expect(check(LEGACY.replace('Old prose (cor:agt:020:03)', 'Edited (hrn:node:hadronmemory.com:specs:cor:agt:020:03)')).added).toEqual([]);
  });
});

describe('#1724 — the command fails closed', () => {
  it('a base that does not resolve exits 2, never 0', () => {
    const r = spawnSync('node', [new URL('./check-sdl-spec-citations.mjs', import.meta.url).pathname, 'no-such-ref-1724'], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/cannot diff against base "no-such-ref-1724"/);
  });
});
