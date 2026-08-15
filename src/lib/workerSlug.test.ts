// #991 — worker slug derivation. Unit-level: the pure helpers plus the
// iteration against a stubbed taken-set. The DB-backed race path and the
// migration-backfill parity are covered in resolvers.workerUrn.test.ts.
import { describe, it, expect } from 'vitest';
import {
  workerSlugBase,
  workerSlugCandidate,
  nextFreeWorkerSlug,
  WORKER_SLUG_FALLBACK,
} from './workerSlug.js';
import { MAX_ATOM_LEN } from './urn.js';

/** A `nextFreeWorkerSlug`-shaped db stub over a fixed set of taken slugs. */
function stubDb(taken: string[]) {
  return {
    worker: {
      findMany: async () => taken.map((slug) => ({ slug })),
    },
  } as Parameters<typeof nextFreeWorkerSlug>[0];
}

describe('workerSlugBase', () => {
  it('lowercases and hyphenates a display name', () => {
    expect(workerSlugBase('Iris')).toBe('iris');
    expect(workerSlugBase('Mary Jane')).toBe('mary-jane');
    expect(workerSlugBase('  Hello, World  ')).toBe('hello-world');
  });

  it('collapses the two spellings PR #979 deliberately allows to coexist', () => {
    // The exact case the URN could not key on a name: both are legally
    // castable, and both slugify to one atom — so the iteration, not a
    // refusal, is what keeps their URNs distinct.
    expect(workerSlugBase('Mary Jane')).toBe(workerSlugBase('Mary-Jane'));
  });

  it('falls back rather than throwing when nothing survives slugification', () => {
    // deriveSlugFromName throws `empty-derived-slug` here. A name of only
    // out-of-charset characters is legal (cor:agt:020:02 forbids only blank),
    // so it must stay castable.
    expect(workerSlugBase('!!!')).toBe(WORKER_SLUG_FALLBACK);
    expect(workerSlugBase('。。')).toBe(WORKER_SLUG_FALLBACK);
  });
});

describe('workerSlugCandidate', () => {
  it('is the bare base at n=1 and suffixed thereafter', () => {
    expect(workerSlugCandidate('iris', 1)).toBe('iris');
    expect(workerSlugCandidate('iris', 2)).toBe('iris-2');
    expect(workerSlugCandidate('iris', 10)).toBe('iris-10');
  });

  it('trims the base so a suffixed candidate still fits the atom cap', () => {
    const long = 'a'.repeat(MAX_ATOM_LEN);
    expect(long).toHaveLength(MAX_ATOM_LEN);
    const suffixed = workerSlugCandidate(long, 2);
    // Over-long would compose into a URN the parser rejects — an
    // unaddressable worker rather than a failed cast.
    expect(suffixed.length).toBeLessThanOrEqual(MAX_ATOM_LEN);
    expect(suffixed.endsWith('-2')).toBe(true);
  });

  it('never leaves a trailing punctuation run at the trim boundary', () => {
    const base = `${'a'.repeat(MAX_ATOM_LEN - 3)}--x`;
    const suffixed = workerSlugCandidate(base, 2);
    expect(suffixed).not.toMatch(/[._-]-2$/);
    expect(suffixed.length).toBeLessThanOrEqual(MAX_ATOM_LEN);
  });
});

describe('nextFreeWorkerSlug', () => {
  it('returns the bare base when nothing is taken', async () => {
    expect(await nextFreeWorkerSlug(stubDb([]), 'app1', 'Iris')).toBe('iris');
  });

  it('advances past taken slugs instead of refusing', async () => {
    expect(await nextFreeWorkerSlug(stubDb(['iris']), 'app1', 'Iris')).toBe('iris-2');
    expect(await nextFreeWorkerSlug(stubDb(['iris', 'iris-2']), 'app1', 'Iris')).toBe('iris-3');
  });

  it('fills a gap left by an intermediate slug that was never minted', async () => {
    expect(await nextFreeWorkerSlug(stubDb(['iris', 'iris-3']), 'app1', 'Iris')).toBe('iris-2');
  });

  it('is unaffected by an unrelated slug that merely shares the prefix', async () => {
    // `startsWith` over-matches by design; it may only ever grow the taken set.
    expect(await nextFreeWorkerSlug(stubDb(['iris-team']), 'app1', 'Iris')).toBe('iris');
  });

  it('iterates the fallback base too', async () => {
    expect(await nextFreeWorkerSlug(stubDb(['worker']), 'app1', '!!!')).toBe('worker-2');
  });
});
