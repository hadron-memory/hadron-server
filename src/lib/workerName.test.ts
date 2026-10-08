import { describe, expect, it } from 'vitest';
import { findConfusableWorker, workerNameComparisonKeys, workerNameSkeleton } from './workerName.js';
import { workerNames } from '../test/e2eWorkerNames.js';

describe('worker name equivalence (#1677)', () => {
  it.each([
    ['Alice', 'Ａｌｉｃｅ'],
    ['Oscar', 'Оscar'], // Cyrillic O
    ['Mira', 'Μira'], // Greek Mu
    ['Henry', 'Hen\u200Dry'],
    ['José', 'Jose\u0301'],
    ['Straße', 'STRASSE'], // full case folding, not toLowerCase
    ['Office', 'Oﬃce'],
    ['Milo', 'rnilo'], // multi-character prototype
  ])('equates %s with %s', (original, candidate) => {
    expect(findConfusableWorker(candidate, [{ name: original }])).toEqual({ name: original });
  });

  it.each([
    ['mira', 'Μira'], // lowercase Latin vs Greek capital Mu
    ['oscar', 'Оscar'], // lowercase Latin vs Cyrillic capital O
  ])('equates lowercase %s with uppercase lookalike %s in both orders', (latin, lookalike) => {
    expect(findConfusableWorker(lookalike, [{ name: latin }])).toEqual({ name: latin });
    expect(findConfusableWorker(latin, [{ name: lookalike }])).toEqual({ name: lookalike });
  });

  it('documented scope: table and cross-script lookalikes are refused, re-cased I/l pairs are accepted', () => {
    for (const [stored, candidate] of [['mira', 'Μira'], ['Milo', 'rnilo'], ['OTTO', '0TTO'], ['AI', 'Al'], ['Iris', 'lris']]) {
      expect(findConfusableWorker(candidate, [{ name: stored }])).toEqual({ name: stored });
      expect(findConfusableWorker(stored, [{ name: candidate }])).toEqual({ name: candidate });
    }
    // Policy (#1685): colliding only via a re-cased variant (`ai` → `AI` → `Al`) is not a collision.
    for (const [stored, candidate] of [['ai', 'Al'], ['ivy', 'lvy'], ['Ali', 'All'], ['Nil', 'Nii'], ['Bill', 'Biii']]) {
      expect(findConfusableWorker(candidate, [{ name: stored }])).toBeUndefined();
      expect(findConfusableWorker(stored, [{ name: candidate }])).toBeUndefined();
    }
  });

  it('preserves accent differences and does not apply locale-specific Turkic folding', () => {
    expect(workerNameSkeleton('José')).not.toBe(workerNameSkeleton('Jose'));
    expect(workerNameSkeleton('İris')).not.toBe(workerNameSkeleton('Iris'));
    expect(findConfusableWorker('Henry', [{ name: 'Iris' }])).toBeUndefined();
  });

  it('the actual disposable e2e roster has distinct skeletons in each App', () => {
    const names = Object.values(workerNames);
    expect(names.length).toBe(2);
    expect(new Set(names.map(workerNameSkeleton)).size).toBe(names.length);
    for (const name of names) expect(findConfusableWorker(name, names.filter((other) => other !== name).map((name) => ({ name })))).toBeUndefined();
    expect(workerNameComparisonKeys('Μira')).toContain(workerNameSkeleton('Mira'));
  });
});
