/**
 * #4508 pins: the SDL citation gate checks that a QUALIFIED citation names a
 * WRITTEN spec, against a committed snapshot. Synthetic strings and fixtures,
 * so a corpus or schema edit never turns one red; the real-file pins read the
 * committed snapshot and typeDefs.ts only for the properties the issue states.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findQualifiedCitations, missingFromSnapshot, parseSnapshot } from './check-sdl-spec-citations.mjs';
import { buildSnapshot } from './refresh-sdl-spec-citation-snapshot.mjs';

const P = 'hrn:node:hadronmemory.com:specs:';

describe('#4508 — findQualifiedCitations', () => {
  it('returns the citation without its prefix, with its line', () => {
    expect(findQualifiedCitations(`a\n see (${P}cor:agt:130:04).\n`)).toEqual([{ line: 2, citation: 'cor:agt:130:04' }]);
  });
  it('reads the legacy urn:node: scheme and a range by its head AND its tail', () => {
    expect(findQualifiedCitations(`urn:node:hadronmemory.com:specs:cor:agt:050:01 ${P}cor:agt:050:14–:17`)).toEqual([
      { line: 1, citation: 'cor:agt:050:01' },
      { line: 1, citation: 'cor:agt:050:14' },
      { line: 1, citation: 'cor:agt:050:17' },
    ]);
  });
  it('a range whose tail is not written is reported missing', () => {
    const snap = new Set(['cor:agt:050:14']);
    expect(missingFromSnapshot(findQualifiedCitations(`${P}cor:agt:050:14–:17`), snap).map((m) => m.citation)).toEqual(['cor:agt:050:17']);
  });
  it('ignores a bare citation and a qualified one into another memory', () => {
    expect(findQualifiedCitations('cor:agt:130:06 hrn:node:example.org:other:cor:agt:130:06')).toEqual([]);
  });
});

describe('#4508 — parseSnapshot / missingFromSnapshot', () => {
  it('parses citations, ignoring comments and blanks', () => {
    expect(parseSnapshot('# c\n\ncor:agt:130:04\ncor:agt:130:03\n')).toEqual(new Set(['cor:agt:130:04', 'cor:agt:130:03']));
  });
  it.each([
    ['empty inventory', '# only a comment\n'],
    ['not a citation', 'cor:agt\n'],
    ['extra field', 'cor:agt:130:04 2\n'],
    ['duplicate', 'cor:agt:130:04\ncor:agt:130:04\n'],
  ])('refuses a malformed snapshot: %s', (_n, raw) => {
    expect(() => parseSnapshot(raw)).toThrow(/malformed snapshot/);
  });
  it('flags a qualified citation absent from the snapshot, keeping its line', () => {
    const snap = parseSnapshot('cor:agt:130:04\n');
    expect(missingFromSnapshot(findQualifiedCitations(`x\n${P}cor:agt:130:06 ${P}cor:agt:130:04`), snap)).toEqual([
      { line: 2, citation: 'cor:agt:130:06' },
    ]);
  });
});

describe('#4508 — buildSnapshot (the refresh)', () => {
  const list = [
    { citation: 'cor', updatedAt: '2026-01-01T00:00:00Z' },
    { citation: 'cor:agt', updatedAt: '2026-01-01T00:00:00Z' },
    { citation: 'cor:agt:130:04', updatedAt: '2026-11-05T00:00:00Z' },
    { citation: 'cor:xyz:999:01', updatedAt: '2026-11-06T00:00:00Z' },
    { citation: 'cor:agt:130:03', updatedAt: '2026-11-01T00:00:00Z' },
  ];
  it('keeps written rules only: no parents, no placeholders (a reserved citation must fail like a missing one)', () => {
    const text = buildSnapshot(list, { placeholders: [{ citation: 'cor:xyz:999:01' }] }, '2026-11-20');
    expect([...parseSnapshot(text)].sort()).toEqual(['cor:agt:130:03', 'cor:agt:130:04']);
    expect(text).toMatch(/run 2026-11-20; newest node updatedAt 2026-11-06T00:00:00Z; 2 citations; 1 placeholder/);
  });
  it('refuses to build when describe cannot say which are placeholders', () => {
    expect(() => buildSnapshot(list, {}, '2026-11-20')).toThrow(/placeholders/);
    expect(() => buildSnapshot([], { placeholders: [] }, '2026-11-20')).toThrow(/no nodes/);
  });
});

describe('#4508 — the committed gate, end to end', () => {
  const root = join(__dirname, '..');
  const typedefsRel = 'src/api/graphql/schema/typeDefs.ts';
  const MUTANT = `${P}cor:agt:130:06`;

  it('the committed snapshot holds no placeholder and every qualified typeDefs citation resolves', () => {
    const snap = parseSnapshot(readFileSync(join(root, 'scripts/sdl-spec-citations-snapshot.txt'), 'utf8'));
    expect(snap.has('cor:agt:130:04')).toBe(true);
    expect(snap.has('cor:agt:130:06')).toBe(false);
    // cor:spc:020:06 and :11 are the written rules ABOUT placeholders (not placeholders): they belong in the inventory.
    expect(snap.has('cor:spc:020:06') && snap.has('cor:spc:020:11')).toBe(true);
    expect(missingFromSnapshot(findQualifiedCitations(readFileSync(join(root, typedefsRel), 'utf8')), snap)).toEqual([]);
  });

  // Runs the real script and the real committed snapshot and baseline against a COPY of typeDefs.ts in a
  // throwaway git repo, so no other test ever sees an edited schema file.
  it('exits non-zero on the #4442 mutant (cor:agt:130:06) and names it; the clean copy passes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdl4508-'));
    try {
      mkdirSync(join(dir, 'scripts'));
      mkdirSync(join(dir, 'src/api/graphql/schema'), { recursive: true });
      for (const f of ['check-sdl-spec-citations.mjs', 'sdl-spec-citations-baseline.txt', 'sdl-spec-citations-snapshot.txt']) {
        copyFileSync(join(root, 'scripts', f), join(dir, 'scripts', f));
      }
      const copy = join(dir, typedefsRel);
      copyFileSync(join(root, typedefsRel), copy);
      const git = (...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: dir, encoding: 'utf8' });
      git('init', '-q');
      git('add', '-A');
      git('commit', '-qm', 'base');
      const run = () => spawnSync('node', ['scripts/check-sdl-spec-citations.mjs', 'HEAD'], { cwd: dir, encoding: 'utf8' });

      expect(run().status).toBe(0);
      const original = readFileSync(copy);
      writeFileSync(copy, `${original.toString('utf8')}\n// ${MUTANT}\n`);
      const bad = run();
      expect(bad.status).toBe(1);
      expect(bad.stderr).toContain('cor:agt:130:06 names no written spec');
      writeFileSync(copy, original);
      expect(run().status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
